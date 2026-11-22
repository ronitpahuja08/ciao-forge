import { TrueForge, TrueForgeError } from "@truefoundry/trueforge-sdk";
import { planContext, planFiles, renderPlan, type ContextPlan, type WorkspaceIndex } from "./context";
import { checkCommand } from "./guards";
import { findTool, initialState, reduce, type LocalEvent, type ViewState } from "./reducer";
import { classifyFailure, nextStep, type Failure } from "./resilience";
import type { FileIO, Proposal, ProposalStore } from "./store";
import { prepareProposal, type ProposeArgs, type ToolHost } from "./tools";

export interface RunnerConfig {
  trueforgeUrl: string;
  agent: string;
  fallbackAgent: string;
  maxRetries: number;
  tokenBudget: number;
  /** Abort and treat as unreachable if TrueForge sends nothing for this long while a model call is pending. */
  stallTimeoutMs: number;
}

export interface RunnerUI {
  /** Called on every state change. Must be cheap and must not throw. */
  render(state: ViewState): void;
  /** Show a proposal in the editor's diff review; resolves when every hunk is decided or the proposal is discarded. */
  review(p: Proposal): Promise<void>;
  /** Ask the user to approve a command (or another approval-gated tool). */
  approveTool(name: string, detail: string): Promise<boolean>;
}

export interface RunOptions {
  /** Text shown in the transcript (the user's own words). */
  display: string;
  /** Full message sent to the agent; defaults to `display`. */
  message?: string;
  /** Start from a fresh TrueForge session instead of continuing the panel's conversation. */
  fresh?: boolean;
  /** Token budget for automatic context on this turn (0 disables it). */
  contextBudget?: number;
  /** Retrieval query when it should differ from the displayed text (inline edits use the selected identifiers). */
  contextQuery?: string;
  /** Files the message already contains; they are not retrieved again. */
  contextExclude?: string[];
  mode: "agent" | "inline";
}

export interface RunOutcome {
  status: "done" | "error" | "cancelled";
  agentUsed?: string;
  usedFallback: boolean;
  appliedPaths: string[];
  error?: string;
  sessionId?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let localSeq = 0;

/**
 * Drives one user request through TrueForge: creates the session, streams the
 * turn, answers tool approvals with the user's diff review, and handles
 * cancellation, retry and model fallback. All model calls happen inside
 * TrueForge; this class never talks to a model provider.
 */
export class TurnRunner {
  private state: ViewState = initialState();
  private client: TrueForge | undefined;
  private clientUrl = "";
  private sessions = new Map<string, string>(); // agent name -> session id (panel conversation)
  private abort: AbortController | undefined;
  private cancelled = false;
  /** Set when TrueForge itself ended the turn as cancelled (not the Stop button), so run() must roll back. */
  private serverCancelled = false;
  private busy = false;
  private localTurnId = "idle";
  private activeSession: string | undefined;
  private lastEventAt = 0;
  private approvalsInFlight = 0;

  constructor(
    private readonly cfg: () => RunnerConfig,
    private readonly store: ProposalStore,
    private readonly io: FileIO,
    private readonly getIndex: () => WorkspaceIndex,
    private readonly ui: RunnerUI,
    private readonly makeHost: (self: TurnRunner) => ToolHost,
    private readonly log: (m: string) => void = () => {},
  ) {}

  // ---- facts the tool host reads ----
  currentTurnId(): string {
    return this.localTurnId;
  }
  isCancelled(): boolean {
    return this.cancelled;
  }
  isBusy(): boolean {
    return this.busy;
  }
  getState(): ViewState {
    return this.state;
  }
  sessionUrl(): string | undefined {
    const sid = this.state.sessionId ?? this.activeSession;
    return sid ? `${this.cfg().trueforgeUrl.replace(/\/$/, "")}/sessions/${sid}` : undefined;
  }

  getClient(): TrueForge {
    const url = this.cfg().trueforgeUrl;
    if (!this.client || this.clientUrl !== url) {
      this.client = new TrueForge({ baseUrl: url, maxRetries: 0 } as ConstructorParameters<typeof TrueForge>[0]);
      this.clientUrl = url;
    }
    return this.client;
  }

  dispatch(ev: LocalEvent | { type: string; [k: string]: unknown }): void {
    this.state = reduce(this.state, ev as never);
    try {
      this.ui.render(this.state);
    } catch {
      /* rendering must never break a run */
    }
  }
  notice(level: "info" | "warn" | "error" | "ok", text: string): void {
    this.dispatch({ type: "local.notice", level, text });
  }

  /** Forget the conversation and start clean. */
  newChat(): void {
    if (this.busy) return;
    this.sessions.clear();
    this.activeSession = undefined;
    this.dispatch({ type: "local.reset" });
  }

  showPlan(plan: ContextPlan, source: "auto" | "tool"): void {
    const rows = planFiles(plan).map((f) => ({ path: f.path, ranges: f.ranges, tokens: f.tokens, score: f.kind === "mention" ? "pinned" : String(f.score), reason: f.reason }));
    const summary = `${source === "auto" ? "Context selected automatically" : "Context gathered by the agent"}: ${plan.usedTokens} / ${plan.budget} tokens · ${plan.items.length} excerpts from ${rows.length} files · ${plan.indexedFiles} files (~${Math.round(plan.indexedTokens / 1000)}k tokens) in the workspace`;
    this.dispatch({ type: "local.context", item: { source, summary, rows, omitted: [...plan.omitted.map((o) => o.path), ...plan.unknownMentions.map((u) => `unresolved @${u}`)] } });
  }

  /** Stop the current run now: abort the stream, cancel the TrueForge session, roll back this turn's edits. */
  async cancel(): Promise<void> {
    if (!this.busy || this.cancelled) return;
    this.cancelled = true;
    const turn = this.localTurnId;
    const sid = this.activeSession;
    this.abort?.abort();
    this.dispatch({ type: "local.status", status: "cancelled" });
    // Roll back first so the workspace is consistent even if TrueForge is slow to answer.
    await this.rollbackWithNotice(turn, "Stopped.");
    if (sid) {
      try {
        await Promise.race([this.getClient().sessions.cancel(sid, {}), sleep(4000)]);
      } catch (e) {
        this.log(`session cancel failed: ${(e as Error).message}`);
      }
    }
  }

  /** Revert everything a turn applied and discard its unreviewed proposals, then say what happened. */
  private async rollbackWithNotice(turn: string, lead: string): Promise<void> {
    const rb = await this.store.rollbackTurn(turn, this.io);
    const parts: string[] = [lead];
    if (rb.reverted.length) parts.push(`Rolled back ${rb.reverted.length} file(s) changed by this run: ${rb.reverted.join(", ")}.`);
    if (rb.discarded) parts.push(`Discarded ${rb.discarded} unreviewed proposal(s).`);
    if (rb.skipped.length) parts.push(`Left alone because they were edited afterwards: ${rb.skipped.join(", ")}.`);
    if (!rb.reverted.length && !rb.skipped.length) parts.push("No files were changed.");
    this.notice("warn", parts.join(" "));
  }

  async run(opts: RunOptions): Promise<RunOutcome> {
    if (this.busy) return { status: "error", usedFallback: false, appliedPaths: [], error: "A run is already in progress." };
    this.busy = true;
    this.cancelled = false;
    this.serverCancelled = false;
    this.localTurnId = `turn-${Date.now()}-${++localSeq}`;
    const turn = this.localTurnId;
    const cfg = this.cfg();
    if (opts.fresh) {
      this.sessions.clear();
      this.dispatch({ type: "local.reset" });
    }
    this.dispatch({ type: "local.user", text: opts.display });
    this.dispatch({ type: "local.status", status: "running" });

    let message = opts.message ?? opts.display;
    const budget = opts.contextBudget ?? cfg.tokenBudget;
    if (budget > 0) {
      try {
        const plan = planContext(this.getIndex(), opts.contextQuery ?? opts.display, { budget, exclude: opts.contextExclude });
        this.showPlan(plan, "auto");
        if (plan.items.length) message = `${message}\n\n<retrieved_context>\n${renderPlan(plan, true)}\n</retrieved_context>`;
      } catch (e) {
        this.log(`context planning failed: ${(e as Error).message}`);
      }
    }

    // Inline edits use a deliberately minimal agent (one edit tool, loaded up front) when it exists.
    const suffix = opts.mode === "inline" ? "-inline" : "";
    const agents = [cfg.agent, ...(cfg.fallbackAgent && cfg.fallbackAgent !== cfg.agent ? [cfg.fallbackAgent] : [])].map((a) => a + suffix);
    let agentIdx = 0;
    let attempt = 0;
    let nudged = false;
    let continueSession = false;
    let outcome: RunOutcome = { status: "error", usedFallback: false, appliedPaths: [] };
    try {
      for (;;) {
        const agent = agents[agentIdx];
        const result = await this.attempt(agent, message, !continueSession && (agentIdx > 0 || opts.fresh === true));
        continueSession = false;
        if (this.cancelled) {
          // Stop already rolled back in cancel(). A cancel that came from TrueForge (its UI or API)
          // did not, so undo this turn's edits here: a cancelled run never leaves a half-done change.
          if (this.serverCancelled) {
            this.dispatch({ type: "local.status", status: "cancelled" });
            await this.rollbackWithNotice(turn, "The run was cancelled in TrueForge.");
          }
          outcome = { status: "cancelled", agentUsed: agent, usedFallback: agentIdx > 0, appliedPaths: [], sessionId: this.activeSession };
          break;
        }
        if (result.ok && !nudged && this.wroteToolCallAsText()) {
          // Some small models print the tool call as JSON instead of calling the tool. Nothing was
          // applied, so ask once more, through TrueForge, in the same session.
          nudged = true;
          this.notice("info", "The model described a tool call in text instead of making it. Asking it once more to call the tool.");
          message = "Your last reply contained a tool call written as text, so nothing happened and nothing was changed. Make a real tool call now: invoke the tool directly with the same arguments. Do not write JSON or code in your reply.";
          continueSession = true;
          continue;
        }
        if (result.ok) {
          const applied = this.store.turnChanges(turn).map((c) => c.path);
          this.dispatch({ type: "local.status", status: "done" });
          if (nudged && this.wroteToolCallAsText()) {
            this.notice("warn", `The model "${this.state.model ?? agent}" keeps writing tool calls as text instead of making them, so nothing was changed. It probably does not support tool calling; choose another model for this agent in TrueForge.`);
          }
          if (applied.length) this.notice("ok", `Applied after review: ${[...new Set(applied)].join(", ")}. Undo with "cIAo Forge: Undo Last Applied Change" (Ctrl+Alt+Z).`);
          outcome = { status: "done", agentUsed: agent, usedFallback: agentIdx > 0, appliedPaths: applied, sessionId: this.activeSession };
          break;
        }
        const f = result.failure!;
        if (f.kind === "no_agent" && agent.endsWith("-inline")) {
          // The lean inline agent was never created: use the main agent instead.
          agents[agentIdx] = agent.slice(0, -"-inline".length);
          this.log(`inline agent ${agent} missing, using ${agents[agentIdx]}`);
          continue;
        }
        const step = nextStep(f, { attemptOnThisAgent: attempt, maxRetries: cfg.maxRetries, onFallback: agentIdx > 0, hasFallback: agents.length > 1, appliedEdits: this.store.turnChanges(turn).length });
        this.log(`attempt failed on ${agent}: ${f.kind} ${f.reason} -> ${step.action}`);
        if (step.action === "retry") {
          attempt++;
          this.notice("warn", `Model call failed on "${agent}": ${f.reason}. Retrying in ${(step.delayMs / 1000).toFixed(1)}s (attempt ${attempt + 1} of ${cfg.maxRetries + 1})…`);
          await sleep(step.delayMs);
          if (this.cancelled) {
            outcome = { status: "cancelled", agentUsed: agent, usedFallback: agentIdx > 0, appliedPaths: [] };
            break;
          }
          this.sessions.delete(agent);
          continue;
        }
        if (step.action === "fallback") {
          agentIdx++;
          attempt = 0;
          this.notice("warn", `Primary agent "${agent}" failed: ${f.reason}. Switching automatically to the fallback agent "${agents[agentIdx]}" (second configured model). No files were changed.`);
          continue;
        }
        // Give up: make sure nothing half-done is left behind, then say so plainly.
        const rb = await this.store.rollbackTurn(turn, this.io);
        this.dispatch({ type: "local.status", status: "error" });
        const tail = rb.reverted.length ? ` Rolled back ${rb.reverted.join(", ")}.` : " No files were changed.";
        const text = f.kind === "harness_down" ? `${f.reason}${tail}` : `The request could not be completed: ${f.reason}.${tail}`;
        this.notice("error", text);
        outcome = { status: "error", agentUsed: agent, usedFallback: agentIdx > 0, appliedPaths: [], error: text, sessionId: this.activeSession };
        break;
      }
    } finally {
      this.busy = false;
      this.abort = undefined;
    }
    return outcome;
  }

  private async attempt(agent: string, message: string, freshSession: boolean): Promise<{ ok: boolean; failure?: Failure }> {
    const client = this.getClient();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    let stall: ReturnType<typeof setInterval> | undefined;
    let stalled = false;
    try {
      let sid = freshSession ? undefined : this.sessions.get(agent);
      if (!sid) {
        const created = (await client.sessions.create({ agent: { name: agent }, metadata: { client: "ciao-forge-vscode" } }, { abortSignal: signal })) as unknown as { data?: { id: string }; id?: string };
        sid = created.data?.id ?? created.id;
        if (!sid) throw new Error("TrueForge did not return a session id");
        this.sessions.set(agent, sid);
      }
      this.activeSession = sid;
      this.dispatch({ type: "local.session", sessionId: sid, agent });
      const stream = await client.sessions.createTurnStream(sid, { input: [{ type: "user.message", content: message }] }, { abortSignal: signal });
      let turnId = "";
      let terminal: { status: string; message?: string } | undefined;
      this.lastEventAt = Date.now();
      const stallMs = this.cfg().stallTimeoutMs;
      stall = setInterval(() => {
        // Waiting on the human (review/approval) or on a tool is not a stall.
        if (this.approvalsInFlight > 0 || this.state.status === "awaiting_approval") {
          this.lastEventAt = Date.now();
          return;
        }
        if (this.state.items.some((x) => x.kind === "tool" && x.status === "running")) {
          this.lastEventAt = Date.now();
          return;
        }
        if (Date.now() - this.lastEventAt > stallMs) {
          stalled = true;
          this.abort?.abort();
        }
      }, 1000);
      for await (const ev of stream) {
        if (this.cancelled) break;
        this.lastEventAt = Date.now();
        const e = ev as unknown as { type: string; [k: string]: unknown };
        this.dispatch(e);
        if (e.type === "turn.created") turnId = String(e.turnId ?? "");
        else if (e.type === "tool.approval_required") void this.handleApprovals(sid, turnId, e as never);
        else if (e.type === "turn.done") {
          terminal = e.state as { status: string; message?: string };
          break;
        }
      }
      if (this.cancelled) return { ok: false };
      if (!terminal) return { ok: false, failure: classifyFailure({ message: "the stream from TrueForge ended before the turn finished" }) };
      if (terminal.status === "done") return { ok: true };
      if (terminal.status === "cancelled") {
        this.cancelled = true;
        this.serverCancelled = true;
        return { ok: false };
      }
      const msg = String(terminal.message ?? "turn failed");
      if (/iteration limit/i.test(msg)) return { ok: false, failure: { kind: "bad_request", reason: "the agent hit its iteration limit before finishing", retryable: false, fallbackable: false } };
      if (/^\[MCP Error\]/i.test(msg)) {
        const detail = msg.replace(/^\[MCP Error\]\s*/i, "").slice(0, 160);
        return { ok: false, failure: { kind: "tools_unreachable", reason: `TrueForge could not reach the editor's tool server (${detail}). Start TrueForge with OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' and run "cIAo Forge: Reconnect to TrueForge"`, retryable: false, fallbackable: false } };
      }
      return { ok: false, failure: classifyFailure({ message: msg.replace(/^\[Model Error\]\s*/i, "") }) };
    } catch (e) {
      if (this.cancelled) return { ok: false };
      if (stalled) {
        try {
          if (this.activeSession) await Promise.race([client.sessions.cancel(this.activeSession, {}), sleep(2000)]);
        } catch {
          /* best effort */
        }
        return { ok: false, failure: classifyFailure({ message: `timed out: no response for ${Math.round(this.cfg().stallTimeoutMs / 1000)}s` }) };
      }
      const err = e as { statusCode?: number; message?: string; body?: { error?: { message?: string } } };
      const bodyMsg = err.body?.error?.message;
      if (e instanceof TrueForgeError && err.statusCode === undefined) {
        return { ok: false, failure: classifyFailure({ harnessUnreachable: true }) };
      }
      if (err.statusCode === 404 || (err.statusCode === 422 && /agent/i.test(bodyMsg ?? ""))) {
        return { ok: false, failure: { kind: "no_agent", reason: `TrueForge has no agent named "${agent}" (${bodyMsg ?? "not found"}). Run \`node scripts/setup-trueforge.mjs\` to create it`, retryable: false, fallbackable: true } };
      }
      return { ok: false, failure: classifyFailure({ message: bodyMsg ?? err.message ?? String(e), status: err.statusCode }) };
    } finally {
      if (stall) clearInterval(stall);
    }
  }

  /** True when the turn made no tool call at all but the reply contains one spelled out as JSON. */
  private wroteToolCallAsText(): boolean {
    const lastUser = this.state.items.map((i) => i.kind).lastIndexOf("user");
    const since = this.state.items.slice(lastUser + 1);
    if (since.some((i) => i.kind === "tool")) return false;
    const text = since.map((i) => (i.kind === "assistant" ? i.text : "")).join("\n");
    return /"name"\s*:\s*"(propose_edit|read_file|search_workspace|gather_context|run_command|find_symbol|list_files|explain_history|call_tool)"/.test(text) || /<tool_call>/.test(text);
  }

  /** Answer TrueForge's approval request. For propose_edit the answer IS the user's diff review. */
  private async handleApprovals(sessionId: string, turnId: string, ev: { threadId: string; toolCalls: Array<{ id: string }> }): Promise<void> {
    this.approvalsInFlight++;
    try {
      const host = this.makeHost(this);
      for (const ref of ev.toolCalls ?? []) {
        if (this.cancelled) return;
        const tool = findTool(this.state, ref.id);
        const name = tool?.name ?? "tool";
        let args: Record<string, unknown> = {};
        try {
          args = tool?.args ? JSON.parse(tool.args) : {};
        } catch {
          /* malformed arguments: let the tool report it */
        }
        let allow = true;
        let reason = "";
        if (name === "propose_edit") {
          const prep = await prepareProposal(host, args as unknown as ProposeArgs);
          if (prep.proposal) {
            const p = prep.proposal;
            await this.ui.review(p);
            if (this.cancelled || p.status === "discarded") return;
            if (this.store.acceptedIds(p).length === 0) {
              allow = false;
              p.status = "rejected";
              reason = `The user reviewed the diff for ${p.path} and rejected every hunk. Do not propose the same change again; ask what they want instead.`;
            }
          }
          // prep.error / noChange: approve so the tool itself returns the precise message to the agent.
        } else if (name === "run_command") {
          const command = String(args.command ?? "");
          if (checkCommand(command).ok) {
            allow = await this.ui.approveTool(name, command);
            if (!allow) reason = "The user declined to run this command.";
          }
        } else {
          allow = await this.ui.approveTool(name, tool?.args ?? "");
          if (!allow) reason = "The user declined this tool call.";
        }
        if (this.cancelled) return;
        await this.getClient().sessions.createTurnEvents(sessionId, turnId, {
          events: [{ type: "user.tool_approval", threadId: ev.threadId, toolCallId: ref.id, approval: allow ? { status: "allow" } : { status: "deny", reason } }],
        });
        this.dispatch({ type: "user.tool_approval", toolCallId: ref.id, approval: { status: allow ? "allow" : "deny" } });
      }
    } catch (e) {
      if (!this.cancelled) {
        this.log(`approval handling failed: ${(e as Error).message}`);
        this.notice("error", `Could not send the approval to TrueForge: ${(e as Error).message}`);
      }
    } finally {
      this.approvalsInFlight--;
      this.lastEventAt = Date.now();
    }
  }
}
