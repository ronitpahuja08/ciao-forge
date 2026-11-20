#!/usr/bin/env node
// Eligibility guard for the Forge-a-thon rules. Fails (exit 1) if the repository:
//   - depends on or imports a model-provider SDK, or mentions a provider API host
//     (the extension must talk only to TrueForge; models are configured in TrueForge);
//   - does not ship the agent definition it uses;
//   - contains something that looks like an API key.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const self = path.join("scripts", "check-eligibility.mjs");
const SKIP = new Set(["node_modules", "dist", ".git", "test-e2e"]);
const problems = [];

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const BANNED_DEPS = [/^openai$/, /^@anthropic-ai\//, /^@google\/(generative-ai|genai)$/, /^groq-sdk$/, /^@mistralai\//, /^cohere-ai$/, /^ollama$/, /^langchain/, /^@langchain\//, /^ai$/, /^@ai-sdk\//, /^litellm$/];
for (const d of Object.keys(deps)) if (BANNED_DEPS.some((re) => re.test(d))) problems.push(`package.json depends on a model-provider SDK: ${d}`);
if (!deps["@truefoundry/trueforge-sdk"]) problems.push("package.json does not depend on @truefoundry/trueforge-sdk");

const BANNED_TEXT = [
  [/api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.groq\.com|openrouter\.ai\/api|api\.mistral\.ai|api\.together\.xyz|api\.deepseek\.com|integrate\.api\.nvidia\.com/i, "provider API host"],
  [/from\s+["'](openai|groq-sdk|@anthropic-ai\/[^"']+|@google\/generative-ai|ollama)["']|require\(["'](openai|groq-sdk|@anthropic-ai\/[^"']+)["']\)/, "provider SDK import"],
  [/\/chat\/completions|\/v1\/messages\b/, "direct model endpoint path"],
];
const SECRET = /\b(sk-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|nvapi-[A-Za-z0-9_-]{20,}|sk-or-[A-Za-z0-9_-]{20,})\b/;

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs);
    if (e.isDirectory()) walk(abs);
    else if (/\.(ts|js|mjs|cjs|json|md|yaml|yml|env|example)$/.test(e.name) || e.name.startsWith(".env")) {
      if (e.name === "package-lock.json") continue;
      const text = fs.readFileSync(abs, "utf8");
      if (SECRET.test(text)) problems.push(`${rel}: looks like a committed API key`);
      // Runtime code only: the scripted test model implements the OpenAI wire format on purpose,
      // and docs may name providers when explaining how to configure them in TrueForge.
      const runtime = rel.startsWith("src" + path.sep);
      if (runtime) for (const [re, what] of BANNED_TEXT) if (re.test(text)) problems.push(`${rel}: ${what}`);
    }
  }
}
walk(root);

const agentDir = path.join(root, "agent");
const agents = fs.existsSync(agentDir) ? fs.readdirSync(agentDir).filter((f) => f.endsWith(".agent.json")) : [];
if (agents.length === 0) problems.push("agent/*.agent.json is missing (the agent definition must be in the repository)");
for (const f of agents) {
  const def = JSON.parse(fs.readFileSync(path.join(agentDir, f), "utf8"));
  const servers = def.manifest?.mcpServers ?? [];
  if (!servers.some((s) => s.name === "ciao-editor")) problems.push(`${f}: the agent does not use the ciao-editor MCP server`);
  if (!servers.some((s) => (s.requireApprovalForTools ?? []).includes("propose_edit"))) problems.push(`${f}: propose_edit must require approval (approval drives the diff review)`);
}
if (fs.existsSync(path.join(root, ".env"))) {
  const ignored = fs.readFileSync(path.join(root, ".gitignore"), "utf8").split(/\r?\n/).includes(".env");
  if (!ignored) problems.push(".env exists and is not gitignored");
}
if (!fs.existsSync(path.join(root, "LICENSE"))) problems.push("LICENSE is missing");

if (problems.length) {
  console.error(`Eligibility check FAILED:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`Eligibility check passed: no provider SDKs or hosts in src/, no secrets, ${agents.length} agent definition(s) present, propose_edit gated by TrueForge approval. (${self})`);
