// End-to-end tests against a REAL local TrueForge server, with scripted
// OpenAI-compatible models so no API key is needed.
//
//   1. start TrueForge (see README), 2. npm run build, 3. npm run e2e
//   Optional: FLASK_DIR=<clean pallets/flask 3.1.3 checkout> PY_BIN=<venv Scripts or bin dir>
//
// Everything the VS Code extension does except drawing the webview runs here:
// MCP server, TrueForge sessions/turns/approvals, review, apply, undo, cancel,
// retry and fallback.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { startMcpServer, type RunningMcp } from "../src/core/mcpServer";
import { ProposalStore, type Proposal } from "../src/core/store";
import { buildIndex, type WorkspaceIndex } from "../src/core/context";
import { execCommand, execFileCommand, nodeIO, venvBinDirs } from "../src/core/nodeHost";
import { TurnRunner, type RunnerConfig } from "../src/core/runner";
import { loadAgentDefs, registerMcp, upsertAgents } from "../src/core/setup";
import { tools, type ToolHost } from "../src/core/tools";
import { buildInlineMessage, inlineContextQuery } from "../src/core/inline";
import type { ViewState } from "../src/core/reducer";

const BASE = process.env.TRUEFORGE_URL ?? "http://localhost:8790";
const FLASK = process.env.FLASK_DIR ?? "";
const PY_BIN = process.env.PY_BIN ?? "";
const projectDir = path.resolve(__dirname, "..");
const results: string[] = [];
let failed = 0;
function check(name: string, cond: unknown, detail = ""): void {
  const line = `${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`;
  results.push(line);
  console.log(line);
  if (!cond) failed++;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Policy = (p: Proposal, store: ProposalStore) => void | Promise<void>;
const acceptAll: Policy = (p, s) => s.decideAll(p.id, "accepted");
const rejectAll: Policy = (p, s) => s.decideAll(p.id, "rejected");
const DEFAULTS: RunnerConfig = { trueforgeUrl: BASE, agent: "e2e-good", fallbackAgent: "e2e-fallback", maxRetries: 1, tokenBudget: 6000, stallTimeoutMs: 20000 };

class Env {
  root = "";
  store = new ProposalStore();
  policy: Policy = acceptAll;
  index: WorkspaceIndex | undefined;
  reviews: Proposal[] = [];
  approvals: string[] = [];
  cfg: RunnerConfig = { ...DEFAULTS };
  runner!: TurnRunner;
  host!: ToolHost;
  mcp!: RunningMcp;

  async start(): Promise<void> {
    const review = async (p: Proposal): Promise<void> => {
      this.reviews.push(p);
      await this.policy(p, this.store);
      await this.store.waitForDecision(p.id);
    };
    const getIndex = (): WorkspaceIndex => (this.index ??= buildIndex(this.root));
    const env = this;
    this.host = {
      get root() {
        return env.root;
      },
      io: nodeIO,
      store: this.store,
      getIndex,
      currentTurnId: () => this.runner.currentTurnId(),
      review,
      onContextPlan: (plan, src) => this.runner.showPlan(plan, src),
      tokenBudget: () => this.cfg.tokenBudget,
      exec: (c, cwd, t) => execCommand(c, cwd, t, venvBinDirs(this.root, PY_BIN ? [PY_BIN] : [])),
      execFile: (f, a, cwd, t) => execFileCommand(f, a, cwd, t),
      isCancelled: () => this.runner.isCancelled(),
    };
    this.runner = new TurnRunner(
      () => this.cfg,
      this.store,
      nodeIO,
      getIndex,
      { render: () => undefined, review, approveTool: async (n, d) => (this.approvals.push(`${n}: ${d}`), true) },
      () => this.host,
    );
    this.mcp = await startMcpServer(this.host, { port: 0, token: "e2e-token" });
  }
  use(root: string, policy: Policy = acceptAll, cfg: Partial<RunnerConfig> = {}): void {
    this.root = root;
    this.policy = policy;
    this.index = undefined;
    this.reviews = [];
    this.approvals = [];
    this.cfg = { ...DEFAULTS, ...cfg };
  }
  last(): ViewState {
    return this.runner.getState();
  }
  notices(): string {
    return this.last()
      .items.filter((i) => i.kind === "notice")
      .map((i) => (i as { text: string }).text)
      .join(" | ");
  }
  assistantText(): string {
    return this.last()
      .items.filter((i) => i.kind === "assistant")
      .map((i) => (i as { text: string }).text)
      .join("");
  }
}

function tmpWorkspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-e2e-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
const read = (root: string, rel: string): string | null => (fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), "utf8") : null);
function snapshot(root: string): string {
  const all = (fs.readdirSync(root, { recursive: true }) as string[]).map(String).sort();
  return JSON.stringify(all.map((f) => [f, fs.statSync(path.join(root, f)).isFile() ? fs.readFileSync(path.join(root, f), "utf8") : null]));
}

async function main(): Promise<void> {
  const client = new TrueForge({ baseUrl: BASE });
  try {
    await client.models.list();
  } catch {
    console.error(`TrueForge is not reachable at ${BASE}. Start it first (see README).`);
    process.exit(2);
  }
  const mock = (port: string, key: string): ChildProcess => spawn(process.execPath, [path.join(projectDir, "scripts/mock-model.mjs"), "--port", port, "--key", key], { stdio: "ignore" });
  const mocks = [mock("8811", "key-a"), mock("8812", "key-b")];
  await sleep(800);
  const provider = (name: string, port: number, apiKey: string) =>
    client.settings.modelProviders.createOrUpdate({
      manifest: { type: "custom", name, baseUrl: `http://127.0.0.1:${port}/v1`, auth: { apiKey }, models: [{ name: "scripted", modelId: "scripted-1", properties: { contextLength: 128000, maxOutputTokens: 8000 } }] },
    } as never);
  await provider("e2e-a", 8811, "key-a");
  await provider("e2e-b", 8812, "key-b");
  await provider("e2e-badkey", 8811, "not-the-key");
  await provider("e2e-dead", 9, "x");

  const env = new Env();
  await env.start();
  await registerMcp(client, env.mcp.url, env.mcp.token);
  const primaryDef = loadAgentDefs(projectDir).find((d) => d.name === "ciao-forge")!;
  const mk = (name: string, model: string) => upsertAgents(client, [{ ...primaryDef, name }], { primary: model, fallback: model });
  await mk("e2e-good", "e2e-a/scripted");
  await mk("e2e-fallback", "e2e-b/scripted");
  await mk("e2e-badkey", "e2e-badkey/scripted");
  await mk("e2e-dead", "e2e-dead/scripted");
  const inlineDef = loadAgentDefs(projectDir).find((d) => d.name === "ciao-forge-inline")!;
  const mkInline = (name: string, model: string) => upsertAgents(client, [{ ...inlineDef, name }], { primary: model, fallback: model });
  await mkInline("e2e-good-inline", "e2e-a/scripted");
  await mkInline("e2e-badkey-inline", "e2e-badkey/scripted");
  // "e2e-fallback-inline" is deliberately NOT created: the runner must fall back to the main fallback agent.

  // ---------- 1. MCP server: auth + tool list ----------
  {
    const rpc = (token: string | null, body: unknown) =>
      fetch(env.mcp.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
    const noAuth = await rpc(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    check("MCP rejects requests without the bearer token (401)", noAuth.status === 401, `status ${noAuth.status}`);
    const bad = await rpc("wrong", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    check("MCP rejects a wrong token (401)", bad.status === 401);
    const viaTf = (await client.mcpServers.listTools("ciao-editor")) as unknown as { data: Array<{ name: string; preload?: boolean }> };
    const names = viaTf.data.map((t) => t.name).sort();
    const want = ["propose_edit", "run_command", "read_file", "search_workspace", "gather_context", "find_symbol", "list_files", "explain_history"];
    check("TrueForge lists all 8 editor tools from the MCP server", names.length === 8 && want.every((n) => names.includes(n)), names.join(","));
  }

  const greetFiles = {
    "pkg/greet.py": 'def greet():\n    return "hello"\n',
    "tests/test_greet.py": 'from pkg.greet import greet\n\n\ndef test_greet():\n    assert greet() == "hello"\n',
    "README.md": "# demo\n",
    "pkg/other.py": "X = 1\n",
  };

  // ---------- 2. Agent mode: discovers and edits three files, none named ----------
  {
    const root = tmpWorkspace(greetFiles);
    env.use(root);
    const out = await env.runner.run({ display: "MULTI_FILE_TEST change the greeting message", mode: "agent", fresh: true });
    check("agent run completes", out.status === "done", JSON.stringify(out));
    check("agent edited 3 files it was never told about", new Set(out.appliedPaths).size === 3, out.appliedPaths.join(","));
    check("every edit went through a review before touching disk", env.reviews.length === 3);
    check("files on disk match the accepted proposals", !!read(root, "pkg/greet.py")?.includes("hello, world") && !!read(root, "tests/test_greet.py")?.includes("hello, world") && read(root, "docs/greet.md") !== null);
    const st = env.last();
    check("streamed assistant text reached the UI state", env.assistantText().length > 0);
    check("tool timeline shows gather_context, read_file, propose_edit", ["gather_context", "read_file", "propose_edit"].every((n) => st.items.some((i) => i.kind === "tool" && i.name === n)));
    const ctx = st.items.filter((i) => i.kind === "context");
    check("context plan shown (automatic + agent-requested) with the budget", ctx.length >= 2 && ctx.some((i) => i.kind === "context" && /\/ 6000 tokens/.test(i.summary)), ctx.map((c) => (c.kind === "context" ? c.source : "")).join(","));
    check("TrueForge session id captured for the session view", !!st.sessionId && !!env.runner.sessionUrl(), env.runner.sessionUrl());
    const turns = (await client.sessions.listTurns(st.sessionId!, {})) as unknown as { data: Array<{ id: string }> };
    const types: string[] = [];
    const page = (await client.sessions.listTurnEvents(st.sessionId!, turns.data[0].id, {})) as unknown as AsyncIterable<{ type: string }>;
    for await (const e of page) types.push(e.type);
    const count = (t: string) => types.filter((x) => x === t).length;
    check("TrueForge's own session log has an approval for every edit (approval drives the review)", count("tool.approval_required") >= 3 && count("user.tool_approval") >= 3, `${count("tool.approval_required")} required, ${count("user.tool_approval")} answered`);

    // ---------- 3. Undo ----------
    const u1 = await env.store.undoLast(nodeIO);
    check("undo removes the file the agent created", u1.ok && read(root, "docs/greet.md") === null, u1.message);
    await env.store.undoLast(nodeIO);
    await env.store.undoLast(nodeIO);
    check("undo x3 restores the original files byte for byte", read(root, "pkg/greet.py") === greetFiles["pkg/greet.py"] && read(root, "tests/test_greet.py") === greetFiles["tests/test_greet.py"]);
    const u4 = await env.store.undoLast(nodeIO);
    check("undo with nothing left says so", !u4.ok && /Nothing to undo/.test(u4.message));
  }

  // ---------- 4. Reject everything -> nothing written, agent told ----------
  {
    const root = tmpWorkspace(greetFiles);
    const before = snapshot(root);
    env.use(root, rejectAll);
    const out = await env.runner.run({ display: "MULTI_FILE_TEST change the greeting message", mode: "agent", fresh: true });
    check("rejecting every hunk leaves the workspace byte-identical", snapshot(root) === before, out.status);
    const denied = env.last().items.filter((i) => i.kind === "tool" && i.name === "propose_edit" && i.status === "denied").length;
    check("rejected edits are denied through TrueForge and shown as denied", denied === 3, `${denied} denied`);
  }

  // ---------- 5. Accept one hunk of two ----------
  {
    const original = `${Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    const root = tmpWorkspace({ "f.txt": original });
    env.use(root);
    const abs = path.join(root, "f.txt");
    const proposed = original.replace("line 2\n", "line two\n").replace("line 18\n", "line eighteen\n");
    const p = env.store.create({ key: "k", turnId: "manual", path: "f.txt", abs, original, proposed });
    check("two separate changes become two hunks", p.hunks.length === 2);
    env.store.decide(p.id, 0, "accepted");
    env.store.decide(p.id, 1, "rejected");
    const r = await env.store.apply(p.id, nodeIO);
    const now = read(root, "f.txt") ?? "";
    check("only the accepted hunk is written", r.ok && now.includes("line two") && now.includes("line 18\n") && !now.includes("eighteen"), r.message);
    fs.appendFileSync(abs, "user typed this\n");
    const u = await env.store.undoLast(nodeIO);
    check("undo refuses when the user edited the file afterwards", !u.ok && !!read(root, "f.txt")?.includes("user typed this"), u.message);
  }

  // ---------- 6. Stale file ----------
  {
    const root = tmpWorkspace({ "f.txt": "one\ntwo\n" });
    const abs = path.join(root, "f.txt");
    const p = env.store.create({ key: "k2", turnId: "manual", path: "f.txt", abs, original: "one\ntwo\n", proposed: "ONE\ntwo\n" });
    env.store.decideAll(p.id, "accepted");
    fs.writeFileSync(abs, "one\ntwo\nthree\n");
    const r = await env.store.apply(p.id, nodeIO);
    check("apply refuses a stale proposal instead of overwriting newer content", !r.ok && read(root, "f.txt") === "one\ntwo\nthree\n", r.message);
  }

  // ---------- 7. Streaming + immediate cancellation ----------
  {
    const root = tmpWorkspace({ "a.txt": "alpha\n" });
    const before = snapshot(root);
    env.use(root);
    const run = env.runner.run({ display: "SLOW_STREAM_TEST", mode: "agent", fresh: true, contextBudget: 0 });
    await sleep(1500);
    const mid = env.assistantText();
    check("tokens stream incrementally (partial text visible mid-run)", mid.length > 0 && !mid.includes("token399"), `${mid.trim().split(" ").length} tokens after 1.5 s`);
    const t0 = Date.now();
    await env.runner.cancel();
    const cancelMs = Date.now() - t0;
    const out = await run;
    check("cancel returns immediately", cancelMs < 1500, `${cancelMs} ms`);
    check("run reports cancelled", out.status === "cancelled" && env.last().status === "cancelled");
    const len1 = env.assistantText().length;
    await sleep(800);
    check("no tokens arrive after cancel", len1 === env.assistantText().length);
    check("cancelled run left the workspace unchanged", snapshot(root) === before);
    const sid = env.last().sessionId!;
    await sleep(500);
    const turns = (await client.sessions.listTurns(sid, {})) as unknown as { data: Array<{ state: { status: string } }> };
    check("the TrueForge turn is cancelled server-side too", turns.data[0].state.status === "cancelled", turns.data[0].state.status);
  }

  // ---------- 8. Cancel after an edit was applied ----------
  {
    const root = tmpWorkspace({ "a.txt": "alpha\nbeta\n" });
    const before = snapshot(root);
    env.use(root);
    const run = env.runner.run({ display: "CANCEL_AFTER_EDIT_TEST", mode: "agent", fresh: true, contextBudget: 0 });
    for (let i = 0; i < 100 && read(root, "a.txt") === "alpha\nbeta\n"; i++) await sleep(50);
    check("first edit was applied mid-run", read(root, "a.txt") === "ALPHA\nbeta\n");
    await sleep(400);
    await env.runner.cancel();
    await run;
    check("cancel rolls the applied edit back (no half-applied change)", snapshot(root) === before, env.notices());
  }

  // ---------- 8b. Cancel from TrueForge (not the Stop button) after an edit was applied ----------
  {
    const root = tmpWorkspace({ "a.txt": "alpha\nbeta\n" });
    const before = snapshot(root);
    env.use(root);
    const run = env.runner.run({ display: "CANCEL_AFTER_EDIT_TEST", mode: "agent", fresh: true, contextBudget: 0 });
    for (let i = 0; i < 100 && read(root, "a.txt") === "alpha\nbeta\n"; i++) await sleep(50);
    check("first edit was applied before the server-side cancel", read(root, "a.txt") === "ALPHA\nbeta\n");
    await sleep(400);
    await client.sessions.cancel(env.last().sessionId!, {});
    const out = await run;
    check("a turn cancelled in TrueForge reports cancelled", out.status === "cancelled", out.status);
    check("a turn cancelled in TrueForge rolls the applied edit back", snapshot(root) === before, env.notices());
  }

  // ---------- 9. Cancel while a diff is awaiting review ----------
  {
    const root = tmpWorkspace({ "a.txt": "alpha\nbeta\n" });
    const before = snapshot(root);
    let reviewOpen = false;
    env.use(root, () => {
      reviewOpen = true; // the user never decides
    });
    const run = env.runner.run({ display: "CANCEL_AFTER_EDIT_TEST", mode: "agent", fresh: true, contextBudget: 0 });
    for (let i = 0; i < 100 && !reviewOpen; i++) await sleep(50);
    await env.runner.cancel();
    const out = await run;
    check("cancel during review discards the proposal and writes nothing", out.status === "cancelled" && snapshot(root) === before && env.store.pending().length === 0);
  }

  // ---------- 10. Invalid key on the primary -> automatic fallback ----------
  {
    const root = tmpWorkspace(greetFiles);
    env.use(root, acceptAll, { agent: "e2e-badkey", fallbackAgent: "e2e-fallback" });
    const t0 = Date.now();
    const out = await env.runner.run({ display: "MULTI_FILE_TEST change the greeting message", mode: "agent", fresh: true });
    check("invalid key: the fallback model takes over with no user action", out.status === "done" && out.usedFallback && out.agentUsed === "e2e-fallback", JSON.stringify(out).slice(0, 160));
    const n = env.notices();
    check("the user sees a clear fallback message, no stack trace", /rejected the credentials/.test(n) && /fallback agent/.test(n) && !/\bat \S+ \(/.test(n), n.slice(0, 220));
    check("the fallback finished the task", new Set(out.appliedPaths).size === 3, `${Date.now() - t0} ms`);
  }

  // ---------- 11. Unreachable endpoint -> retry with backoff -> fallback ----------
  {
    const root = tmpWorkspace(greetFiles);
    const before = snapshot(root);
    env.use(root, rejectAll, { agent: "e2e-dead", fallbackAgent: "e2e-fallback", maxRetries: 2 });
    const out = await env.runner.run({ display: "MULTI_FILE_TEST change the greeting message", mode: "agent", fresh: true });
    const n = env.notices();
    check("unreachable endpoint: retried with exponential backoff first", (n.match(/Retrying in/g) ?? []).length === 2 && /0\.4s/.test(n) && /0\.8s/.test(n), n.slice(0, 300));
    check("then fell back automatically", out.usedFallback);
    check("workspace unchanged when the fallback's diff is not accepted", snapshot(root) === before);
  }

  // ---------- 12. Both models fail -> clear error ----------
  {
    const root = tmpWorkspace(greetFiles);
    const before = snapshot(root);
    env.use(root, acceptAll, { agent: "e2e-badkey", fallbackAgent: "e2e-dead", maxRetries: 1 });
    const t0 = Date.now();
    const out = await env.runner.run({ display: "MULTI_FILE_TEST", mode: "agent", fresh: true });
    check("both models down: ends with a clear error", out.status === "error" && /could not be completed/.test(out.error ?? "") && /No files were changed/.test(out.error ?? ""), out.error);
    check("…quickly, without hanging", Date.now() - t0 < 15000, `${Date.now() - t0} ms`);
    check("…and the workspace is untouched", snapshot(root) === before);
    check("the runner is free for the next request", !env.runner.isBusy());
  }

  // ---------- 13. TrueForge down / agent missing ----------
  {
    const root = tmpWorkspace(greetFiles);
    const before = snapshot(root);
    env.use(root, acceptAll, { trueforgeUrl: "http://127.0.0.1:9", fallbackAgent: "" });
    const out = await env.runner.run({ display: "MULTI_FILE_TEST", mode: "agent", fresh: true });
    check("TrueForge unreachable: clear, actionable message", out.status === "error" && /TrueForge is not reachable/.test(out.error ?? ""), out.error);
    check("…workspace untouched", snapshot(root) === before);
    env.use(root, acceptAll, { agent: "no-such-agent", fallbackAgent: "" });
    const out2 = await env.runner.run({ display: "MULTI_FILE_TEST", mode: "agent", fresh: true });
    check("missing agent: tells the user how to set it up", out2.status === "error" && /setup/i.test(out2.error ?? ""), out2.error);
  }

  // ---------- 13b. Model writes the tool call as text: one automatic nudge through TrueForge ----------
  {
    const root = tmpWorkspace({ "a.txt": "alpha\nbeta\n" });
    env.use(root);
    const out = await env.runner.run({ display: "TEXT_TOOL_CALL_TEST", mode: "agent", fresh: true, contextBudget: 0 });
    check("tool call written as text: nudged once in the same session, then applied after review", out.status === "done" && read(root, "a.txt") === "ALPHA\nbeta\n" && /Asking it once more/.test(env.notices()), env.notices().slice(0, 120));
    const turns = (await client.sessions.listTurns(env.last().sessionId!, {})) as unknown as { data: unknown[] };
    check("…the nudge is an ordinary second turn in the same TrueForge session", turns.data.length === 2, `${turns.data.length} turns`);
  }

  // ---------- 13d. Deferred tool loading (TrueForge context engineering) ----------
  {
    const root = tmpWorkspace(greetFiles);
    env.use(root);
    const out = await env.runner.run({ display: "DEFERRED_TOOL_TEST", mode: "agent", fresh: true, contextBudget: 0 });
    const st = env.last();
    const info = st.items.find((i) => i.kind === "tool" && i.name === "get_tool_info");
    const call = st.items.find((i) => i.kind === "tool" && i.name === "call_tool");
    check("deferred tool: schema fetched on demand with get_tool_info", out.status === "done" && info?.kind === "tool" && /Find where a function/.test(info.result ?? ""), (info?.kind === "tool" ? info.result ?? "" : "").replace(/\s+/g, " ").slice(0, 100));
    check("deferred tool: called through TrueForge's call_tool and answered by the editor", call?.kind === "tool" && /pkg\/greet\.py:1/.test(call.result ?? ""), (call?.kind === "tool" ? call.result ?? "" : "").replace(/\s+/g, " ").slice(0, 100));
  }

  // ---------- 13c. Approximate old_text is located, shown, and still reviewed ----------
  {
    const root = tmpWorkspace({ "m.py": 'def f():\n    return bool(val and val.lower() not in {"0", "false", "no"})\n' });
    env.use(root);
    const r = await tools.propose_edit(env.host, { path: "m.py", edits: [{ old_text: "return bool(val and val.lower() not in {'0', 'false', 'no'})", new_text: "return bool(val and val.lower() not in {'0', 'false', 'no', 'off'})" }] });
    check("old_text with the wrong indentation and quote style is still located (and the user is told)", !r.isError && !!read(root, "m.py")?.includes("    return bool(val and val.lower() not in {'0', 'false', 'no', 'off'})") && /quote style/.test(env.reviews[0]?.rationale ?? ""), env.reviews[0]?.rationale);
  }

  // ---------- 14. Tool safety ----------
  {
    const root = tmpWorkspace({ "a.txt": "x\n" });
    env.use(root);
    const esc = await tools.read_file(env.host, { path: "../../etc/passwd" });
    check("read_file refuses paths outside the workspace", esc.isError === true && /escapes the workspace/.test(esc.text));
    const abs = await tools.propose_edit(env.host, { path: path.join(os.tmpdir(), "evil.txt"), new_content: "x" });
    check("propose_edit refuses absolute paths outside the workspace", abs.isError === true);
    const git = await tools.propose_edit(env.host, { path: ".git/config", new_content: "x" });
    check("propose_edit refuses .git", git.isError === true);
    const rm = await tools.run_command(env.host, { command: "rm -rf ." });
    check("run_command refuses non-allowlisted commands", rm.isError === true && /Refused/.test(rm.text));
    const chain = await tools.run_command(env.host, { command: "git status && curl http://x" });
    check("run_command refuses shell chaining", chain.isError === true);
    const ghost = await tools.find_symbol(env.host, { name: "does_not_exist_anywhere" });
    check("find_symbol says plainly when a symbol does not exist", /No definition named/.test(ghost.text));
    const miss = await tools.propose_edit(env.host, { path: "a.txt", edits: [{ old_text: "not in file", new_text: "y" }] });
    check("propose_edit rejects an edit whose old_text is not in the file", miss.isError === true && /not found/.test(miss.text));
  }

  // ---------- 15. The three fixed tasks on Flask 3.1.3 ----------
  if (FLASK && fs.existsSync(path.join(FLASK, "src/flask/helpers.py"))) {
    const git = (args: string): string => execSync(`git ${args}`, { cwd: FLASK, encoding: "utf8" });
    const clean = (): boolean => git("status --porcelain").trim() === "";
    const bins = venvBinDirs(FLASK, PY_BIN ? [PY_BIN] : []);
    const sh = (cmd: string, cwd = FLASK) => execCommand(cmd, cwd, 180000, bins);
    const debugFlag = async (value: string): Promise<string> => {
      process.env.FLASK_DEBUG = value;
      const r = await sh('python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"');
      delete process.env.FLASK_DEBUG;
      return r.output.trim();
    };
    check("flask checkout is 3.1.3 (22d92470) and clean", git("rev-parse HEAD").startsWith("22d92470") && clean(), git("rev-parse --short HEAD").trim());
    const A = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
    const B =
      'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';
    const helpers = fs.readFileSync(path.join(FLASK, "src/flask/helpers.py"), "utf8");
    const startLine = helpers.split("\n").findIndex((l) => l.startsWith("def get_debug_flag")) + 1;
    const req = { path: "src/flask/helpers.py", fullText: helpers, startLine, endLine: startLine + 5, instruction: A };
    const msg = buildInlineMessage(req);
    const inlineOpts = { mode: "inline" as const, fresh: true, contextBudget: 1200, contextQuery: inlineContextQuery(req), contextExclude: [req.path] };
    check("baseline: FLASK_DEBUG=off is True before the change", (await debugFlag("off")) === "True");

    // Task C first: invalid key on the primary, repeat Task A, workspace must stay clean.
    let reviewed: Proposal | undefined;
    let cleanDuringReview = false;
    env.use(
      FLASK,
      (p) => {
        reviewed = p;
        cleanDuringReview = clean();
        env.store.decideAll(p.id, "rejected");
      },
      { agent: "e2e-badkey", fallbackAgent: "e2e-fallback" },
    );
    const c = await env.runner.run({ display: A, message: msg, ...inlineOpts });
    check("Task C: the second model took over automatically and produced the diff", c.usedFallback && reviewed?.path === "src/flask/helpers.py", env.notices().slice(0, 200));
    check("Task C: git status is clean while the diff awaits review (no silent write)", cleanDuringReview);
    check("Task C: git status shows no files changed afterwards", clean());

    // Task A: inline edit, per-hunk review, accept.
    env.use(FLASK, acceptAll);
    const a = await env.runner.run({ display: A, message: msg, ...inlineOpts });
    check("Task A: inline edit produced a reviewed diff for helpers.py only", a.status === "done" && a.appliedPaths.join() === "src/flask/helpers.py", a.appliedPaths.join());
    check("Task A: the diff has separate hunks to accept or reject", (env.reviews[0]?.hunks.length ?? 0) >= 2, `${env.reviews[0]?.hunks.length} hunks`);
    check("Task A verification: FLASK_DEBUG=off prints False", (await debugFlag("off")) === "False");
    check("Task A: 'N' is false too (case-insensitive), 'on' still true", (await debugFlag("N")) === "False" && (await debugFlag("on")) === "True");
    const ua = await env.store.undoLast(nodeIO);
    check("Task A: undo restores helpers.py (git status clean again)", ua.ok && clean(), ua.message);

    // Task B: agent mode, no files named.
    env.use(FLASK, acceptAll);
    const b = await env.runner.run({ display: B, mode: "agent", fresh: true });
    const touched = git("status --porcelain").split("\n").filter(Boolean).map((l) => l.slice(3).trim()).sort();
    check("Task B: completed", b.status === "done", JSON.stringify(b).slice(0, 200));
    check("Task B: the diff touches three files nobody named", touched.join() === "docs/cli.rst,src/flask/cli.py,tests/test_cli.py", touched.join());
    const plan = env.last().items.find((i) => i.kind === "context");
    const rows = plan && plan.kind === "context" ? plan.rows : [];
    const planPaths = rows.map((r) => r.path);
    check("Task B: automatic context chose cli.py, test_cli.py and docs/cli.rst, each with a reason, inside the budget", ["src/flask/cli.py", "tests/test_cli.py", "docs/cli.rst"].every((f) => planPaths.includes(f)) && rows.every((r) => r.reason.length > 0), plan && plan.kind === "context" ? plan.summary : "");
    const hist = env.last().items.find((i) => i.kind === "tool" && i.name === "call_tool");
    check("Task B: explain_history (a deferred tool) returned real commits for cli.py", hist?.kind === "tool" && /Last commits touching src\/flask\/cli\.py/.test(hist.result ?? ""), (hist?.kind === "tool" ? hist.result ?? "" : "").split("\n").slice(1, 2).join(""));
    check("Task B: the agent's pytest run was approval-gated", env.approvals.some((x) => /pytest/.test(x)), env.approvals.join("; "));
    const vb = await sh("python -m pytest tests/test_cli.py -q");
    const lastLine = vb.output.trim().split("\n").at(-1) ?? "";
    check("Task B verification: pytest tests/test_cli.py passes", /passed/.test(lastLine) && !/failed|error/i.test(lastLine), lastLine);
    const help = await sh("python -m flask --help");
    check("Task B verification: config appears in flask --help", /^\s+config\s/m.test(help.output), help.output.split("\n").filter((l) => /^\s+config/.test(l)).join(" / ").trim());
    fs.writeFileSync(path.join(os.tmpdir(), "forge_demo_app.py"), 'from flask import Flask\napp = Flask(__name__)\napp.config.update(SECRET_KEY="s3cr3t", DB_PASSWORD="pw", API_TOKEN="t", PLAIN="visible")\n');
    const cfgOut = await sh("python -m flask --app forge_demo_app config", os.tmpdir());
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(cfgOut.output);
    } catch {
      /* reported by the check below */
    }
    check("Task B verification: flask config prints masked JSON", parsed.SECRET_KEY === "***" && parsed.DB_PASSWORD === "***" && parsed.API_TOKEN === "***" && parsed.PLAIN === "visible" && !cfgOut.output.includes("s3cr3t"), cfgOut.output.replace(/\s+/g, " ").slice(0, 110));
    for (let i = 0; i < 5; i++) await env.store.undoLast(nodeIO);
    check("Task B: undo restores every file (git status clean)", clean(), git("status --porcelain").trim());
  } else {
    results.push("SKIP  Flask fixed tasks (set FLASK_DIR to a clean pallets/flask 3.1.3 checkout)");
    console.log(results.at(-1));
  }

  await env.mcp.close();
  for (const m of mocks) m.kill();
  const summary = `${results.filter((r) => r.startsWith("PASS")).length} passed, ${failed} failed`;
  console.log(`\n${summary}`);
  fs.mkdirSync(path.join(projectDir, "test-e2e"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "test-e2e", "results.txt"), `${results.join("\n")}\n\n${summary}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
