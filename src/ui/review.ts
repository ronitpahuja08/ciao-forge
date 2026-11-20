import * as vscode from "vscode";
import type { FileIO, Proposal, ProposalStore } from "../core/store";

const SCHEME = "ciao-forge";

/**
 * Diff review in the editor.
 *  - A review tab lists every hunk of every pending proposal with its own
 *    Accept / Reject buttons and a red/green preview.
 *  - The real file shows the same hunks in place: affected lines are
 *    highlighted and a CodeLens above each offers Accept / Reject.
 *  - "Side-by-side" opens VS Code's native diff of original vs. proposed.
 * Nothing is written until the hunks of a proposal are all decided.
 */
export class ReviewController implements vscode.CodeLensProvider, vscode.TextDocumentContentProvider {
  private panel: vscode.WebviewPanel | undefined;
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  private readonly contentEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.contentEmitter.event;
  private readonly removedDeco: vscode.TextEditorDecorationType;
  private readonly anchorDeco: vscode.TextEditorDecorationType;
  private lastMessage = "";

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: ProposalStore,
    private readonly io: FileIO,
  ) {
    this.removedDeco = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.anchorDeco = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      border: "1px dashed",
      borderColor: new vscode.ThemeColor("editorGutter.addedBackground"),
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    ctx.subscriptions.push(
      this.removedDeco,
      this.anchorDeco,
      vscode.languages.registerCodeLensProvider({ scheme: "file" }, this),
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, this),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
      { dispose: store.onChange(() => this.refresh()) },
    );
  }

  // ---- CodeLens + decorations in the real file ----
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const out: vscode.CodeLens[] = [];
    for (const p of this.store.pending()) {
      if (p.abs.toLowerCase() !== doc.uri.fsPath.toLowerCase()) continue;
      p.hunks.forEach((h, i) => {
        if (p.decisions[i] !== "pending") return;
        const line = Math.min(Math.max(0, h.origStart), Math.max(0, doc.lineCount - 1));
        const range = new vscode.Range(line, 0, line, 0);
        out.push(
          new vscode.CodeLens(range, { title: `$(check) Accept hunk ${i + 1}/${p.hunks.length}`, command: "ciaoForge.acceptHunk", arguments: [p.id, i] }),
          new vscode.CodeLens(range, { title: "$(x) Reject", command: "ciaoForge.rejectHunk", arguments: [p.id, i] }),
          new vscode.CodeLens(range, { title: `-${h.removed.length} +${h.added.length} · preview`, command: "ciaoForge.reviewProposals", arguments: [p.id] }),
        );
      });
    }
    return out;
  }

  private decorate(): void {
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.scheme !== "file") continue;
      const removed: vscode.DecorationOptions[] = [];
      const anchors: vscode.DecorationOptions[] = [];
      for (const p of this.store.pending()) {
        if (p.abs.toLowerCase() !== ed.document.uri.fsPath.toLowerCase()) continue;
        p.hunks.forEach((h, i) => {
          if (p.decisions[i] !== "pending") return;
          const hover = new vscode.MarkdownString(`**cIAo Forge proposes** (hunk ${i + 1})\n\n\`\`\`diff\n${h.removed.map((l) => `- ${l}`).join("\n")}\n${h.added.map((l) => `+ ${l}`).join("\n")}\n\`\`\``);
          const last = Math.max(0, ed.document.lineCount - 1);
          if (h.removed.length) {
            removed.push({ range: new vscode.Range(Math.min(h.origStart, last), 0, Math.min(h.origStart + h.removed.length - 1, last), 0), hoverMessage: hover });
          } else {
            const at = Math.min(Math.max(0, h.origStart - 1), last);
            anchors.push({ range: new vscode.Range(at, 0, at, 0), hoverMessage: hover });
          }
        });
      }
      ed.setDecorations(this.removedDeco, removed);
      ed.setDecorations(this.anchorDeco, anchors);
    }
  }

  // ---- virtual documents for the native side-by-side diff ----
  provideTextDocumentContent(uri: vscode.Uri): string {
    const [id, side] = uri.query.split(":");
    const p = this.store.get(id);
    if (!p) return "";
    return side === "original" ? (p.original ?? "") : p.proposed;
  }

  async openNativeDiff(id: string): Promise<void> {
    const p = this.store.get(id);
    if (!p) return;
    const left = vscode.Uri.from({ scheme: SCHEME, path: `/${p.path}`, query: `${p.id}:original` });
    const right = vscode.Uri.from({ scheme: SCHEME, path: `/${p.path}`, query: `${p.id}:proposed` });
    await vscode.commands.executeCommand("vscode.diff", left, right, `${p.path}: current ↔ proposed (cIAo Forge)`, { preview: true, viewColumn: vscode.ViewColumn.Active });
  }

  // ---- the review tab ----
  /** Show a proposal for review. Resolves when every hunk is decided or the proposal is discarded. */
  async review(p: Proposal): Promise<void> {
    await this.show(p.id);
    await this.store.waitForDecision(p.id);
  }

  async show(focusId?: string): Promise<void> {
    const focus = focusId ? this.store.get(focusId) : this.store.awaiting()[0];
    // Open the real file first (left), then the review tab beside it.
    if (focus && focus.original !== null && focus.status === "pending") {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(focus.abs));
        const first = focus.hunks[0]?.origStart ?? 0;
        const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false });
        const line = Math.min(first, Math.max(0, doc.lineCount - 1));
        ed.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      } catch {
        /* the review tab alone is enough */
      }
    }
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel("ciaoForge.review", "cIAo Forge Review", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "media")] });
      this.panel.onDidDispose(() => (this.panel = undefined), null, this.ctx.subscriptions);
      this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m), null, this.ctx.subscriptions);
      this.panel.webview.html = this.html(this.panel.webview);
    } else {
      this.panel.reveal(undefined, true);
    }
    this.refresh(focusId);
  }

  private async onMessage(m: { type: string; id?: string; hunk?: number; change?: string }): Promise<void> {
    switch (m.type) {
      case "accept":
        if (m.id !== undefined && m.hunk !== undefined) this.store.decide(m.id, m.hunk, "accepted");
        break;
      case "reject":
        if (m.id !== undefined && m.hunk !== undefined) this.store.decide(m.id, m.hunk, "rejected");
        break;
      case "acceptAll":
        if (m.id) this.store.decideAll(m.id, "accepted");
        break;
      case "rejectAll":
        if (m.id) this.store.decideAll(m.id, "rejected");
        break;
      case "nativeDiff":
        if (m.id) await this.openNativeDiff(m.id);
        break;
      case "undo":
        await this.undo(m.change);
        break;
      case "ready":
        this.refresh();
        break;
    }
  }

  async undo(changeId?: string): Promise<boolean> {
    const r = changeId ? await this.store.undo(changeId, this.io) : await this.store.undoLast(this.io);
    this.lastMessage = r.message;
    if (r.ok) void vscode.window.setStatusBarMessage(`cIAo Forge: ${r.message}`, 5000);
    else void vscode.window.showWarningMessage(`cIAo Forge: ${r.message}`);
    this.refresh();
    return r.ok;
  }

  private refresh(focusId?: string): void {
    this.lensEmitter.fire();
    this.decorate();
    if (!this.panel) return;
    const proposals = this.store
      .all()
      .filter((p) => p.status === "pending" || Date.now() - p.createdAt < 30 * 60_000)
      .slice(-12)
      .map((p) => ({
        id: p.id,
        path: p.path,
        status: p.status,
        isNew: p.original === null,
        rationale: p.rationale,
        source: p.source,
        hunks: p.hunks.map((h, i) => ({ id: i, start: h.origStart + 1, removed: h.removed, added: h.added, before: h.before, after: h.after, decision: p.decisions[i] })),
      }));
    const applied = this.store
      .appliedChanges()
      .slice(-12)
      .map((c) => ({ id: c.id, path: c.path, hunksApplied: c.hunksApplied, hunksTotal: c.hunksTotal, undone: c.undone, created: c.before === null }));
    void this.panel.webview.postMessage({ type: "state", proposals, applied, focusId, message: this.lastMessage });
  }

  private html(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", "style.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", "review.js"));
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head>
<body class="review"><div id="root"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
  }
}
