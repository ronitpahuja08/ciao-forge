/** Line-level diff, hunk grouping and selective application. Pure functions. */

export interface Hunk {
  id: number;
  /** 0-based index of the first original line this hunk replaces. */
  origStart: number;
  /** Original lines removed by this hunk. */
  removed: string[];
  /** Lines inserted in their place. */
  added: string[];
  /** Up to 3 unchanged lines before and after, for display only. */
  before: string[];
  after: string[];
}

export function splitLines(text: string): string[] {
  return text.split("\n");
}

/** Myers-style LCS over lines using a DP table trimmed by common prefix/suffix. */
function lcsOps(a: string[], b: string[]): Array<{ op: "eq" | "del" | "add"; line: string }> {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: Array<{ op: "eq" | "del" | "add"; line: string }> = [];
  for (let i = 0; i < start; i++) ops.push({ op: "eq", line: a[i] });
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  const n = A.length;
  const m = B.length;
  if (n * m > 4_000_000) {
    // Pathologically large middle: fall back to replace-all for that region.
    for (const l of A) ops.push({ op: "del", line: l });
    for (const l of B) ops.push({ op: "add", line: l });
  } else {
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) {
        ops.push({ op: "eq", line: A[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        ops.push({ op: "del", line: A[i++] });
      } else {
        ops.push({ op: "add", line: B[j++] });
      }
    }
    while (i < n) ops.push({ op: "del", line: A[i++] });
    while (j < m) ops.push({ op: "add", line: B[j++] });
  }
  for (let i = endA; i < a.length; i++) ops.push({ op: "eq", line: a[i] });
  return ops;
}

/** Compute hunks: maximal runs of changed lines, each separated by at least one unchanged line. */
export function computeHunks(original: string, proposed: string): Hunk[] {
  const a = splitLines(original);
  const b = splitLines(proposed);
  const ops = lcsOps(a, b);
  const hunks: Hunk[] = [];
  let origIdx = 0;
  let cur: Hunk | null = null;
  for (const o of ops) {
    if (o.op === "eq") {
      if (cur) {
        hunks.push(cur);
        cur = null;
      }
      origIdx++;
      continue;
    }
    if (!cur) cur = { id: hunks.length, origStart: origIdx, removed: [], added: [], before: [], after: [] };
    if (o.op === "del") {
      cur.removed.push(o.line);
      origIdx++;
    } else {
      cur.added.push(o.line);
    }
  }
  if (cur) hunks.push(cur);
  for (const h of hunks) {
    h.before = a.slice(Math.max(0, h.origStart - 3), h.origStart);
    const end = h.origStart + h.removed.length;
    h.after = a.slice(end, end + 3);
  }
  return hunks;
}

/** Apply only the hunks whose ids are in `accepted`, leaving the rest of the original untouched. */
export function applyHunks(original: string, hunks: Hunk[], accepted: Iterable<number>): string {
  const keep = new Set(accepted);
  const a = splitLines(original);
  const out: string[] = [];
  let idx = 0;
  for (const h of [...hunks].sort((x, y) => x.origStart - y.origStart)) {
    while (idx < h.origStart) out.push(a[idx++]);
    if (keep.has(h.id)) {
      out.push(...h.added);
      idx += h.removed.length;
    }
  }
  while (idx < a.length) out.push(a[idx++]);
  return out.join("\n");
}

export interface SearchReplace {
  old_text: string;
  new_text: string;
}

export class EditError extends Error {}

/** How an edit's old_text was located. Anything but "exact" is reported back to the model and shown to the user in the diff. */
export type MatchKind = "exact" | "whitespace" | "quotes";

const norm = (line: string, quotes: boolean): string => {
  const t = line.trim().replace(/\s+/g, " ");
  return quotes ? t.replace(/['"`]/g, '"') : t;
};

/** Find a unique run of lines equal to `want` after normalisation. Returns [startLine, endLineExclusive] or a failure reason. */
function locateLines(haystack: string[], want: string[], quotes: boolean): [number, number] | "none" | "ambiguous" {
  const w = want.map((l) => norm(l, quotes));
  while (w.length && w[0] === "") w.shift();
  while (w.length && w[w.length - 1] === "") w.pop();
  if (w.length === 0) return "none";
  const h = haystack.map((l) => norm(l, quotes));
  let found: [number, number] | undefined;
  for (let i = 0; i + w.length <= h.length; i++) {
    let ok = true;
    for (let j = 0; j < w.length; j++) {
      if (h[i + j] !== w[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      if (found) return "ambiguous";
      found = [i, i + w.length];
    }
  }
  return found ?? "none";
}

/** The line of the file that shares the most words with old_text, to help the model correct itself. */
function closestHint(text: string, oldText: string): string {
  const words = new Set(oldText.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
  if (words.size === 0) return "";
  const lines = text.split(/\r?\n/);
  let best = -1;
  let bestScore = 0;
  lines.forEach((l, i) => {
    const ws = l.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
    const score = ws.filter((x) => words.has(x)).length;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  if (best < 0 || bestScore < 2) return "";
  const from = Math.max(0, best - 1);
  const to = Math.min(lines.length, best + 2);
  return ` The closest text in the file is at line ${best + 1}:\n${lines.slice(from, to).join("\n")}`;
}

export interface ReplaceResult {
  text: string;
  /** One entry per edit that was not an exact match. */
  notes: string[];
}

/**
 * Apply search/replace edits to text. Each `old_text` must identify exactly one
 * place, so the model cannot silently edit the wrong spot or a symbol that is
 * not there. If the exact text is not found, a line-wise match that ignores
 * indentation/spacing (then quote style) is tried; it must still be unique, the
 * whole matched lines are replaced, and the approximation is reported. Nothing
 * is written by this function: the result is only ever shown as a diff.
 */
export function applySearchReplaceDetailed(text: string, edits: SearchReplace[]): ReplaceResult {
  let out = text;
  const notes: string[] = [];
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  edits.forEach((e, i) => {
    if (typeof e?.old_text !== "string" || typeof e?.new_text !== "string") throw new EditError(`edit ${i + 1}: old_text and new_text are required strings`);
    let oldT = e.old_text;
    let newT = e.new_text;
    if (eol === "\r\n") {
      oldT = oldT.replace(/\r?\n/g, "\r\n");
      newT = newT.replace(/\r?\n/g, "\r\n");
    }
    if (oldT === "") throw new EditError(`edit ${i + 1}: old_text is empty; use new_content to create or fully rewrite a file`);
    const first = out.indexOf(oldT);
    if (first >= 0) {
      if (out.indexOf(oldT, first + 1) >= 0) throw new EditError(`edit ${i + 1}: old_text matches more than one place. Include more surrounding lines so it is unique.`);
      out = out.slice(0, first) + newT + out.slice(first + oldT.length);
      return;
    }
    // Approximate, line-based location. Only whole lines can be matched this way.
    const lines = out.split(eol);
    const want = oldT.split(eol);
    let kind: MatchKind = "whitespace";
    let loc = locateLines(lines, want, false);
    if (loc === "none") {
      kind = "quotes";
      loc = locateLines(lines, want, true);
    }
    if (loc === "ambiguous") throw new EditError(`edit ${i + 1}: old_text matches more than one place. Include more surrounding lines so it is unique.`);
    if (loc === "none") {
      throw new EditError(`edit ${i + 1}: old_text was not found in the file. Copy the exact text of whole lines from the file, including indentation and quote style.${closestHint(out, e.old_text)}`);
    }
    // Re-indent the replacement to the real indentation of the matched block.
    const realIndent = /^[ \t]*/.exec(lines[loc[0]])?.[0] ?? "";
    const newLines = newT.split(eol);
    while (newLines.length > 1 && newLines[0].trim() === "") newLines.shift();
    while (newLines.length > 1 && newLines[newLines.length - 1].trim() === "") newLines.pop();
    const givenIndent = /^[ \t]*/.exec(newLines.find((l) => l.trim() !== "") ?? "")?.[0] ?? "";
    const fixed = newLines.map((l) => (l.trim() === "" ? l : l.startsWith(givenIndent) ? realIndent + l.slice(givenIndent.length) : l));
    // A partial-line old_text must not swallow the rest of the line: only accept whole-line matches.
    out = [...lines.slice(0, loc[0]), ...fixed, ...lines.slice(loc[1])].join(eol);
    notes.push(`edit ${i + 1} was located at lines ${loc[0] + 1}-${loc[1]} ignoring ${kind === "quotes" ? "quote style and spacing" : "indentation/spacing"}; the whole matched lines were replaced`);
  });
  return { text: out, notes };
}

export function applySearchReplace(text: string, edits: SearchReplace[]): string {
  return applySearchReplaceDetailed(text, edits).text;
}

export function hunkSummary(h: Hunk): string {
  const from = h.origStart + 1;
  return `@@ line ${from} · -${h.removed.length} +${h.added.length}`;
}
