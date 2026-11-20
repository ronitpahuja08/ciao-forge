import * as vscode from "vscode";
import type { ViewState } from "../core/reducer";

export interface PanelActions {
  send(text: string): void;
  stop(): void;
  newChat(): void;
  openSession(): void;
  review(): void;
  undo(): void;
  suggest(prefix: string): Array<{ label: string; detail: string; insert: string }>;
}

interface PendingApproval {
  id: number;
  name: string;
  detail: string;
  resolve(ok: boolean): void;
}

/** The agent panel: prompt box, streamed transcript, tool timeline, context table, Stop. */
export class AgentPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private state: ViewState | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private approvals: PendingApproval[] = [];
  private approvalSeq = 0;
  private pendingReviews = 0;
  private health = "";

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly actions: PanelActions,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "media")] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: { type: string; text?: string; id?: number; ok?: boolean; prefix?: string }) => {
      switch (m.type) {
        case "ready":
          this.flush();
          break;
        case "send":
          if (m.text?.trim()) this.actions.send(m.text.trim());
          break;
        case "stop":
          this.actions.stop();
          break;
        case "new":
          this.actions.newChat();
          break;
        case "session":
          this.actions.openSession();
          break;
        case "review":
          this.actions.review();
          break;
        case "undo":
          this.actions.undo();
          break;
        case "approval": {
          const a = this.approvals.find((x) => x.id === m.id);
          if (a) {
            this.approvals = this.approvals.filter((x) => x !== a);
            a.resolve(m.ok === true);
            this.schedule();
          }
          break;
        }
        case "suggest":
          void view.webview.postMessage({ type: "suggestions", prefix: m.prefix, items: this.actions.suggest(m.prefix ?? "") });
          break;
      }
    });
    view.onDidDispose(() => (this.view = undefined));
  }

  /** Called on every runner state change; coalesced so streaming never floods the webview. */
  render(state: ViewState): void {
    this.state = state;
    this.schedule();
  }
  setPendingReviews(n: number): void {
    if (n !== this.pendingReviews) {
      this.pendingReviews = n;
      this.schedule();
    }
  }
  setHealth(text: string): void {
    this.health = text;
    this.schedule();
  }

  /** Ask for approval of a command in the panel. Falls back to a notification if the panel is closed. */
  approveTool(name: string, detail: string): Promise<boolean> {
    if (!this.view) {
      return Promise.resolve(vscode.window.showInformationMessage(`cIAo Forge wants to run: ${detail}`, { modal: false }, "Approve", "Deny")).then((c) => c === "Approve");
    }
    return new Promise<boolean>((resolve) => {
      this.approvals.push({ id: ++this.approvalSeq, name, detail, resolve });
      this.schedule();
    });
  }
  /** Resolve every open approval as denied (used on cancel). */
  denyAll(): void {
    for (const a of this.approvals) a.resolve(false);
    this.approvals = [];
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 40);
  }
  private flush(): void {
    if (!this.view) return;
    void this.view.webview.postMessage({
      type: "state",
      state: this.state ?? { status: "idle", items: [], threads: {} },
      approvals: this.approvals.map((a) => ({ id: a.id, name: a.name, detail: a.detail })),
      pendingReviews: this.pendingReviews,
      health: this.health,
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", "style.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", "panel.js"));
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head>
<body class="panel">
  <div id="top"><span id="status" class="status idle">idle</span><span id="meta"></span><span class="spacer"></span>
    <button id="session" class="link" title="Open this run in the TrueForge UI">TrueForge session ↗</button>
    <button id="new" class="link" title="Start a new conversation">New</button></div>
  <div id="health"></div>
  <div id="log"></div>
  <div id="approvals"></div>
  <div id="reviewbar"></div>
  <div id="composer">
    <div id="suggest"></div>
    <textarea id="input" rows="3" placeholder="Ask the agent to change something. Mention @file or @Symbol to pin context."></textarea>
    <div id="buttons"><span id="hint">Enter to send · Shift+Enter for a new line</span><span class="spacer"></span>
      <button id="stop" class="btn danger" disabled>■ Stop</button><button id="send" class="btn primary">Send</button></div>
  </div>
  <script nonce="${nonce}" src="${js}"></script>
</body></html>`;
  }
}
