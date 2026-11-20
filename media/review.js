// Review tab: every hunk of every proposal with its own Accept / Reject.
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  let lastFocus = null;

  function line(cls, sign, no, text) {
    return `<div class="dl ${cls}"><span class="no">${no}</span><span class="sign">${sign}</span><span class="tx">${esc(text) || "&nbsp;"}</span></div>`;
  }

  function hunkHtml(p, h) {
    let n = h.start - h.before.length;
    const rows = [];
    for (const t of h.before) rows.push(line("ctx", " ", n++, t));
    let r = h.start;
    for (const t of h.removed) rows.push(line("del", "-", r++, t));
    for (const t of h.added) rows.push(line("add", "+", "", t));
    for (const t of h.after) rows.push(line("ctx", " ", r++, t));
    const decided = h.decision !== "pending";
    const buttons =
      p.status === "pending"
        ? `<button class="btn ok ${h.decision === "accepted" ? "on" : ""}" data-act="accept" data-id="${p.id}" data-hunk="${h.id}">✓ Accept hunk</button>
           <button class="btn no ${h.decision === "rejected" ? "on" : ""}" data-act="reject" data-id="${p.id}" data-hunk="${h.id}">✗ Reject hunk</button>`
        : "";
    return `<div class="hunk ${h.decision}">
      <div class="hunk-head"><span class="hunk-title">Hunk ${h.id + 1} · line ${h.start} · <span class="minus">-${h.removed.length}</span> <span class="plus">+${h.added.length}</span></span>
      <span class="hunk-state">${decided ? (h.decision === "accepted" ? "accepted" : "rejected") : "awaiting your decision"}</span>
      <span class="spacer"></span>${buttons}</div>
      <div class="diff">${rows.join("")}</div></div>`;
  }

  function proposalHtml(p) {
    const pendingCount = p.hunks.filter((h) => h.decision === "pending").length;
    const label = { pending: `${pendingCount} of ${p.hunks.length} hunk(s) awaiting review`, applied: "applied", rejected: "rejected, nothing written", stale: "file changed on disk, nothing written", discarded: "discarded (run cancelled), nothing written" }[p.status];
    const actions =
      p.status === "pending"
        ? `<button class="btn ok" data-act="acceptAll" data-id="${p.id}">Accept all</button>
           <button class="btn no" data-act="rejectAll" data-id="${p.id}">Reject all</button>
           <button class="btn" data-act="nativeDiff" data-id="${p.id}">Side-by-side</button>`
        : `<button class="btn" data-act="nativeDiff" data-id="${p.id}">Side-by-side</button>`;
    return `<section class="proposal ${p.status}" id="prop-${p.id}">
      <header><span class="path">${esc(p.path)}</span>${p.isNew ? '<span class="tag">new file</span>' : ""}<span class="tag ${p.status}">${label}</span><span class="spacer"></span>${actions}</header>
      ${p.rationale ? `<div class="rationale">${esc(p.rationale)}</div>` : ""}
      ${p.status === "pending" ? '<div class="hint">Nothing has been written to disk. Only the hunks you accept will be applied.</div>' : ""}
      ${p.hunks.map((h) => hunkHtml(p, h)).join("")}
    </section>`;
  }

  function render(state) {
    const pending = state.proposals.filter((p) => p.status === "pending");
    const done = state.proposals.filter((p) => p.status !== "pending").reverse();
    const applied = [...state.applied].reverse();
    const appliedHtml = applied.length
      ? `<section class="applied"><h3>Applied changes</h3>${applied
          .map(
            (c) => `<div class="applied-row ${c.undone ? "undone" : ""}"><span class="path">${esc(c.path)}</span>
              <span class="tag">${c.created ? "created" : `${c.hunksApplied}/${c.hunksTotal} hunks`}</span>
              <span class="spacer"></span>
              ${c.undone ? '<span class="tag">undone</span>' : `<button class="btn" data-act="undo" data-change="${c.id}">↶ Undo</button>`}</div>`,
          )
          .join("")}</section>`
      : "";
    root.innerHTML = `
      <h2>Review proposed changes</h2>
      ${state.message ? `<div class="msg">${esc(state.message)}</div>` : ""}
      ${pending.length ? pending.map(proposalHtml).join("") : '<div class="empty">No changes are waiting for review.</div>'}
      ${appliedHtml}
      ${done.length ? `<details class="history"><summary>Reviewed in this session (${done.length})</summary>${done.map(proposalHtml).join("")}</details>` : ""}`;
    const focus = state.focusId || (pending[0] && pending[0].id);
    if (focus && focus !== lastFocus) {
      lastFocus = focus;
      const el = document.getElementById(`prop-${focus}`);
      if (el) el.scrollIntoView({ block: "start" });
    }
  }

  root.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    vscode.postMessage({ type: b.dataset.act, id: b.dataset.id, hunk: b.dataset.hunk !== undefined ? Number(b.dataset.hunk) : undefined, change: b.dataset.change });
  });
  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "state") render(e.data);
  });
  vscode.postMessage({ type: "ready" });
})();
