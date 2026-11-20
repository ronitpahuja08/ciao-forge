// Headless rehearsal of the fixed tasks with whatever REAL models your TrueForge agents use.
// Same code path as the extension (TrueForge session -> MCP tools -> approval -> review -> apply),
// with every hunk auto-accepted, so you can check a model before recording.
//
//   npm run rehearse -- --task A --repo /path/to/flask [--bin /path/to/venv/bin]
//   npm run rehearse -- --task B --repo /path/to/flask
//   add --keep to leave the changes in place (default: undo everything at the end)
import * as fs from "node:fs";
import * as path from "node:path";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { buildIndex, type WorkspaceIndex } from "../src/core/context";
import { buildInlineMessage, inlineContextQuery } from "../src/core/inline";
import { startMcpServer } from "../src/core/mcpServer";
import { execCommand, execFileCommand, nodeIO, venvBinDirs } from "../src/core/nodeHost";
import { TurnRunner, type RunnerConfig } from "../src/core/runner";
import { registerMcp } from "../src/core/setup";
import { ProposalStore, type Proposal } from "../src/core/store";
import type { ToolHost } from "../src/core/tools";

const arg = (name: string, dflt = ""): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? "") : dflt;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const TASK_A = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const TASK_B =
  'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

async function main(): Promise<void> {
  const task = arg("task", "A").toUpperCase();
  const repo = path.resolve(arg("repo", process.cwd()));
  const cfg: RunnerConfig = {
    trueforgeUrl: arg("url", process.env.TRUEFORGE_URL ?? "http://localhost:8790"),
    agent: arg("agent", "ciao-forge"),
    fallbackAgent: arg("fallback-agent", "ciao-forge-fallback"),
    maxRetries: 1,
    tokenBudget: Number(arg("budget", "6000")),
    stallTimeoutMs: Number(arg("stall", "180")) * 1000,
  };
  const bins = venvBinDirs(repo, arg("bin") ? [arg("bin")] : []);
  const store = new ProposalStore();
  let index: WorkspaceIndex | undefined;
  const getIndex = (): WorkspaceIndex => (index ??= buildIndex(repo));
  const review = async (p: Proposal): Promise<void> => {
    console.log(`\n--- diff for review: ${p.path} (${p.hunks.length} hunk(s))${p.rationale ? ` — ${p.rationale}` : ""}`);
    for (const h of p.hunks) {
      console.log(`@@ line ${h.origStart + 1} -${h.removed.length} +${h.added.length}`);
      for (const l of h.removed) console.log(`- ${l}`);
      for (const l of h.added) console.log(`+ ${l}`);
    }
    store.decideAll(p.id, "accepted");
  };
  let printed = 0;
  // eslint-disable-next-line prefer-const
  let runner: TurnRunner;
  const host: ToolHost = {
    root: repo,
    io: nodeIO,
    store,
    getIndex,
    currentTurnId: () => runner.currentTurnId(),
    review,
    onContextPlan: (plan, src) => runner.showPlan(plan, src),
    tokenBudget: () => cfg.tokenBudget,
    exec: (c, cwd, t) => execCommand(c, cwd, t, bins),
    execFile: (f, a, cwd, t) => execFileCommand(f, a, cwd, t),
    isCancelled: () => runner.isCancelled(),
  };
  runner = new TurnRunner(
    () => cfg,
    store,
    nodeIO,
    getIndex,
    {
      render: (s) => {
        for (; printed < s.items.length - 1; printed++) show(s.items[printed]);
      },
      review,
      approveTool: async (name, detail) => (console.log(`[approve ${name}] ${detail}`), true),
    },
    () => host,
    (m) => has("verbose") && console.log(`[log] ${m}`),
  );
  function show(it: (typeof runner extends TurnRunner ? ReturnType<TurnRunner["getState"]> : never)["items"][number]): void {
    if (it.kind === "assistant") console.log(`\nassistant: ${it.text.trim()}`);
    else if (it.kind === "tool") console.log(`tool ${it.name}(${it.args.replace(/\s+/g, " ").slice(0, 160)}) -> [${it.status}] ${(it.result ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
    else if (it.kind === "notice") console.log(`[${it.level}] ${it.text}`);
    else if (it.kind === "context") console.log(`[context] ${it.summary}\n${it.rows.map((r) => `   ${r.path} (${r.ranges}) ${r.tokens} tok — ${r.reason}`).join("\n")}`);
  }

  const client = new TrueForge({ baseUrl: cfg.trueforgeUrl });
  const mcp = await startMcpServer(host, { port: 0, token: "rehearsal-token" });
  await registerMcp(client, mcp.url, mcp.token);
  const t0 = Date.now();
  let out;
  if (task === "A") {
    const rel = "src/flask/helpers.py";
    const text = fs.readFileSync(path.join(repo, rel), "utf8");
    const start = text.split("\n").findIndex((l) => l.startsWith("def get_debug_flag")) + 1;
    const req = { path: rel, fullText: text, startLine: start, endLine: start + 5, instruction: TASK_A };
    out = await runner.run({ display: TASK_A, message: buildInlineMessage(req), mode: "inline", fresh: true, contextBudget: 1200, contextQuery: inlineContextQuery(req), contextExclude: [rel] });
  } else {
    out = await runner.run({ display: arg("prompt") || TASK_B, mode: "agent", fresh: true });
  }
  const s = runner.getState();
  for (; printed < s.items.length; printed++) show(s.items[printed]);
  console.log(`\n=== ${out.status} in ${((Date.now() - t0) / 1000).toFixed(1)} s · agent ${out.agentUsed}${out.usedFallback ? " (fallback)" : ""} · model ${s.model} · ${s.tokensIn ?? 0} in / ${s.tokensOut ?? 0} out`);
  console.log(`files changed: ${[...new Set(out.appliedPaths)].join(", ") || "(none)"}`);
  console.log(`TrueForge session: ${runner.sessionUrl()}`);
  if (task === "A") {
    process.env.FLASK_DEBUG = "off";
    const v = await execCommand('python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"', repo, 60000, bins);
    delete process.env.FLASK_DEBUG;
    console.log(`verification (FLASK_DEBUG=off): ${v.output.trim()}  ${v.output.trim() === "False" ? "OK" : "NOT YET"}`);
  } else {
    const v = await execCommand("python -m pytest tests/test_cli.py -q", repo, 180000, bins);
    console.log(`verification (pytest tests/test_cli.py): ${v.output.trim().split("\n").at(-1)}`);
    const h = await execCommand("python -m flask --help", repo, 60000, bins);
    console.log(`verification (flask --help lists config): ${/^\s+config\s/m.test(h.output) ? "OK" : "NOT YET"}`);
  }
  if (!has("keep")) {
    // Unwind every applied change, newest first; a real run can apply many more than 20.
    let undone = 0;
    let failure = "";
    while (store.appliedChanges().some((c) => !c.undone)) {
      const r = await store.undoLast(nodeIO);
      if (!r.ok) {
        failure = r.message;
        break;
      }
      undone++;
    }
    const left = store.appliedChanges().filter((c) => !c.undone);
    if (left.length) console.log(`UNDO INCOMPLETE: ${left.length} change(s) still applied (${[...new Set(left.map((c) => c.path))].join(", ")}): ${failure}`);
    else console.log(`changes undone: ${undone} (pass --keep to leave them in place)`);
  }
  await mcp.close();
  process.exit(out.status === "done" ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
