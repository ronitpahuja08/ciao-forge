import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { checkCommand, GuardError, isSensitivePath, resolveInside } from "../src/core/guards";
import { execSync } from "node:child_process";
import { prepareProposal, tools, type ToolHost } from "../src/core/tools";
import { listWorkspaceFiles } from "../src/core/context";
import { applyHunks, applySearchReplace, applySearchReplaceDetailed, computeHunks, EditError } from "../src/core/hunks";
import { editKey, ProposalStore, sha } from "../src/core/store";
import { commandEnv, execCommand, execFileCommand, nodeIO } from "../src/core/nodeHost";
import { buildIndex, chunkFile, parseMentions, planContext, renderPlan, tokenize } from "../src/core/context";
import { initialState, reduce, findTool } from "../src/core/reducer";
import { backoffMs, classifyFailure, nextStep, sanitize } from "../src/core/resilience";
import { buildInlineMessage } from "../src/core/inline";

function tmp(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-unit-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

describe("path guard", () => {
  const root = tmp({ "a/b.txt": "x" });
  it("accepts paths inside the workspace", () => {
    expect(resolveInside(root, "a/b.txt").rel).toBe("a/b.txt");
    expect(resolveInside(root, "./a/../a/b.txt").rel).toBe("a/b.txt");
    expect(resolveInside(root, "new/dir/file.py").rel).toBe("new/dir/file.py");
  });
  it("rejects escapes, absolute paths, the root itself and .git", () => {
    for (const bad of ["../x", "a/../../x", path.join(os.tmpdir(), "elsewhere.txt"), ".", "", ".git/config", ".GIT/config", "sub/.Git/HEAD", "a\0b"]) {
      expect(() => resolveInside(root, bad), bad).toThrow(GuardError);
    }
  });
  it("refuses secrets files but allows their examples", () => {
    for (const bad of [".env", ".env.local", "config/.env.production", "prod.env", "certs/server.pem", "deploy.key", "id_rsa", "id_ed25519.pub", ".npmrc", "credentials.json", "sample_data/token.json", "gcp-service-account.json", "my-service_account-key.json", "secrets.yaml", ".ssh/config", "home/.aws/credentials"]) {
      expect(isSensitivePath(bad), bad).toBe(true);
      expect(() => resolveInside(root, bad), bad).toThrow(GuardError);
    }
    for (const ok of [".env.example", "config/.env.sample", "credentials.example.json", "src/keys.py", "docs/environment.md", "package.json", "tokenizer.py"]) {
      expect(isSensitivePath(ok), ok).toBe(false);
    }
  });
  it("leaves secrets files out of the workspace listing", () => {
    const r = tmp({ ".env": "K=1", "app.py": "x", ".env.example": "K=", "keys/id_rsa": "k", "service-account.json": "{}" });
    expect(listWorkspaceFiles(r).sort()).toEqual([".env.example", "app.py"]);
  });
});

describe("command execution", () => {
  it("withholds secret-looking environment variables from commands", () => {
    process.env.FORGE_TEST_API_KEY = "sk-should-not-leak";
    process.env.GITHUB_TOKEN_FORGE_TEST = "ghp-should-not-leak";
    process.env.FLASK_DEBUG_FORGE_TEST = "off";
    try {
      const env = commandEnv();
      expect(env.FORGE_TEST_API_KEY).toBeUndefined();
      expect(env.GITHUB_TOKEN_FORGE_TEST).toBeUndefined();
      expect(env.FLASK_DEBUG_FORGE_TEST).toBe("off");
      expect(env.PATH ?? env.Path).toBeTruthy();
    } finally {
      delete process.env.FORGE_TEST_API_KEY;
      delete process.env.GITHUB_TOKEN_FORGE_TEST;
      delete process.env.FLASK_DEBUG_FORGE_TEST;
    }
  });
  it("explain_history passes the path as an argument, never through a shell", async () => {
    const r = tmp({ "a.txt": "hi\n" });
    execSync("git init -q && git add . && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: r });
    const host = { root: r, exec: (c: string, cwd: string, t: number) => execCommand(c, cwd, t), execFile: (f: string, a: string[], cwd: string, t: number) => execFileCommand(f, a, cwd, t) } as unknown as ToolHost;
    for (const evil of ["a.txt$(touch PWNED1)", "a.txt`touch PWNED2`", "a.txt; touch PWNED3", "a.txt && touch PWNED4"]) {
      await tools.explain_history(host, { path: evil });
      await tools.explain_history(host, { path: evil, line: 1 });
    }
    expect(fs.readdirSync(r).filter((f) => f.startsWith("PWNED"))).toEqual([]);
    const ok = await tools.explain_history(host, { path: "a.txt" });
    expect(ok.text).toMatch(/init/);
  });
});

describe("command allowlist", () => {
  it("allows verification commands", () => {
    for (const ok of ["pytest tests/test_cli.py -q", "python -m pytest -q", "flask --help", "python -m flask --app hello config", "git status", "git diff --stat", "npm test", 'python -c "print(1)"']) {
      expect(checkCommand(ok).ok, ok).toBe(true);
    }
  });
  it("refuses everything else, including chaining and redirection", () => {
    for (const bad of ["rm -rf .", "git push", "git status && rm x", "pytest; curl x", "pytest > out.txt", "pip install x", "python script.py", "curl http://x", "", "pytest `whoami`", "pytest $(id)", "git diff --output=../../x", "git log --ext-diff", "git show --textconv HEAD"]) {
      expect(checkCommand(bad).ok, bad).toBe(false);
    }
  });
});

describe("hunks", () => {
  const original = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  it("groups separate changes into separate hunks", () => {
    const proposed = original.replace("line 3", "LINE 3").replace("line 20\n", "line 20\nextra\n").replace("line 28\n", "");
    const hunks = computeHunks(original, proposed);
    expect(hunks.map((h) => [h.origStart, h.removed.length, h.added.length])).toEqual([
      [2, 1, 1],
      [20, 0, 1],
      [27, 1, 0],
    ]);
  });
  it("applying all hunks gives the proposal; applying none gives the original", () => {
    const proposed = original.replace("line 3", "LINE 3").replace("line 20\n", "line 20\nextra\n");
    const hunks = computeHunks(original, proposed);
    expect(applyHunks(original, hunks, [0, 1])).toBe(proposed);
    expect(applyHunks(original, hunks, [])).toBe(original);
  });
  it("applies only the accepted hunks", () => {
    const proposed = original.replace("line 3", "LINE 3").replace("line 20\n", "line 20\nextra\n");
    const hunks = computeHunks(original, proposed);
    const only2 = applyHunks(original, hunks, [1]);
    expect(only2).toContain("line 3\n");
    expect(only2).toContain("extra");
    expect(only2).not.toContain("LINE 3");
  });
  it("handles new files and full deletions", () => {
    expect(applyHunks("", computeHunks("", "a\nb\n"), [0])).toBe("a\nb\n");
    const del = computeHunks("a\nb", "");
    expect(applyHunks("a\nb", del, del.map((h) => h.id))).toBe("");
  });
  it("round-trips random edits", () => {
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    for (let t = 0; t < 60; t++) {
      const a = Array.from({ length: 5 + rnd(25) }, () => `v${rnd(6)}`);
      const b = [...a];
      for (let k = 0; k < 1 + rnd(5); k++) {
        const at = rnd(b.length + 1);
        if (rnd(2)) b.splice(at, rnd(3), `n${rnd(50)}`);
        else b.splice(at, 1);
      }
      const hunks = computeHunks(a.join("\n"), b.join("\n"));
      expect(applyHunks(a.join("\n"), hunks, hunks.map((h) => h.id))).toBe(b.join("\n"));
    }
  });
});

describe("search/replace edits", () => {
  it("replaces a unique match", () => {
    expect(applySearchReplace("a\nb\nc\n", [{ old_text: "b", new_text: "B" }])).toBe("a\nB\nc\n");
  });
  it("refuses a missing or ambiguous match instead of guessing", () => {
    expect(() => applySearchReplace("a\nb\n", [{ old_text: "zzz", new_text: "y" }])).toThrow(EditError);
    expect(() => applySearchReplace("x = 1\nx = 1\n", [{ old_text: "x = 1", new_text: "x = 2" }])).toThrow(/more than one place/);
    expect(() => applySearchReplace("a", [{ old_text: "", new_text: "y" }])).toThrow(EditError);
  });
  it("locates whole lines despite wrong indentation or quote style, re-indents, and reports it", () => {
    const file = 'def f():\n    val = os.environ.get("FLASK_DEBUG")\n    return bool(val and val.lower() not in {"0", "false", "no"})\n';
    const ws = applySearchReplaceDetailed(file, [{ old_text: 'return bool(val and val.lower() not in {"0", "false", "no"})', new_text: 'return bool(val and val.lower() not in {"0", "false", "no", "off"})' }]);
    expect(ws.notes).toEqual([]); // exact substring match
    const indent = applySearchReplaceDetailed(file, [{ old_text: 'val = os.environ.get("FLASK_DEBUG")\nreturn bool(val and val.lower() not in {"0", "false", "no"})', new_text: 'val = os.environ.get("FLASK_DEBUG")\nreturn False' }]);
    expect(indent.text).toBe('def f():\n    val = os.environ.get("FLASK_DEBUG")\n    return False\n');
    expect(indent.notes[0]).toMatch(/ignoring indentation/);
    const quotes = applySearchReplaceDetailed(file, [{ old_text: "    return bool(val and val.lower() not in {'0', 'false', 'no'})", new_text: "    return bool(val and val.lower() not in {'0', 'false', 'no', 'off', 'n'})" }]);
    expect(quotes.text).toContain("'off', 'n'");
    expect(quotes.notes[0]).toMatch(/quote style/);
  });
  it("a partial-line approximate match is refused, with the closest real text as a hint", () => {
    const file = 'x = 1\n    return bool(val and val.lower() not in {"0", "false", "no"})\n';
    expect(() => applySearchReplace(file, [{ old_text: "val.lower() not in {'0', 'false', 'no'}", new_text: "y" }])).toThrow(/closest text in the file is at line 2/);
  });
  it("approximate matches must still be unique", () => {
    expect(() => applySearchReplace("  a = 1\n\ta = 1\n", [{ old_text: "a = 1 ", new_text: "b" }])).toThrow(/more than one place/);
  });
  it("keeps CRLF files CRLF", () => {
    expect(applySearchReplace("a\r\nb\r\n", [{ old_text: "a\nb", new_text: "a\nB" }])).toBe("a\r\nB\r\n");
  });
});

describe("proposal store", () => {
  it("never touches disk until apply, applies only accepted hunks, and undoes", async () => {
    const root = tmp({ "f.txt": "one\ntwo\nthree\nfour\nfive\nsix\n" });
    const abs = path.join(root, "f.txt");
    const store = new ProposalStore();
    const p = store.create({ key: "k", turnId: "t1", path: "f.txt", abs, original: fs.readFileSync(abs, "utf8"), proposed: "ONE\ntwo\nthree\nfour\nfive\nSIX\n" });
    expect(p.hunks).toHaveLength(2);
    expect(fs.readFileSync(abs, "utf8")).toBe("one\ntwo\nthree\nfour\nfive\nsix\n");
    store.decide(p.id, 0, "accepted");
    expect(store.awaiting()).toHaveLength(1);
    store.decide(p.id, 1, "rejected");
    expect(store.awaiting()).toHaveLength(0);
    const r = await store.apply(p.id, nodeIO);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(abs, "utf8")).toBe("ONE\ntwo\nthree\nfour\nfive\nsix\n");
    const u = await store.undoLast(nodeIO);
    expect(u.ok).toBe(true);
    expect(fs.readFileSync(abs, "utf8")).toBe("one\ntwo\nthree\nfour\nfive\nsix\n");
    expect((await store.undoLast(nodeIO)).ok).toBe(false);
  });
  it("rejecting every hunk settles the proposal and writes nothing", async () => {
    const root = tmp({ "f.txt": "a\n" });
    const abs = path.join(root, "f.txt");
    const store = new ProposalStore();
    const p = store.create({ key: "k", turnId: "t", path: "f.txt", abs, original: "a\n", proposed: "b\n" });
    store.decideAll(p.id, "rejected");
    expect(p.status).toBe("rejected");
    expect((await store.apply(p.id, nodeIO)).ok).toBe(false);
    expect(fs.readFileSync(abs, "utf8")).toBe("a\n");
  });
  it("refuses stale proposals and refuses to undo over later edits", async () => {
    const root = tmp({ "f.txt": "a\n" });
    const abs = path.join(root, "f.txt");
    const store = new ProposalStore();
    const p = store.create({ key: "k", turnId: "t", path: "f.txt", abs, original: "a\n", proposed: "b\n" });
    store.decideAll(p.id, "accepted");
    fs.writeFileSync(abs, "changed by user\n");
    expect((await store.apply(p.id, nodeIO)).ok).toBe(false);
    expect(fs.readFileSync(abs, "utf8")).toBe("changed by user\n");
    const p2 = store.create({ key: "k2", turnId: "t", path: "f.txt", abs, original: "changed by user\n", proposed: "x\n" });
    store.decideAll(p2.id, "accepted");
    expect((await store.apply(p2.id, nodeIO)).ok).toBe(true);
    fs.writeFileSync(abs, "x\nuser kept typing\n");
    expect((await store.undoLast(nodeIO)).ok).toBe(false);
    expect(fs.readFileSync(abs, "utf8")).toBe("x\nuser kept typing\n");
  });
  it("rollbackTurn reverts applied edits newest first, removes created files and discards pending proposals", async () => {
    const root = tmp({ "a.txt": "a\n" });
    const store = new ProposalStore();
    const mk = (rel: string, original: string | null, proposed: string, turn = "T") => store.create({ key: rel + proposed, turnId: turn, path: rel, abs: path.join(root, rel), original, proposed });
    const p1 = mk("a.txt", "a\n", "a1\n");
    store.decideAll(p1.id, "accepted");
    await store.apply(p1.id, nodeIO);
    const p2 = mk("a.txt", "a1\n", "a2\n");
    store.decideAll(p2.id, "accepted");
    await store.apply(p2.id, nodeIO);
    const p3 = mk("new/b.txt", null, "b\n");
    store.decideAll(p3.id, "accepted");
    await store.apply(p3.id, nodeIO);
    const other = mk("a.txt", "a2\n", "other\n", "OTHER");
    const pend = mk("c.txt", null, "c\n");
    let resolved = false;
    void store.waitForDecision(pend.id).then(() => (resolved = true));
    const rb = await store.rollbackTurn("T", nodeIO);
    expect(rb.reverted).toEqual(["new/b.txt", "a.txt", "a.txt"]);
    expect(rb.discarded).toBe(1);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a\n");
    expect(fs.existsSync(path.join(root, "new/b.txt"))).toBe(false);
    await Promise.resolve();
    expect(resolved).toBe(true);
    expect(other.status).toBe("pending");
  });
  it("editKey is stable for the same arguments and differs otherwise", () => {
    const a = { path: "x.py", edits: [{ old_text: "a", new_text: "b" }] };
    expect(editKey(a)).toBe(editKey(JSON.parse(JSON.stringify(a))));
    expect(editKey(a)).not.toBe(editKey({ ...a, path: "y.py" }));
    expect(sha(null)).toBe("absent");
  });
});

describe("context engine", () => {
  const filler = (n: number, word: string) => Array.from({ length: n }, (_, i) => `def ${word}_${i}():\n    return ${i}\n`).join("\n");
  const root = tmp({
    "src/flask/cli.py": `import click\n\n@click.command("routes")\ndef routes_command():\n    """Show the routes for the app."""\n\n\n@click.command("shell")\ndef shell_command():\n    """Run a shell in the app context."""\n\n\nclass FlaskGroup:\n    def __init__(self):\n        self.add_command(routes_command)\n        self.add_command(shell_command)\n`,
    "tests/test_cli.py": `from flask.cli import FlaskGroup\n\n\ndef test_help_lists_commands(runner):\n    result = runner.invoke(cli, ["--help"])\n    assert "routes" in result.output\n`,
    "docs/cli.rst": `Command Line Interface\n======================\n\nBuilt-in commands\n-----------------\n\nThe flask command has built-in commands such as routes and shell.\n`,
    "src/flask/helpers.py": `import os\n\n\ndef get_debug_flag() -> bool:\n    val = os.environ.get("FLASK_DEBUG")\n    return bool(val)\n\n\ndef url_for(endpoint):\n    return endpoint\n`,
    "src/flask/sessions.py": filler(40, "session"),
    "src/flask/templating.py": filler(40, "render"),
    "src/flask/wrappers.py": filler(40, "wrap"),
    "docs/templating.rst": "Templates\n=========\n\nJinja templates are rendered.\n",
    "node_modules/x/index.js": "module.exports = 'cli command config'",
    ".venv/lib/cli.py": "def cli_command_config(): pass",
  });
  const index = buildIndex(root);
  it("tokenizes identifiers and canonicalises word forms", () => {
    expect(tokenize("get_debug_flag")).toEqual(["debug", "flag"]);
    expect(tokenize("FlaskGroup routesCommand")).toEqual(["flask", "group", "route", "command"]);
    expect(tokenize("documented configuration commands")).toEqual(["doc", "config", "command"]);
  });
  it("skips dependency and virtualenv directories", () => {
    expect(index.files.some((f) => f.startsWith("node_modules") || f.startsWith(".venv"))).toBe(false);
  });
  it("chunks code at definitions", () => {
    const chunks = chunkFile("x.py", "import a\n\n\ndef one():\n    pass\n\n\n@deco\ndef two():\n    pass\n");
    expect(chunks.map((c) => c.symbols)).toEqual([[], ["one"], ["two"]]);
    expect(chunks[2].text.startsWith("@deco")).toBe(true);
  });
  it("retrieves the implementation, its test and its doc for a feature request nobody attached files to", () => {
    const plan = planContext(index, "Add a new built-in CLI command flask config that prints the configuration as JSON. It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.", { budget: 1200 });
    const paths = [...new Set(plan.items.map((i) => i.path))];
    expect(paths.slice(0, 3).sort()).toEqual(["docs/cli.rst", "src/flask/cli.py", "tests/test_cli.py"]);
    expect(plan.items.every((i) => i.reason.length > 0)).toBe(true);
    expect(plan.items.find((i) => i.path === "tests/test_cli.py")?.reason).toMatch(/test companion of src\/flask\/cli\.py/);
  });
  it("never exceeds the budget and reports what was left out", () => {
    for (const budget of [500, 800, 2000]) {
      const plan = planContext(index, "session render wrap command config", { budget });
      expect(plan.usedTokens).toBeLessThanOrEqual(budget);
      expect(plan.items.reduce((a, i) => a + i.tokens, 0)).toBe(plan.usedTokens);
    }
    const tight = planContext(index, "session render wrap command config", { budget: 500, maxFiles: 2 });
    expect(tight.omitted.length).toBeGreaterThan(0);
  });
  it("pins @file and @symbol mentions first and reports unknown ones", () => {
    const m = parseMentions("fix @get_debug_flag in @helpers.py and @nope_missing", index);
    expect(m.files).toEqual(["src/flask/helpers.py"]);
    expect(m.symbols.map((s) => s.name)).toEqual(["get_debug_flag"]);
    expect(m.unknown).toEqual(["nope_missing"]);
    const plan = planContext(index, "change @get_debug_flag to treat off as false", { budget: 1500 });
    expect(plan.items[0].kind).toBe("mention");
    expect(plan.items[0].path).toBe("src/flask/helpers.py");
    expect(plan.items[0].text).toContain("def get_debug_flag");
    expect(renderPlan(plan, false)).toMatch(/\| src\/flask\/helpers\.py \| .* \| pinned \| explicit @get_debug_flag mention/);
  });
});

describe("event reducer", () => {
  it("accumulates streamed text and tool-call arguments, and tracks approval state", () => {
    let s = initialState();
    const feed = (e: Record<string, unknown>) => (s = reduce(s, e as never));
    feed({ type: "local.user", text: "hi" });
    feed({ type: "turn.created", turnId: "T1" });
    feed({ type: "model.message", id: "m1", model: { name: "p/m" } });
    feed({ type: "model.message.delta", id: "m1", threadId: "main", content: "Hel" });
    feed({ type: "model.message.delta", id: "m1", threadId: "main", content: "lo" });
    feed({ type: "model.message.delta", id: "m1", threadId: "main", toolCalls: [{ index: 0, id: "c1", function: { name: "propose_edit", arguments: "" } }] });
    feed({ type: "model.message.delta", id: "m1", threadId: "main", toolCalls: [{ index: 0, function: { arguments: '{"path":' } }] });
    feed({ type: "model.message.delta", id: "m1", threadId: "main", toolCalls: [{ index: 0, function: { arguments: '"a.py"}' } }] });
    expect(s.status).toBe("running");
    expect(s.model).toBe("p/m");
    expect(s.items.find((i) => i.kind === "assistant")).toMatchObject({ text: "Hello" });
    expect(JSON.parse(findTool(s, "c1")!.args)).toEqual({ path: "a.py" });
    feed({ type: "tool.approval_required", threadId: "main", toolCalls: [{ id: "c1", sourceEventId: "m1" }] });
    expect(s.status).toBe("awaiting_approval");
    expect(findTool(s, "c1")!.status).toBe("awaiting_approval");
    feed({ type: "user.tool_approval", toolCallId: "c1", approval: { status: "allow" } });
    expect(findTool(s, "c1")!.status).toBe("running");
    feed({ type: "tool.response", toolCallId: "c1", content: "Applied 1 of 1" });
    expect(findTool(s, "c1")).toMatchObject({ status: "done", result: "Applied 1 of 1" });
    feed({ type: "turn.done", state: { status: "done", metrics: { totalInputTokens: 10, totalOutputTokens: 2 } } });
    expect(s.tokensIn).toBe(10);
  });
  it("keeps a denied tool denied", () => {
    let s = initialState();
    s = reduce(s, { type: "model.message.delta", id: "m", threadId: "main", toolCalls: [{ index: 0, id: "c", function: { name: "propose_edit", arguments: "{}" } }] } as never);
    s = reduce(s, { type: "user.tool_approval", toolCallId: "c", approval: { status: "deny" } } as never);
    s = reduce(s, { type: "tool.response", toolCallId: "c", content: "denied" } as never);
    expect(findTool(s, "c")!.status).toBe("denied");
  });
});

describe("resilience policy", () => {
  it("classifies the failures TrueForge actually reports", () => {
    expect(classifyFailure({ message: "Request failed (401): Incorrect API key provided." })).toMatchObject({ kind: "auth", retryable: false, fallbackable: true });
    expect(classifyFailure({ message: "Cannot connect to API: bad port" })).toMatchObject({ kind: "unreachable", retryable: true });
    expect(classifyFailure({ message: "Request failed (429): rate limit exceeded" })).toMatchObject({ kind: "rate_limit", retryable: true });
    expect(classifyFailure({ message: "Request failed (503): Service Unavailable" })).toMatchObject({ kind: "server", retryable: true });
    expect(classifyFailure({ harnessUnreachable: true })).toMatchObject({ kind: "harness_down", fallbackable: false });
  });
  it("never leaks credentials or stack frames into messages", () => {
    const fakeKey = ["sk", "abcdefghijklmnopqrstuv"].join("-"); // assembled so secret scanners do not flag this file
    const f = classifyFailure({ message: `401 Unauthorized Bearer abcdefghijklmnop ${fakeKey} at foo (C:\\x\\y.js:1:2)` });
    expect(f.reason).not.toMatch(/abcdefghijklmnop|y\.js/);
    expect(sanitize("key gsk_ABCDEFGHIJKLMNOP")).toBe("key [redacted]");
  });
  it("backs off exponentially with a cap", () => {
    expect([0, 1, 2, 3, 9].map((n) => backoffMs(n))).toEqual([400, 800, 1600, 3200, 4000]);
  });
  it("retries retryable failures, then falls back, then fails; auth goes straight to fallback", () => {
    const base = { maxRetries: 2, onFallback: false, hasFallback: true, appliedEdits: 0 };
    const net = classifyFailure({ message: "ECONNREFUSED" });
    expect(nextStep(net, { ...base, attemptOnThisAgent: 0 })).toEqual({ action: "retry", delayMs: 400 });
    expect(nextStep(net, { ...base, attemptOnThisAgent: 1 })).toEqual({ action: "retry", delayMs: 800 });
    expect(nextStep(net, { ...base, attemptOnThisAgent: 2 })).toEqual({ action: "fallback" });
    expect(nextStep(net, { ...base, attemptOnThisAgent: 2, onFallback: true })).toEqual({ action: "fail" });
    const auth = classifyFailure({ message: "invalid api key" });
    expect(nextStep(auth, { ...base, attemptOnThisAgent: 0 })).toEqual({ action: "fallback" });
    expect(nextStep(auth, { ...base, attemptOnThisAgent: 0, hasFallback: false })).toEqual({ action: "fail" });
  });
  it("never silently re-runs once edits were applied, and never falls back when the harness is down", () => {
    const net = classifyFailure({ message: "ECONNRESET" });
    expect(nextStep(net, { attemptOnThisAgent: 0, maxRetries: 3, onFallback: false, hasFallback: true, appliedEdits: 1 })).toEqual({ action: "fail" });
    expect(nextStep(classifyFailure({ harnessUnreachable: true }), { attemptOnThisAgent: 0, maxRetries: 3, onFallback: false, hasFallback: true, appliedEdits: 0 })).toEqual({ action: "fail" });
  });
});

describe("inline edit message", () => {
  it("contains the exact selection, its line range and surrounding context", () => {
    const text = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
    const m = buildInlineMessage({ path: "src/x.py", fullText: text, startLine: 30, endLine: 32, instruction: "do it" });
    expect(m.startsWith("INLINE EDIT of src/x.py, lines 30-32.")).toBe(true);
    expect(m).toContain('<selection path="src/x.py" lines="30-32">\nline 30\nline 31\nline 32\n</selection>');
    expect(m).toContain('<surrounding path="src/x.py" lines="10-52">');
    expect(m).toContain("Instruction: do it");
  });
});

const NL = String.fromCharCode(10);
const hasPython = (() => {
  for (const exe of ["python3", "python"]) {
    try { execSync(`${exe} --version`, { stdio: "ignore" }); return true; } catch { /* try the next one */ }
  }
  return false;
})();

describe.skipIf(!hasPython)("python syntax guard", () => {
  const host = (root: string) => ({ root, io: nodeIO, store: new ProposalStore(), currentTurnId: () => "t" }) as unknown as ToolHost;
  const good = ["def f():", "    return 1", ""].join(NL);

  it("rejects an edit that would leave a .py file unparseable and writes nothing", async () => {
    const root = tmp({ "m.py": good });
    const r = await prepareProposal(host(root), { path: "m.py", edits: [{ old_text: "    return 1", new_text: ["    return 1", "  x = 2"].join(NL) }] });
    expect(r.proposal).toBeUndefined();
    expect(r.error).toMatch(/would not be valid Python/);
    expect(r.error).toMatch(/line 3 of m\.py/);
    expect(fs.readFileSync(path.join(root, "m.py"), "utf8")).toBe(good);
  });
  it("accepts a valid Python edit", async () => {
    const root = tmp({ "m.py": good });
    const r = await prepareProposal(host(root), { path: "m.py", edits: [{ old_text: "    return 1", new_text: "    return 2" }] });
    expect(r.error).toBeUndefined();
    expect(r.proposal?.proposed).toContain("return 2");
  });
  it("does not block edits to a file that was already unparseable", async () => {
    const root = tmp({ "broken.py": "def f(:" + NL });
    const r = await prepareProposal(host(root), { path: "broken.py", edits: [{ old_text: "def f(:", new_text: "def g(:" }] });
    expect(r.error).toBeUndefined();
    expect(r.proposal).toBeDefined();
  });
  it("does not apply to non-Python files", async () => {
    const root = tmp({ "notes.txt": "a" + NL });
    const r = await prepareProposal(host(root), { path: "notes.txt", edits: [{ old_text: "a", new_text: "def f(:" }] });
    expect(r.error).toBeUndefined();
    expect(r.proposal).toBeDefined();
  });
});
