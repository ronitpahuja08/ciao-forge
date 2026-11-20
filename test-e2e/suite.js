// Runs INSIDE a real VS Code extension host (launched by scripts/e2e-vscode.mjs).
// Drives the real extension: real commands, real WorkspaceEdit writes, real
// TrueForge server, scripted models. Results go to test-e2e/results-vscode.txt.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  throw new Error("timed out waiting for condition");
}

exports.run = async function run() {
  const results = [];
  const progress = path.join(__dirname, "progress-vscode.txt");
  fs.writeFileSync(progress, "");
  // Each step gets a hard limit so one stuck step can never hang the window.
  const check = async (name, fn) => {
    fs.appendFileSync(progress, `START ${name}
`);
    let timer;
    try {
      const detail = await Promise.race([fn(), new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("step exceeded 45 s")), 45000)))]);
      results.push(`PASS  ${name}${detail ? `  [${detail}]` : ""}`);
    } catch (e) {
      results.push(`FAIL  ${name}: ${e.message}`);
      // Do not let a failed step leave a run or a review hanging for the next one.
      try {
        await vscode.commands.executeCommand("ciaoForge.rejectAll");
        await vscode.commands.executeCommand("ciaoForge.stop");
      } catch (_) {}
    } finally {
      clearTimeout(timer);
    }
    fs.appendFileSync(progress, `${results.at(-1)}
`);
  };
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const read = (rel) => (fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), "utf8") : null);
  const original = { greet: read("pkg/greet.py"), test: read("tests/test_greet.py") };
  const ext = vscode.extensions.getExtension("ciao.ciao-forge");
  let api;

  await check("extension is installed and activates", async () => {
    assert.ok(ext);
    api = await ext.activate();
    assert.equal(ext.isActive, true);
  });
  await check("all commands are registered", async () => {
    const cmds = await vscode.commands.getCommands(true);
    for (const id of ["ciaoForge.inlineEdit", "ciaoForge.stop", "ciaoForge.undoLastApply", "ciaoForge.reviewProposals", "ciaoForge.acceptHunk", "ciaoForge.rejectHunk", "ciaoForge.setup", "ciaoForge.openSession", "ciaoForge.reconnect"]) assert.ok(cmds.includes(id), id);
  });
  await check("MCP server starts on loopback and registers itself with TrueForge", async () => {
    await api.ready;
    const mcp = api.mcp();
    assert.ok(mcp && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(mcp.url));
    const r = await fetch(mcp.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 401);
    const tools = await api.runner.getClient().mcpServers.listTools("ciao-editor");
    assert.equal(tools.data.length, 8);
    return mcp.url;
  });
  await check("setup command creates both agents from agent/*.json with the chosen models", async () => {
    await vscode.commands.executeCommand("ciaoForge.setup", { primary: process.env.FORGE_E2E_PRIMARY, fallback: process.env.FORGE_E2E_FALLBACK });
    const names = [];
    for await (const a of await api.runner.getClient().agents.list({})) names.push(a.name);
    assert.ok(names.includes("ciao-forge") && names.includes("ciao-forge-fallback"));
  });
  await check("agent panel view opens", async () => {
    await vscode.commands.executeCommand("ciaoForge.agent.focus");
  });

  // ---- Agent mode through the real editor: per-hunk review with CodeLens, WorkspaceEdit apply ----
  let lensTitles = "";
  await check("agent mode: diff is shown for review and nothing is on disk yet", async () => {
    const run = api.runner.run({ display: "MULTI_FILE_TEST change the greeting message", mode: "agent", fresh: true });
    api._run = run;
    const p = await until(() => api.store.awaiting()[0]);
    assert.equal(p.path, "pkg/greet.py");
    assert.equal(read("pkg/greet.py"), original.greet, "file changed before review");
    await sleep(600);
    const uri = vscode.Uri.file(path.join(root, "pkg/greet.py"));
    const lenses = (await vscode.commands.executeCommand("vscode.executeCodeLensProvider", uri)) || [];
    lensTitles = lenses.map((l) => l.command && l.command.title).filter(Boolean).join(" | ");
    assert.ok(/Accept hunk 1\/1/.test(lensTitles) && /Reject/.test(lensTitles), lensTitles);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
    assert.ok(tabs.includes("cIAo Forge Review"), tabs.join(","));
    return lensTitles;
  });
  await check("accepting a hunk from the editor applies it via WorkspaceEdit and saves", async () => {
    const p = api.store.awaiting()[0];
    await vscode.commands.executeCommand("ciaoForge.acceptHunk", p.id, 0);
    await until(() => api.store.get(p.id).status === "applied");
    assert.ok(read("pkg/greet.py").includes("hello, world"));
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.endsWith("greet.py"));
    assert.ok(doc && !doc.isDirty, "document left dirty");
  });
  await check("rejecting the second file's hunk leaves that file untouched and the run continues", async () => {
    const p = await until(() => api.store.awaiting()[0]);
    assert.equal(p.path, "tests/test_greet.py");
    await vscode.commands.executeCommand("ciaoForge.rejectHunk", p.id, 0);
    const p3 = await until(() => api.store.awaiting()[0]);
    assert.equal(p3.path, "docs/greet.md");
    assert.equal(read("tests/test_greet.py"), original.test);
    await vscode.commands.executeCommand("ciaoForge.acceptAll");
    const out = await api._run;
    assert.equal(out.status, "done");
    assert.deepEqual([...new Set(out.appliedPaths)].sort(), ["docs/greet.md", "pkg/greet.py"]);
    assert.ok(read("docs/greet.md") !== null);
  });
  await check("undo command restores applied changes one by one", async () => {
    await vscode.commands.executeCommand("ciaoForge.undoLastApply");
    await until(() => read("docs/greet.md") === null);
    await vscode.commands.executeCommand("ciaoForge.undoLastApply");
    await until(() => read("pkg/greet.py") === original.greet);
  });

  // ---- Inline edit through the real command ----
  await check("inline edit: selection + instruction -> reviewed diff in the editor -> accept", async () => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, "src/flask/helpers.py")));
    const ed = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const start = doc.getText().split("\n").findIndex((l) => l.startsWith("def get_debug_flag"));
    ed.selection = new vscode.Selection(start, 0, start + 6, 0);
    const before = doc.getText();
    const done = vscode.commands.executeCommand("ciaoForge.inlineEdit", { instruction: "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false." });
    const p = await until(() => api.store.awaiting()[0]);
    assert.equal(p.path, "src/flask/helpers.py");
    assert.equal(p.source, "agent");
    assert.ok(p.hunks.length >= 2, `${p.hunks.length} hunks`);
    assert.equal(read("src/flask/helpers.py"), before, "written before review");
    await done;
    // accept the logic hunk, reject the docstring hunk: per-hunk control
    const logic = p.hunks.findIndex((h) => h.added.some((l) => l.includes('"off"')));
    for (let i = 0; i < p.hunks.length; i++) await vscode.commands.executeCommand(i === logic ? "ciaoForge.acceptHunk" : "ciaoForge.rejectHunk", p.id, i);
    await until(() => !api.runner.isBusy());
    const now = read("src/flask/helpers.py");
    assert.ok(now.includes('"off", "n"'), "logic hunk missing");
    assert.ok(!now.includes("treated as\n    false"), "rejected docstring hunk was written");
    return `${p.hunks.length} hunks, 1 accepted`;
  });
  await check("native editor undo (Ctrl+Z) also reverts the applied inline edit", async () => {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.endsWith("helpers.py"));
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    await vscode.commands.executeCommand("undo");
    assert.ok(!doc.getText().includes('"off", "n"'));
    await vscode.commands.executeCommand("redo");
    await doc.save();
    await vscode.commands.executeCommand("ciaoForge.undoLastApply");
    await until(() => !read("src/flask/helpers.py").includes('"off", "n"'));
  });

  // ---- Cancellation through the real command ----
  await check("stop command cancels a streaming run immediately and the editor stays responsive", async () => {
    const run = api.runner.run({ display: "SLOW_STREAM_TEST", mode: "agent", fresh: true, contextBudget: 0 });
    await until(() => api.runner.getState().items.some((i) => i.kind === "assistant" && i.text.length > 20));
    const t0 = Date.now();
    // The extension host must still answer other requests while tokens stream.
    await vscode.commands.executeCommand("vscode.executeCodeLensProvider", vscode.Uri.file(path.join(root, "pkg/greet.py")));
    const responsive = Date.now() - t0;
    const t1 = Date.now();
    await vscode.commands.executeCommand("ciaoForge.stop");
    const out = await run;
    assert.equal(out.status, "cancelled");
    assert.ok(responsive < 500, `editor took ${responsive} ms to answer during streaming`);
    return `editor answered in ${responsive} ms mid-stream; stop took ${Date.now() - t1} ms`;
  });
  await check("cancel after an applied edit rolls it back", async () => {
    const before = read("a.txt");
    const run = api.runner.run({ display: "CANCEL_AFTER_EDIT_TEST", mode: "agent", fresh: true, contextBudget: 0 });
    const p = await until(() => api.store.awaiting()[0]);
    await vscode.commands.executeCommand("ciaoForge.acceptHunk", p.id, 0);
    await until(() => read("a.txt") !== before);
    await sleep(300);
    await vscode.commands.executeCommand("ciaoForge.stop");
    await run;
    await until(() => read("a.txt") === before, 5000);
  });

  // ---- Resilience through the real settings ----
  await check("invalid key on the primary: automatic fallback, workspace unchanged until review", async () => {
    await vscode.commands.executeCommand("ciaoForge.setup", { primary: process.env.FORGE_E2E_BAD, fallback: process.env.FORGE_E2E_FALLBACK });
    const before = read("pkg/greet.py");
    const run = api.runner.run({ display: "MULTI_FILE_TEST change the greeting message", mode: "agent", fresh: true });
    const p = await until(() => api.store.awaiting()[0]);
    assert.equal(read("pkg/greet.py"), before);
    const notices = api.runner.getState().items.filter((i) => i.kind === "notice").map((i) => i.text).join(" ");
    assert.ok(/rejected the credentials/.test(notices) && /fallback agent "ciao-forge-fallback"/.test(notices), notices);
    await vscode.commands.executeCommand("ciaoForge.rejectAll");
    for (let i = 0; i < 2; i++) {
      await until(() => api.store.awaiting()[0] || !api.runner.isBusy());
      await vscode.commands.executeCommand("ciaoForge.rejectAll");
    }
    const out = await run;
    assert.equal(out.usedFallback, true);
    assert.equal(read("pkg/greet.py"), before);
    assert.equal(read("docs/greet.md"), null);
    return notices.slice(0, 150);
  });

  const report = `=== cIAo Forge extension-host E2E (VS Code ${vscode.version}) ===\n${results.join("\n")}\n\n${results.filter((r) => r.startsWith("PASS")).length} passed, ${results.filter((r) => r.startsWith("FAIL")).length} failed\n`;
  fs.writeFileSync(path.join(__dirname, "results-vscode.txt"), report);
  await vscode.commands.executeCommand("workbench.action.closeWindow");
};
