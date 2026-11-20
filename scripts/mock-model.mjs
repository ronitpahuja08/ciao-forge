#!/usr/bin/env node
// A scripted OpenAI-compatible chat-completions server used ONLY by the offline
// end-to-end tests. It lets the whole TrueForge loop (sessions, turns, MCP tool
// calls, approvals, streaming, cancellation, failover) be exercised with no API
// key and no network. It is never used by the extension itself: the extension
// only ever talks to TrueForge.
//
//   node scripts/mock-model.mjs --port 8801 --key good-key [--log file]
//
// Requests with any other bearer key get a 401, which is how the resilience
// test simulates "invalid key" on the primary model.
import http from "node:http";
import fs from "node:fs";
import { scenarios } from "./mock-scenarios.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const PORT = Number(arg("port", "8801"));
const KEY = arg("key", "good-key");
const LOG = arg("log", "");
const DELAY = Number(arg("delay", "15"));
const DUMP = arg("dump", "");

const log = (o) => LOG && fs.appendFileSync(LOG, JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => p.text ?? "").join("");
  return "";
}

/** Pick the scripted step for this request. */
function plan(body) {
  const msgs = body.messages ?? [];
  let lastUser = -1;
  msgs.forEach((m, i) => {
    if (m.role === "user") lastUser = i;
  });
  const userText = lastUser >= 0 ? textOf(msgs[lastUser].content) : "";
  const step = msgs.slice(lastUser + 1).filter((m) => m.role === "tool").length;
  const toolResults = msgs.slice(lastUser + 1).filter((m) => m.role === "tool").map((m) => textOf(m.content));
  const tools = (body.tools ?? []).map((t) => t.function?.name).filter(Boolean);
  const resolve = (short) => tools.find((n) => n === short) ?? tools.find((n) => n.endsWith(short)) ?? short;
  for (const sc of scenarios) {
    if (sc.match(userText)) {
      const steps = sc.steps;
      const s = steps[Math.min(step, steps.length - 1)];
      const out = typeof s === "function" ? s({ userText, toolResults, step }) : s;
      return { name: sc.name, step, ...out, resolve };
    }
  }
  return { name: "default", step, text: "I am the scripted test model. No scenario matched this request.", resolve };
}

function chunk(id, model, delta, finish = null) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

const server = http.createServer(async (req, res) => {
  const auth = req.headers.authorization ?? "";
  let raw = "";
  for await (const c of req) raw += c;
  if (req.method === "GET" && req.url?.includes("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [{ id: "scripted-1", object: "model" }] }));
  }
  if (auth !== `Bearer ${KEY}`) {
    log({ t: "401", url: req.url });
    res.writeHead(401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } }));
  }
  let body = {};
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    /* ignore */
  }
  if (DUMP) fs.writeFileSync(DUMP, JSON.stringify(body, null, 2));
  const p = plan(body);
  log({ t: "req", url: req.url, scenario: p.name, step: p.step, stream: !!body.stream, tools: (body.tools ?? []).map((t) => t.function?.name), nmsg: (body.messages ?? []).length });
  const id = `chatcmpl-mock-${Date.now()}`;
  const model = body.model ?? "scripted-1";
  const toolCalls = (p.tools ?? []).map((t, i) => ({
    index: i,
    id: `call_${Date.now()}_${i}`,
    type: "function",
    function: { name: p.resolve(t.name), arguments: JSON.stringify(t.args ?? {}) },
  }));
  const usage = { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: 50, total_tokens: Math.ceil(raw.length / 4) + 50 };

  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({
        id,
        object: "chat.completion",
        model,
        choices: [
          {
            index: 0,
            finish_reason: toolCalls.length ? "tool_calls" : "stop",
            message: { role: "assistant", content: p.text ?? "", ...(toolCalls.length ? { tool_calls: toolCalls.map(({ index, ...r }) => r) } : {}) },
          },
        ],
        usage,
      }),
    );
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  let closed = false;
  res.on("close", () => (closed = true));
  res.write(chunk(id, model, { role: "assistant", content: "" }));
  const words = (p.text ?? "").split(/(?<=\s)/);
  const delay = p.delay ?? DELAY;
  for (const w of words) {
    if (closed) return;
    res.write(chunk(id, model, { content: w }));
    await sleep(delay);
  }
  for (const tc of toolCalls) {
    if (closed) return;
    res.write(chunk(id, model, { tool_calls: [{ index: tc.index, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }));
    const a = tc.function.arguments;
    for (let i = 0; i < a.length; i += 400) {
      res.write(chunk(id, model, { tool_calls: [{ index: tc.index, function: { arguments: a.slice(i, i + 400) } }] }));
      await sleep(2);
    }
  }
  res.write(chunk(id, model, {}, toolCalls.length ? "tool_calls" : "stop"));
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [], usage })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock model listening on http://127.0.0.1:${PORT}/v1 (key ${KEY})`));
