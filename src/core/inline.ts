/** Build the message for an inline edit: the selection, its surroundings and a tight instruction. Pure. */
export interface InlineRequest {
  path: string;
  fullText: string;
  /** 1-based inclusive line range of the selection. */
  startLine: number;
  endLine: number;
  instruction: string;
}

export function buildInlineMessage(r: InlineRequest, contextLines = 20): string {
  const lines = r.fullText.split(/\r?\n/);
  const s = Math.max(1, r.startLine);
  const e = Math.min(lines.length, Math.max(s, r.endLine));
  const from = Math.max(1, s - contextLines);
  const to = Math.min(lines.length, e + contextLines);
  const numbered = (a: number, b: number) =>
    lines
      .slice(a - 1, b)
      .map((l, i) => `${String(a + i).padStart(5)}  ${l}`)
      .join("\n");
  return [
    `INLINE EDIT of ${r.path}, lines ${s}-${e}.`,
    `Instruction: ${r.instruction}`,
    "",
    `Change only the selected lines (${s}-${e}). Call propose_edit once for ${r.path} using edits whose old_text is copied exactly from the selected region below (without the line-number prefix). Do not touch anything outside the selection, do not explore the repository, and do not run commands.`,
    "",
    `<selection path="${r.path}" lines="${s}-${e}">`,
    lines.slice(s - 1, e).join("\n"),
    "</selection>",
    "",
    `<surrounding path="${r.path}" lines="${from}-${to}">`,
    numbered(from, to),
    "</surrounding>",
  ].join("\n");
}

/** Retrieval query for an inline edit: the instruction plus the identifiers in the selection, so callers, tests and docs of the selected code are found. */
export function inlineContextQuery(r: InlineRequest): string {
  const lines = r.fullText.split(/\r?\n/).slice(Math.max(0, r.startLine - 1), r.endLine);
  const ids = new Set<string>();
  for (const m of lines.join("\n").matchAll(/[A-Za-z_][A-Za-z0-9_]{3,}/g)) ids.add(m[0]);
  const keywords = new Set(["return", "import", "from", "class", "self", "None", "True", "False", "bool", "else", "elif", "with", "pass", "raise", "function", "const", "this"]);
  return `${r.instruction} ${[...ids].filter((w) => !keywords.has(w)).slice(0, 24).join(" ")}`;
}

export interface TextEdit {
  edits: Array<{ old_text: string; new_text: string }>;
  /** How the edit was recovered, shown to the user. */
  how: "tool call written as text" | "code block in the reply";
}

function editsFrom(value: unknown): TextEdit["edits"] | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  for (const candidate of [v, v.arguments, v.input, v.parameters, v.args]) {
    if (!candidate || typeof candidate !== "object") continue;
    const edits = (candidate as { edits?: unknown }).edits;
    if (Array.isArray(edits) && edits.length > 0 && edits.every((e) => e && typeof e.old_text === "string" && typeof e.new_text === "string" && e.old_text !== "")) {
      return edits.map((e) => ({ old_text: e.old_text as string, new_text: e.new_text as string }));
    }
  }
  return null;
}

/**
 * Recover an inline edit from a reply when the model answered in text instead of calling
 * `propose_edit` (common with small or local models that lack native tool calling). Pure.
 * Prefers a propose_edit call spelled out as JSON; otherwise the last fenced code block is
 * taken as the replacement for the selected lines. The result still goes through the
 * normal per-hunk review, so nothing is written unless the user accepts it.
 */
export function extractTextEdit(reply: string, selection: string): TextEdit | null {
  const blocks = [...reply.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  // 1. A tool call written as JSON, fenced or bare.
  const jsonCandidates = [...blocks, ...[...reply.matchAll(/\{[\s\S]*\}/g)].map((m) => m[0])];
  for (const c of jsonCandidates.reverse()) {
    try {
      const edits = editsFrom(JSON.parse(c.trim()));
      if (edits) return { edits, how: "tool call written as text" };
    } catch {
      /* not JSON */
    }
  }
  // 2. The last code block that is not JSON: the rewritten selection.
  for (const b of blocks.reverse()) {
    const body = b.replace(/\s+$/, "");
    if (!body.trim() || /^\s*[{[]/.test(body)) continue;
    if (body === selection.replace(/\s+$/, "")) return null;
    return { edits: [{ old_text: selection, new_text: body }], how: "code block in the reply" };
  }
  return null;
}
