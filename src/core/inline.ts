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
