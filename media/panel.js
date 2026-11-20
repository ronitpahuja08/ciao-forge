// Agent panel webview: renders the state pushed by the extension. No logic lives here.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $("log");
  const input = $("input");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const open = new Set();
  let running = false;

  function md(text) {
    // Minimal, safe formatting: fenced code, inline code, bold.
    const parts = esc(text).split(/```/);
    return parts
      .map((p, i) => (i % 2 ? `<pre>${p.replace(/^[a-z]*\n/, "")}</pre>` : p.replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>")))
      .join("");
  }

  function toolSummary(t) {
    let a = {};
    try {
      a = JSON.parse(t.args || "{}");
    } catch (_) {
      /* still streaming */
    }
    if (t.name === "propose_edit") return a.path ? `${a.path}${a.rationale ? " — " + a.rationale : ""}` : "";
    if (t.name === "run_command") return a.command || "";
    if (t.name === "call_tool" || t.name === "get_tool_info") return `${a.tool_name || ""}${a.input ? " " + JSON.stringify(a.input) : ""} (deferred tool)`;
    if (t.name === "create_sub_agent") return a.name || "";
    if (t.name === "read_file") return `${a.path || ""}${a.start_line ? `:${a.start_line}-${a.end_line || ""}` : ""}`;
    return a.query || a.name || a.path || a.directory || "";
  }
  const toolLabel = { calling: "calling…", awaiting_approval: "waiting for you", running: "running…", done: "done", denied: "rejected by you" };

  function itemHtml(it, i) {
    if (it.kind === "user") return `<div class="item user">${esc(it.text)}</div>`;
    if (it.kind === "assistant") return `<div class="item assistant${it.thread && it.thread !== "main" ? " sub" : ""}">${md(it.text)}</div>`;
    if (it.kind === "notice") return `<div class="item notice ${it.level}">${md(it.text)}</div>`;
    if (it.kind === "tool") {
      const key = `t${i}`;
      const detail = `<div class="tool-body"><div class="k">arguments</div><pre>${esc(it.args || "")}</pre>${it.result !== undefined ? `<div class="k">result</div><pre>${esc(it.result.slice(0, 6000))}</pre>` : ""}</div>`;
      return `<details class="item tool ${it.status}" data-key="${key}" ${open.has(key) ? "open" : ""}><summary><span class="dot"></span><span class="tool-name">${esc(it.name)}</span><span class="tool-arg">${esc(toolSummary(it))}</span><span class="tool-state">${toolLabel[it.status] || it.status}</span></summary>${detail}</details>`;
    }
    if (it.kind === "context") {
      const key = `c${i}`;
      const rows = it.rows.map((r) => `<tr><td class="path">${esc(r.path)}</td><td>${esc(r.ranges)}</td><td class="num">${r.tokens}</td><td class="num">${esc(r.score)}</td><td>${esc(r.reason)}</td></tr>`).join("");
      const omitted = it.omitted.length ? `<div class="omitted">Ranked but left out of the budget: ${it.omitted.map(esc).join(", ")}</div>` : "";
      return `<details class="item context" data-key="${key}" ${open.has(key) || !open.has(key + ":closed") ? "open" : ""}><summary>${esc(it.summary)}</summary>
        <table><thead><tr><th>file</th><th>lines</th><th>tokens</th><th>score</th><th>why it was chosen</th></tr></thead><tbody>${rows}</tbody></table>${omitted}</details>`;
    }
    return "";
  }

  function render(msg) {
    const s = msg.state;
    running = s.status === "running" || s.status === "awaiting_approval";
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    log.innerHTML = s.items.length ? s.items.map(itemHtml).join("") : '<div class="empty">Describe a change. The agent finds the files itself, proposes edits, and you accept or reject each hunk before anything is written.</div>';
    if (nearBottom) log.scrollTop = log.scrollHeight;
    const st = $("status");
    st.textContent = { idle: "idle", running: "running", awaiting_approval: "waiting for you", done: "done", error: "error", cancelled: "stopped" }[s.status] || s.status;
    st.className = `status ${s.status}`;
    const meta = [];
    if (s.agent) meta.push(s.agent);
    if (s.model) meta.push(s.model);
    if (s.tokensIn) meta.push(`${s.tokensIn} in / ${s.tokensOut || 0} out`);
    $("meta").textContent = meta.join(" · ");
    $("session").style.display = s.sessionId ? "" : "none";
    $("stop").disabled = !running;
    $("send").disabled = running;
    $("health").textContent = msg.health || "";
    $("health").style.display = msg.health ? "" : "none";
    $("approvals").innerHTML = msg.approvals
      .map((a) => `<div class="approval"><div><b>Approve ${esc(a.name)}?</b><pre>${esc(a.detail)}</pre></div><div class="row"><button class="btn primary" data-approve="${a.id}" data-ok="1">Approve</button><button class="btn" data-approve="${a.id}" data-ok="0">Deny</button></div></div>`)
      .join("");
    $("reviewbar").innerHTML = msg.pendingReviews ? `<button class="btn primary wide" id="review">Review ${msg.pendingReviews} proposed change(s) →</button>` : "";
  }

  log.addEventListener(
    "toggle",
    (e) => {
      const d = e.target;
      if (!d.dataset || !d.dataset.key) return;
      if (d.open) {
        open.add(d.dataset.key);
        open.delete(d.dataset.key + ":closed");
      } else {
        open.delete(d.dataset.key);
        open.add(d.dataset.key + ":closed");
      }
    },
    true,
  );
  document.body.addEventListener("click", (e) => {
    const t = e.target;
    if (t.id === "send") send();
    else if (t.id === "stop") vscode.postMessage({ type: "stop" });
    else if (t.id === "new") vscode.postMessage({ type: "new" });
    else if (t.id === "session") vscode.postMessage({ type: "session" });
    else if (t.id === "review") vscode.postMessage({ type: "review" });
    else if (t.dataset && t.dataset.approve) vscode.postMessage({ type: "approval", id: Number(t.dataset.approve), ok: t.dataset.ok === "1" });
    else if (t.dataset && t.dataset.insert !== undefined) applySuggestion(t.dataset.insert);
  });

  function send() {
    const text = input.value.trim();
    if (!text || running) return;
    vscode.postMessage({ type: "send", text });
    input.value = "";
    $("suggest").innerHTML = "";
  }

  // @-mention completion
  function mentionPrefix() {
    const upto = input.value.slice(0, input.selectionStart);
    const m = /(^|\s)@([A-Za-z0-9_./-]*)$/.exec(upto);
    return m ? m[2] : null;
  }
  function applySuggestion(insert) {
    const pos = input.selectionStart;
    const upto = input.value.slice(0, pos).replace(/@([A-Za-z0-9_./-]*)$/, `@${insert} `);
    input.value = upto + input.value.slice(pos);
    input.focus();
    input.selectionStart = input.selectionEnd = upto.length;
    $("suggest").innerHTML = "";
  }
  input.addEventListener("input", () => {
    const p = mentionPrefix();
    if (p === null) $("suggest").innerHTML = "";
    else vscode.postMessage({ type: "suggest", prefix: p });
  });
  input.addEventListener("keydown", (e) => {
    const first = $("suggest").querySelector("[data-insert]");
    if ((e.key === "Tab" || e.key === "Enter") && first && mentionPrefix() !== null) {
      e.preventDefault();
      applySuggestion(first.dataset.insert);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
    if (e.key === "Escape") {
      if ($("suggest").innerHTML) $("suggest").innerHTML = "";
      else if (running) vscode.postMessage({ type: "stop" });
    }
  });

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "state") render(m);
    else if (m.type === "suggestions" && m.prefix === mentionPrefix()) {
      $("suggest").innerHTML = m.items.map((s) => `<div class="sug" data-insert="${esc(s.insert)}"><b data-insert="${esc(s.insert)}">${esc(s.label)}</b> <span data-insert="${esc(s.insert)}">${esc(s.detail)}</span></div>`).join("");
    } else if (m.type === "focus") input.focus();
  });
  vscode.postMessage({ type: "ready" });
})();
