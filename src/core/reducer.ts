/** Pure reducer: TrueForge streaming events (plus a few local ones) -> the state the panel renders. */

export type RunStatus = "idle" | "running" | "awaiting_approval" | "done" | "error" | "cancelled";
export type ToolStatus = "calling" | "awaiting_approval" | "running" | "done" | "denied";

export interface ToolItem {
  kind: "tool";
  id: string;
  name: string;
  args: string;
  status: ToolStatus;
  result?: string;
  thread: string;
  messageId: string;
  index: number;
}
export interface TextItem {
  kind: "assistant";
  id: string;
  text: string;
  thread: string;
}
export interface UserItem {
  kind: "user";
  text: string;
}
export interface NoticeItem {
  kind: "notice";
  level: "info" | "warn" | "error" | "ok";
  text: string;
}
export interface ContextItem {
  kind: "context";
  source: "auto" | "tool";
  summary: string;
  rows: Array<{ path: string; ranges: string; tokens: number; score: string; reason: string }>;
  omitted: string[];
}
export type Item = ToolItem | TextItem | UserItem | NoticeItem | ContextItem;

export interface ViewState {
  status: RunStatus;
  items: Item[];
  sessionId?: string;
  turnId?: string;
  agent?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  threads: Record<string, string>;
}

export const initialState = (): ViewState => ({ status: "idle", items: [], threads: {} });

export type LocalEvent =
  | { type: "local.user"; text: string }
  | { type: "local.notice"; level: NoticeItem["level"]; text: string }
  | { type: "local.context"; item: Omit<ContextItem, "kind"> }
  | { type: "local.status"; status: RunStatus }
  | { type: "local.session"; sessionId: string; agent: string }
  | { type: "local.tool_status"; id: string; status: ToolStatus; result?: string }
  | { type: "local.reset" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEvent = LocalEvent | { type: string; [k: string]: any };

function upsertText(items: Item[], id: string, thread: string, add: string): Item[] {
  const i = items.findIndex((x) => x.kind === "assistant" && x.id === id);
  if (i < 0) return [...items, { kind: "assistant", id, text: add, thread }];
  const cur = items[i] as TextItem;
  const next = [...items];
  next[i] = { ...cur, text: cur.text + add };
  return next;
}

export function reduce(state: ViewState, ev: AnyEvent): ViewState {
  switch (ev.type) {
    case "local.reset":
      return initialState();
    case "local.user":
      return { ...state, items: [...state.items, { kind: "user", text: ev.text }] };
    case "local.notice":
      return { ...state, items: [...state.items, { kind: "notice", level: ev.level, text: ev.text }] };
    case "local.context":
      return { ...state, items: [...state.items, { kind: "context", ...ev.item }] };
    case "local.status":
      return { ...state, status: ev.status };
    case "local.session":
      return { ...state, sessionId: ev.sessionId, agent: ev.agent };
    case "local.tool_status":
      return { ...state, items: state.items.map((x) => (x.kind === "tool" && x.id === ev.id ? { ...x, status: ev.status, result: ev.result ?? x.result } : x)) };

    case "turn.created":
      return { ...state, status: "running", turnId: ev.turnId };
    case "thread.created":
      return {
        ...state,
        threads: { ...state.threads, [ev.threadId]: ev.title ?? ev.agentInfo?.name ?? "subagent" },
        items: [...state.items, { kind: "notice", level: "info", text: `Subagent started: ${ev.title ?? ev.agentInfo?.name ?? ev.threadId}` }],
      };
    case "thread.done":
      if (ev.threadId === "main") return state;
      return { ...state, items: [...state.items, { kind: "notice", level: "info", text: `Subagent finished: ${ev.title ?? ev.threadId}` }] };
    case "model.message":
      return { ...state, model: ev.model?.name ?? state.model };
    case "model.message.delta": {
      let items = state.items;
      const thread = ev.threadId ?? "main";
      if (typeof ev.content === "string" && ev.content.length) items = upsertText(items, ev.id, thread, ev.content);
      for (const tc of ev.toolCalls ?? []) {
        const idx = items.findIndex((x) => x.kind === "tool" && x.messageId === ev.id && x.index === tc.index);
        if (idx < 0) {
          items = [...items, { kind: "tool", id: tc.id ?? `${ev.id}:${tc.index}`, name: tc.function?.name ?? tc.toolInfo?.name ?? "tool", args: tc.function?.arguments ?? "", status: "calling", thread, messageId: ev.id, index: tc.index }];
        } else {
          const cur = items[idx] as ToolItem;
          const next = [...items];
          next[idx] = { ...cur, id: tc.id ?? cur.id, name: tc.function?.name || cur.name, args: cur.args + (tc.function?.arguments ?? "") };
          items = next;
        }
      }
      const usage = ev.usage;
      return { ...state, items, tokensIn: usage?.inputTokens ?? state.tokensIn, tokensOut: usage?.outputTokens ?? state.tokensOut };
    }
    case "tool.approval_required": {
      const ids = new Set((ev.toolCalls ?? []).map((t: { id: string }) => t.id));
      return { ...state, status: "awaiting_approval", items: state.items.map((x) => (x.kind === "tool" && ids.has(x.id) ? { ...x, status: "awaiting_approval" as const } : x)) };
    }
    case "user.tool_approval": {
      const denied = ev.approval?.status === "deny";
      return { ...state, status: "running", items: state.items.map((x) => (x.kind === "tool" && x.id === ev.toolCallId ? { ...x, status: denied ? ("denied" as const) : ("running" as const) } : x)) };
    }
    case "tool.response":
      return { ...state, items: state.items.map((x) => (x.kind === "tool" && x.id === ev.toolCallId ? { ...x, status: x.status === "denied" ? x.status : ("done" as const), result: String(ev.content ?? "") } : x)) };
    case "thread.context_compaction_started":
      return { ...state, items: [...state.items, { kind: "notice", level: "info", text: "TrueForge is compacting older context to stay within the model window…" }] };
    case "thread.context_compaction_finished":
      return { ...state, items: [...state.items, { kind: "notice", level: "info", text: "Context compaction finished." }] };
    case "turn.update": {
      const m = ev.state?.metrics;
      return { ...state, status: ev.state?.status === "paused" ? "awaiting_approval" : state.status === "awaiting_approval" ? "running" : state.status, tokensIn: m?.totalInputTokens ?? state.tokensIn, tokensOut: m?.totalOutputTokens ?? state.tokensOut };
    }
    case "turn.done": {
      const m = ev.state?.metrics;
      // Terminal status is set by the runner, which knows about retries and fallback.
      return { ...state, tokensIn: m?.totalInputTokens ?? state.tokensIn, tokensOut: m?.totalOutputTokens ?? state.tokensOut };
    }
    default:
      return state;
  }
}

/** Find an accumulated tool call by id. */
export function findTool(state: ViewState, id: string): ToolItem | undefined {
  return state.items.find((x): x is ToolItem => x.kind === "tool" && x.id === id);
}
