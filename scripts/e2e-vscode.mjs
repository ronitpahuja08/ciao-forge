#!/usr/bin/env node
// Launch a real, isolated VS Code window with the extension loaded and run
// test-e2e/suite.js inside its extension host.
//
// Needs: TrueForge running locally, `npm run build` done, and the `code` CLI
// on PATH (or CODE_BIN set). No API key: models are scripted (scripts/mock-model.mjs).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TrueForge } from "@truefoundry/trueforge-sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, "..");
const base = process.env.TRUEFORGE_URL ?? "http://localhost:8790";
const client = new TrueForge({ baseUrl: base });
try {
  await client.models.list();
} catch {
  console.error(`TrueForge is not reachable at ${base}. Start it first.`);
  process.exit(2);
}

const mocks = [
  spawn(process.execPath, [path.join(here, "mock-model.mjs"), "--port", "8821", "--key", "key-a"], { stdio: "ignore" }),
  spawn(process.execPath, [path.join(here, "mock-model.mjs"), "--port", "8822", "--key", "key-b"], { stdio: "ignore" }),
];
const provider = (name, port, apiKey) =>
  client.settings.modelProviders.createOrUpdate({ manifest: { type: "custom", name, baseUrl: `http://127.0.0.1:${port}/v1`, auth: { apiKey }, models: [{ name: "scripted", modelId: "scripted-1", properties: { contextLength: 128000, maxOutputTokens: 8000 } }] } });
await provider("vsc-a", 8821, "key-a");
await provider("vsc-b", 8822, "key-b");
await provider("vsc-badkey", 8821, "wrong");

// A small throwaway workspace that includes the real get_debug_flag source for the inline-edit check.
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "forge-vsc-ws-"));
const put = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), text);
};
put("pkg/greet.py", 'def greet():\n    return "hello"\n');
put("tests/test_greet.py", 'from pkg.greet import greet\n\n\ndef test_greet():\n    assert greet() == "hello"\n');
put("a.txt", "alpha\nbeta\n");
put(
  "src/flask/helpers.py",
  'from __future__ import annotations\n\nimport os\n\n\ndef get_debug_flag() -> bool:\n    """Get whether debug mode should be enabled for the app, indicated by the\n    :envvar:`FLASK_DEBUG` environment variable. The default is ``False``.\n    """\n    val = os.environ.get("FLASK_DEBUG")\n    return bool(val and val.lower() not in {"0", "false", "no"})\n\n\ndef get_load_dotenv(default: bool = True) -> bool:\n    return default\n',
);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "forge-vsc-ud-"));
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-vsc-ext-"));
fs.mkdirSync(path.join(userData, "User"), { recursive: true });
fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify({ "ciaoForge.trueforgeUrl": base, "ciaoForge.mcpPort": 0, "security.workspace.trust.enabled": false, "telemetry.telemetryLevel": "off", "update.mode": "none" }));

const resultsFile = path.join(project, "test-e2e", "results-vscode.txt");
fs.rmSync(resultsFile, { force: true });
const codeBin = process.env.CODE_BIN ?? (process.platform === "win32" ? "code.cmd" : "code");
const args = ["--new-window", "--wait", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", `--user-data-dir=${userData}`, `--extensions-dir=${extDir}`, `--extensionDevelopmentPath=${project}`, `--extensionTestsPath=${path.join(project, "test-e2e", "suite.js")}`, ws];
const env = { ...process.env, FORGE_E2E_PRIMARY: "vsc-a/scripted", FORGE_E2E_FALLBACK: "vsc-b/scripted", FORGE_E2E_BAD: "vsc-badkey/scripted" };
delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(codeBin, args, { env, stdio: "inherit", shell: process.platform === "win32", timeout: 240000 });
for (const m of mocks) m.kill();
if (!fs.existsSync(resultsFile)) {
  console.error(`VS Code exited (status ${r.status}, signal ${r.signal}, error ${r.error?.message}) without writing results.`);
  process.exit(1);
}
const report = fs.readFileSync(resultsFile, "utf8");
console.log(report);
process.exit(/\bFAIL\b/.test(report) ? 1 : 0);
