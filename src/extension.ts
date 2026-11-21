import * as path from "node:path";
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { buildIndex, inSkippedDir, type WorkspaceIndex } from "./core/context";
import { START_HINT } from "./core/resilience";
import { buildInlineMessage, inlineContextQuery } from "./core/inline";
import { MCP_SERVER_NAME, startMcpServer, type RunningMcp } from "./core/mcpServer";
import { execCommand, execFileCommand, venvBinDirs } from "./core/nodeHost";
import { TurnRunner } from "./core/runner";
import { listModelNames, loadAgentDefs, registerMcp, upsertAgents } from "./core/setup";
import { ProposalStore } from "./core/store";
import type { ToolHost } from "./core/tools";
import { AgentPanel } from "./ui/panel";
import { ReviewController } from "./ui/review";
import { pythonBinDir, readConfig, vscodeIO, workspaceRoot } from "./vscodeHost";

export interface ForgeApi {
  runner: TurnRunner;
  store: ProposalStore;
  review: ReviewController;
  mcp(): RunningMcp | undefined;
  /** Resolves once the MCP server is listening and registered with TrueForge (or registration failed). */
  ready: Promise<void>;
}

export async function activate(ctx: vscode.ExtensionContext): Promise<ForgeApi> {
  const out = vscode.window.createOutputChannel("cIAo Forge");
  const log = (m: string) => out.appendLine(`${new Date().toISOString().slice(11, 19)} ${m}`);
  const store = new ProposalStore();
  const review = new ReviewController(ctx, store, vscodeIO);
  let index: WorkspaceIndex | undefined;
  let mcp: RunningMcp | undefined;

  const getIndex = (): WorkspaceIndex => {
    const root = workspaceRoot();
    if (!root) throw new Error("Open a folder first.");
    if (!index || index.root !== root) {
      const t0 = Date.now();
      index = buildIndex(root);
      log(`indexed ${index.files.length} files, ${index.chunks.length} chunks, ~${index.totalTokens} tokens in ${Date.now() - t0} ms`);
    }
    return index;
  };
  const invalidate = () => (index = undefined);
  // Files that are never indexed (pytest and Python caches, virtualenvs, build output) must not
  // force a rebuild: a test run creates hundreds of them.
  const invalidateFor = (uri: vscode.Uri) => {
    const root = workspaceRoot();
    if (!root) return;
    const rel = path.relative(root, uri.fsPath).split(path.sep).join("/");
    if (!rel.startsWith("..") && !inSkippedDir(rel)) invalidate();
  };
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  ctx.subscriptions.push(watcher, watcher.onDidCreate(invalidateFor), watcher.onDidDelete(invalidateFor), vscode.workspace.onDidSaveTextDocument((d) => invalidateFor(d.uri)), vscode.workspace.onDidChangeWorkspaceFolders(invalidate));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.text = "$(sparkle) cIAo Forge";
  status.command = "ciaoForge.agent.focus";
  status.show();
  ctx.subscriptions.push(status, out);

  // eslint-disable-next-line prefer-const
  let runner: TurnRunner;
  const panel = new AgentPanel(ctx, {
    send: (text) => void startRun(text),
    stop: () => void stop(),
    newChat: () => runner.newChat(),
    openSession: () => void vscode.commands.executeCommand("ciaoForge.openSession"),
    review: () => void review.show(),
    undo: () => void review.undo(),
    suggest: (prefix) => {
      try {
        const ix = getIndex();
        const p = prefix.toLowerCase();
        const files = ix.files.filter((f) => f.toLowerCase().includes(p)).sort((a, b) => a.length - b.length).slice(0, 6).map((f) => ({ label: path.basename(f), detail: f, insert: f }));
        const syms = [...ix.symbols.entries()].filter(([s]) => p.length > 0 && s.toLowerCase().includes(p)).sort((a, b) => a[0].length - b[0].length).slice(0, 6).map(([s, d]) => ({ label: s, detail: `symbol · ${d[0].path}:${d[0].line}`, insert: s }));
        return [...files, ...syms].slice(0, 10);
      } catch {
        return [];
      }
    },
  });

  const host: ToolHost = {
    get root() {
      const r = workspaceRoot();
      if (!r) throw new Error("No folder is open in VS Code.");
      return r;
    },
    io: vscodeIO,
    store,
    getIndex,
    currentTurnId: () => runner.currentTurnId(),
    review: (p) => review.review(p),
    onContextPlan: (plan, source) => runner.showPlan(plan, source),
    tokenBudget: () => readConfig().tokenBudget,
    exec: (command, cwd, timeoutMs) => execCommand(command, cwd, timeoutMs, [...readConfig().commandPath, ...pythonBinDir(), ...venvBinDirs(cwd)]),
    execFile: (file, args, cwd, timeoutMs) => execFileCommand(file, args, cwd, timeoutMs),
    isCancelled: () => runner.isCancelled(),
    editScope: () => runner.editScope(),
    log,
  };

  runner = new TurnRunner(
    () => readConfig(),
    store,
    vscodeIO,
    getIndex,
    {
      render: (s) => {
        panel.render(s);
        const busy = s.status === "running" || s.status === "awaiting_approval";
        status.text = busy ? "$(loading~spin) cIAo Forge: working (click to open, Ctrl+Shift+Esc to stop)" : "$(sparkle) cIAo Forge";
        void vscode.commands.executeCommand("setContext", "ciaoForge.running", busy);
      },
      review: (p) => review.review(p),
      approveTool: (name, detail) => panel.approveTool(name, detail),
    },
    () => host,
    log,
  );
  ctx.subscriptions.push({ dispose: store.onChange(() => panel.setPendingReviews(store.awaiting().length)) });
  // The agent's session still believes an undone edit is in place; tell it on its next turn.
  review.onUndone = (p) => runner.noteForAgent(`The user undid your change to ${p}; that file is back to its content from before your edit. Read it again before editing it.`);

  async function stop(): Promise<void> {
    panel.denyAll();
    await runner.cancel();
  }

  async function startRun(text: string): Promise<void> {
    if (!workspaceRoot()) {
      void vscode.window.showWarningMessage("cIAo Forge: open a folder first.");
      return;
    }
    if (runner.isBusy()) {
      void vscode.window.showInformationMessage("cIAo Forge is already working. Stop the current run first.");
      return;
    }
    await ensureRegistered();
    await runner.run({ display: text, mode: "agent" });
  }

  // ---- MCP server + TrueForge registration (never blocks activation) ----
  const ready = (async () => {
    try {
      let token = await ctx.secrets.get("ciaoForge.mcpToken");
      if (!token) {
        token = randomBytes(24).toString("hex");
        await ctx.secrets.store("ciaoForge.mcpToken", token);
      }
      mcp = await startMcpServer(host, { port: readConfig().mcpPort, token });
      ctx.subscriptions.push({ dispose: () => void mcp?.close() });
      log(`MCP server listening on ${mcp.url}`);
      await connect(false);
    } catch (e) {
      log(`startup failed: ${(e as Error).message}`);
      panel.setHealth(`cIAo Forge could not start its tool server: ${(e as Error).message}`);
    }
  })();

  /**
   * Point TrueForge's "ciao-editor" connector at this window's tool server before every run.
   * Another window or a test run may have re-registered it to a port that no longer exists.
   * Failures are left to the run itself, which reports an unreachable TrueForge clearly.
   */
  async function ensureRegistered(): Promise<void> {
    await ready;
    if (!mcp) return;
    try {
      await registerMcp(runner.getClient(), mcp.url, mcp.token);
    } catch (e) {
      log(`re-registering the MCP server before the run failed: ${(e as Error).message}`);
    }
  }

  async function connect(interactive: boolean): Promise<boolean> {
    if (!mcp) return false;
    try {
      const client = runner.getClient();
      await registerMcp(client, mcp.url, mcp.token);
      const cfg = readConfig();
      const agents: string[] = [];
      for await (const a of (await client.agents.list({})) as unknown as AsyncIterable<{ name: string }>) agents.push(a.name);
      if (!agents.includes(cfg.agent)) {
        panel.setHealth(`Connected to TrueForge, but the agent "${cfg.agent}" does not exist yet. Run "cIAo Forge: Set Up TrueForge Agents".`);
      } else {
        panel.setHealth("");
      }
      log(`registered MCP server "${MCP_SERVER_NAME}" with TrueForge at ${cfg.trueforgeUrl}; agents: ${agents.join(", ") || "(none)"}`);
      if (interactive) void vscode.window.showInformationMessage(`cIAo Forge is connected to TrueForge at ${cfg.trueforgeUrl}.`);
      return true;
    } catch (e) {
      const url = readConfig().trueforgeUrl;
      log(`TrueForge not reachable at ${url}: ${(e as Error).message}`);
      panel.setHealth(`TrueForge is not reachable at ${url}. Start it with: ${START_HINT}, then run "cIAo Forge: Reconnect to TrueForge".`);
      return false;
    }
  }

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("ciaoForge.agent", panel, { webviewOptions: { retainContextWhenHidden: true } }),

    vscode.commands.registerCommand("ciaoForge.inlineEdit", async (preset?: { instruction?: string }) => {
      const ed = vscode.window.activeTextEditor;
      const root = workspaceRoot();
      if (!ed || !root || ed.document.uri.scheme !== "file") {
        void vscode.window.showWarningMessage("cIAo Forge: open a file from the workspace and select the code to change.");
        return;
      }
      if (runner.isBusy()) {
        void vscode.window.showInformationMessage("cIAo Forge is already working. Stop the current run first.");
        return;
      }
      const rel = path.relative(root, ed.document.uri.fsPath).split(path.sep).join("/");
      if (rel.startsWith("..")) {
        void vscode.window.showWarningMessage("cIAo Forge: the file is outside the workspace folder.");
        return;
      }
      let sel = ed.selection;
      if (sel.isEmpty) sel = new vscode.Selection(sel.active.line, 0, sel.active.line, ed.document.lineAt(sel.active.line).text.length);
      const startLine = sel.start.line + 1;
      const endLine = (sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line) + 1;
      const instruction = preset?.instruction ?? (await vscode.window.showInputBox({ title: `cIAo Forge: edit ${path.basename(rel)} lines ${startLine}-${endLine}`, prompt: "Describe the change in plain language", placeHolder: "e.g. treat 'off' as false and update the docstring", ignoreFocusOut: true }));
      if (!instruction?.trim()) return;
      if (ed.document.isDirty) await ed.document.save();
      const req = { path: rel, fullText: ed.document.getText(), startLine, endLine, instruction: instruction.trim() };
      const message = buildInlineMessage(req);
      const cfg = readConfig();
      await ensureRegistered();
      void vscode.commands.executeCommand("ciaoForge.agent.focus");
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "cIAo Forge: preparing the edit…", cancellable: true }, async (_p, tokenCancel) => {
        tokenCancel.onCancellationRequested(() => void stop());
        // The notification closes as soon as the diff is ready for review.
        const run = runner.run({ display: `Inline edit ${rel}:${startLine}-${endLine} — ${instruction.trim()}`, message, mode: "inline", isolated: true, editScope: rel, inlineSelection: { path: rel, text: req.fullText.split(/\r?\n/).slice(startLine - 1, endLine).join("\n") }, contextBudget: Math.min(1200, cfg.tokenBudget), contextQuery: inlineContextQuery(req), contextExclude: [rel] });
        const firstProposal = new Promise<void>((resolve) => {
          const off = store.onChange(() => {
            if (store.awaiting().length) {
              off();
              resolve();
            }
          });
          void run.finally(() => {
            off();
            resolve();
          });
        });
        await firstProposal;
      });
    }),

    vscode.commands.registerCommand("ciaoForge.stop", () => stop()),
    vscode.commands.registerCommand("ciaoForge.newChat", () => runner.newChat()),
    vscode.commands.registerCommand("ciaoForge.undoLastApply", () => review.undo()),
    vscode.commands.registerCommand("ciaoForge.reviewProposals", (id?: string) => review.show(typeof id === "string" ? id : undefined)),
    vscode.commands.registerCommand("ciaoForge.acceptHunk", (id: string, hunk: number) => store.decide(id, hunk, "accepted")),
    vscode.commands.registerCommand("ciaoForge.rejectHunk", (id: string, hunk: number) => store.decide(id, hunk, "rejected")),
    vscode.commands.registerCommand("ciaoForge.acceptAll", () => store.awaiting().forEach((p) => store.decideAll(p.id, "accepted"))),
    vscode.commands.registerCommand("ciaoForge.rejectAll", () => store.awaiting().forEach((p) => store.decideAll(p.id, "rejected"))),
    vscode.commands.registerCommand("ciaoForge.reconnect", () => connect(true)),
    vscode.commands.registerCommand("ciaoForge.openSession", async () => {
      const url = runner.sessionUrl();
      if (!url) {
        void vscode.window.showInformationMessage("cIAo Forge: no TrueForge session yet. Send a request first.");
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand("ciaoForge.showMcpInfo", () => {
      const cfg = readConfig();
      void vscode.window.showInformationMessage(mcp ? `cIAo Forge MCP server "${MCP_SERVER_NAME}" is at ${mcp.url}, registered with TrueForge at ${cfg.trueforgeUrl}.` : "cIAo Forge MCP server is not running.");
    }),
    vscode.commands.registerCommand("ciaoForge.setup", async (preset?: { primary?: string; fallback?: string }) => {
      try {
        const client = runner.getClient();
        const models = await listModelNames(client);
        if (models.length === 0) {
          void vscode.window.showWarningMessage("cIAo Forge: TrueForge has no models yet. Add a model provider in the TrueForge UI (Settings → Models), then run this again.");
          return;
        }
        const primary = preset?.primary ?? (await vscode.window.showQuickPick(models, { title: "Primary model for the cIAo Forge agent", ignoreFocusOut: true }));
        if (!primary) return;
        const fallback = preset?.fallback ?? (await vscode.window.showQuickPick([...models.filter((m) => m !== primary), primary], { title: "Fallback model (used automatically if the primary fails)", ignoreFocusOut: true }));
        if (!fallback) return;
        const done = await upsertAgents(client, loadAgentDefs(ctx.extensionPath), { primary, fallback });
        await connect(false);
        void vscode.window.showInformationMessage(`cIAo Forge agents ready: ${done.join("; ")}`);
      } catch (e) {
        void vscode.window.showErrorMessage(`cIAo Forge setup failed: ${(e as Error).message}. Is TrueForge running at ${readConfig().trueforgeUrl}?`);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ciaoForge.trueforgeUrl")) void connect(false);
    }),
  );

  return { runner, store, review, mcp: () => mcp, ready };
}

export function deactivate(): void {
  /* subscriptions dispose the MCP server */
}
