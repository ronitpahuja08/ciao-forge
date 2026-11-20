import * as fs from "node:fs";
import * as path from "node:path";
import { isSensitivePath } from "./guards";

/**
 * Context assembly: decide what the model sees when the repository is larger
 * than its context window.
 *
 *  1. Explicit @file / @symbol mentions are pinned first.
 *  2. Everything else is retrieved automatically: the workspace is split into
 *     definition-sized chunks, scored with BM25 against the request, boosted
 *     when the path or a defined symbol matches, then widened with "companion"
 *     files (the test and the doc page that share a stem with a top hit).
 *  3. Excerpts are packed greedily into a fixed token budget, and every choice
 *     is recorded with a human-readable reason so the user can see why.
 */

export interface Chunk {
  path: string;
  startLine: number; // 1-based, inclusive
  endLine: number;
  text: string;
  symbols: string[];
  terms: Map<string, number>;
  length: number;
}

export interface WorkspaceIndex {
  root: string;
  chunks: Chunk[];
  files: string[];
  df: Map<string, number>;
  avgLen: number;
  totalTokens: number;
  symbols: Map<string, Array<{ path: string; line: number; chunk: number }>>;
  /** For each term, the number of files whose path contains it (path-level document frequency). */
  pathDf: Map<string, number>;
  pathTerms: Map<string, Set<string>>;
  builtAt: number;
}

export interface PlanItem {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  tokens: number;
  reason: string;
  kind: "mention" | "retrieved" | "companion";
  text: string;
}

export interface ContextPlan {
  query: string;
  budget: number;
  usedTokens: number;
  items: PlanItem[];
  /** Ranked files that did not fit in the budget. */
  omitted: Array<{ path: string; score: number; reason: string }>;
  unknownMentions: string[];
  indexedFiles: number;
  indexedTokens: number;
}

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "env", "dist", "build", "out", "__pycache__", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".idea", ".vscode", "site-packages", ".next", "target", "coverage", ".eggs"]);
const TEXT_EXT = new Set([".py", ".pyi", ".rst", ".md", ".txt", ".toml", ".cfg", ".ini", ".json", ".yaml", ".yml", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".html", ".css", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs", ".rb", ".php", ".sh", ".sql", ".jinja", ".j2"]);
const MAX_FILE_BYTES = 200_000;
const STOP = new Set("a an and are as at be by for from has have in is it its of on or that the to was were will with this these those not no but if then else so do does can could should would must may any all each other also into than them they their there here when which who what how why new add adds added make makes use used using get set via per it's i we you your our".split(" "));
const CANON: Record<string, string> = {
  configuration: "config", configurations: "config", configs: "config", configure: "config", configured: "config",
  documented: "doc", documentation: "doc", docs: "doc", document: "doc", documents: "doc",
  tests: "test", tested: "test", testing: "test",
  commands: "command", cmd: "command",
  masking: "mask", masked: "mask", masks: "mask",
  prints: "print", printed: "print", printing: "print",
  values: "value", keys: "key", secrets: "secret", passwords: "password", tokens: "token",
  loaded: "load", loads: "load", loading: "load",
  applications: "app", application: "app", apps: "app",
  builtin: "built",
};

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** Split identifiers (snake_case, camelCase, dotted.paths) into lower-case terms. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9_]+/)) {
    if (!raw) continue;
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[\s_]+/);
    for (const p of parts) {
      let t = p.toLowerCase();
      if (t.length < 2 || /^\d+$/.test(t) || STOP.has(t)) continue;
      t = CANON[t] ?? t;
      if (t.length > 4 && t.endsWith("s") && !t.endsWith("ss")) t = CANON[t.slice(0, -1)] ?? t.slice(0, -1);
      out.push(t);
    }
  }
  return out;
}

function termFreq(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

const DEF_RE: Array<{ exts: string[]; re: RegExp }> = [
  { exts: [".py", ".pyi"], re: /^(?:async\s+)?(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  { exts: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"], re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { exts: [".go"], re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/ },
  { exts: [".rs"], re: /^(?:pub\s+)?(?:fn|struct|enum|trait|impl)\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  { exts: [".java", ".kt", ".cs"], re: /^(?:public|private|protected|internal)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|enum|fun)\s+([A-Za-z_][A-Za-z0-9_]*)/ },
];
const NESTED_PY = /^\s+(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/;
const RST_HEADING = /^(={3,}|-{3,}|~{3,}|\^{3,})\s*$/;
const MAX_CHUNK_LINES = 60;

/** Split a file into chunks that follow top-level definitions (code) or headings (docs). */
export function chunkFile(rel: string, text: string): Array<Omit<Chunk, "terms" | "length">> {
  const ext = path.extname(rel).toLowerCase();
  const lines = text.split(/\r?\n/);
  const def = DEF_RE.find((d) => d.exts.includes(ext))?.re;
  const isDoc = ext === ".rst" || ext === ".md" || ext === ".txt";
  const starts: number[] = [0];
  for (let i = 1; i < lines.length; i++) {
    if (def && def.test(lines[i])) {
      // Pull decorators and the comment block directly above into the same chunk.
      let s = i;
      while (s > 0 && /^(@|#|\/\/|\/\*|\*)/.test(lines[s - 1])) s--;
      if (s > starts[starts.length - 1]) starts.push(s);
    } else if (isDoc && ext === ".md" && /^#{1,4}\s/.test(lines[i])) {
      starts.push(i);
    } else if (isDoc && ext === ".rst" && RST_HEADING.test(lines[i]) && i >= 1 && lines[i - 1].trim() !== "" && !RST_HEADING.test(lines[i - 1])) {
      // rst: the title is the line above the underline; include a label like ".. _name:" if present.
      let s = i - 1;
      while (s > 0 && (lines[s - 1].trim() === "" || /^\.\. _/.test(lines[s - 1])) && s - 1 > starts[starts.length - 1]) s--;
      if (s > starts[starts.length - 1]) starts.push(s);
    }
  }
  const out: Array<Omit<Chunk, "terms" | "length">> = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : lines.length;
    for (let s = from; s < to; s += MAX_CHUNK_LINES) {
      const e = Math.min(to, s + MAX_CHUNK_LINES);
      const body = lines.slice(s, e);
      if (body.join("").trim() === "") continue;
      const symbols: string[] = [];
      for (const l of body) {
        const m = (def && def.exec(l)) || (ext.startsWith(".py") ? NESTED_PY.exec(l) : null);
        if (m) symbols.push(m[1]);
      }
      out.push({ path: rel, startLine: s + 1, endLine: e, text: body.join("\n"), symbols });
    }
  }
  return out;
}

export function listWorkspaceFiles(root: string, limit = 5000): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    if (out.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= limit) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.endsWith(".egg-info")) continue;
        walk(path.join(dir, e.name), r);
      } else if (e.isFile()) {
        if (isSensitivePath(r)) continue; // never list, search or index secrets files
        out.push(r);
      }
    }
  };
  walk(root, "");
  return out;
}

export function isTextPath(rel: string): boolean {
  const ext = path.extname(rel).toLowerCase();
  return TEXT_EXT.has(ext) || /(^|\/)(Makefile|Dockerfile|LICENSE|README)[^/]*$/.test(rel);
}

export function buildIndex(root: string): WorkspaceIndex {
  const files = listWorkspaceFiles(root).filter(isTextPath);
  const chunks: Chunk[] = [];
  const df = new Map<string, number>();
  const symbols = new Map<string, Array<{ path: string; line: number; chunk: number }>>();
  let totalLen = 0;
  let totalTokens = 0;
  const indexed: string[] = [];
  for (const rel of files) {
    const abs = path.join(root, rel);
    let text: string;
    try {
      if (fs.statSync(abs).size > MAX_FILE_BYTES) continue;
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    indexed.push(rel);
    totalTokens += estimateTokens(text);
    for (const c of chunkFile(rel, text)) {
      const toks = tokenize(c.text);
      const terms = termFreq(toks);
      const chunk: Chunk = { ...c, terms, length: toks.length };
      const idx = chunks.push(chunk) - 1;
      totalLen += toks.length;
      for (const t of terms.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      for (const s of c.symbols) {
        const list = symbols.get(s) ?? [];
        const line = c.startLine + c.text.split("\n").findIndex((l) => new RegExp(`\\b${s.replace(/[$]/g, "\\$")}\\b`).test(l));
        list.push({ path: rel, line, chunk: idx });
        symbols.set(s, list);
      }
    }
  }
  const pathDf = new Map<string, number>();
  const pathTerms = new Map<string, Set<string>>();
  for (const rel of indexed) {
    const set = new Set(tokenize(rel.replace(/\.[^./]+$/, "")));
    pathTerms.set(rel, set);
    for (const t of set) pathDf.set(t, (pathDf.get(t) ?? 0) + 1);
  }
  return { root, chunks, files: indexed, df, avgLen: chunks.length ? totalLen / chunks.length : 1, totalTokens, symbols, pathDf, pathTerms, builtAt: Date.now() };
}

// ---------- mentions ----------

export interface Mentions {
  files: string[];
  symbols: Array<{ name: string; path: string; line: number; chunk: number }>;
  unknown: string[];
  /** The request with the @ markers removed, used as the retrieval query. */
  cleaned: string;
}

/** Parse `@path/to/file.py` and `@SymbolName` mentions and resolve them against the index. */
export function parseMentions(text: string, index: WorkspaceIndex): Mentions {
  const files: string[] = [];
  const symbols: Mentions["symbols"] = [];
  const unknown: string[] = [];
  const re = /(^|[\s(,;])@([A-Za-z0-9_./\\-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[2].replace(/[.,;:)]+$/, "").replace(/\\/g, "/");
    if (!raw) continue;
    const exact = index.files.find((f) => f === raw);
    const suffix = exact ? [exact] : index.files.filter((f) => f.endsWith(`/${raw}`) || path.basename(f) === raw);
    if (suffix.length === 1) {
      if (!files.includes(suffix[0])) files.push(suffix[0]);
      continue;
    }
    const name = raw.split(".").pop() ?? raw;
    const defs = index.symbols.get(name);
    if (defs && defs.length) {
      const pick = defs.find((d) => !/(^|\/)tests?\//.test(d.path)) ?? defs[0];
      if (!symbols.some((s) => s.name === name)) symbols.push({ name, ...pick });
      continue;
    }
    if (suffix.length > 1) {
      // Ambiguous file name: take the shortest path but say so.
      const pick = [...suffix].sort((a, b) => a.length - b.length)[0];
      if (!files.includes(pick)) files.push(pick);
      continue;
    }
    unknown.push(raw);
  }
  return { files, symbols, unknown, cleaned: text.replace(/(^|[\s(,;])@/g, "$1") };
}

// ---------- retrieval ----------

const K1 = 1.2;
const B = 0.75;

function idf(index: WorkspaceIndex, term: string): number {
  const n = index.df.get(term) ?? 0;
  return Math.log(1 + (index.chunks.length - n + 0.5) / (n + 0.5));
}

interface Scored {
  chunk: number;
  score: number;
  matched: string[];
  pathHits: string[];
  symbolHits: string[];
}

export function scoreChunks(index: WorkspaceIndex, query: string): Scored[] {
  const qTerms = [...new Set(tokenize(query))];
  const out: Scored[] = [];
  const nFiles = index.files.length;
  // Path terms are weighted by how rare they are across file paths, so a file
  // called cli.py counts for "cli" but the hundred paths under tests/ do not all count for "test".
  const pathIdf = (t: string): number => {
    const n = index.pathDf.get(t) ?? 0;
    return Math.log(1 + (nFiles - n + 0.5) / (n + 0.5));
  };
  index.chunks.forEach((c, i) => {
    let score = 0;
    const matched: string[] = [];
    for (const t of qTerms) {
      const tf = c.terms.get(t);
      if (!tf) continue;
      matched.push(t);
      score += (idf(index, t) * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * c.length) / index.avgLen));
    }
    const pt = index.pathTerms.get(c.path) ?? new Set<string>();
    const pathHits = qTerms.filter((t) => pt.has(t) && pathIdf(t) > 1.2);
    const symTerms = new Set(c.symbols.flatMap((s) => tokenize(s)));
    const symbolHits = qTerms.filter((t) => symTerms.has(t));
    if (score === 0 && pathHits.length === 0) return;
    // A file or symbol literally named after a query term is strong evidence.
    for (const t of pathHits) score += 2.5 * pathIdf(t);
    for (const t of symbolHits) score += 0.75 * idf(index, t);
    out.push({ chunk: i, score, matched, pathHits, symbolHits });
  });
  return out.sort((a, b) => b.score - a.score);
}

const stemOf = (rel: string): string =>
  path
    .basename(rel)
    .replace(/\.[^.]+$/, "")
    .replace(/^test_/, "")
    .replace(/_test$|\.test$|\.spec$/, "")
    .toLowerCase();
const roleOf = (rel: string): "test" | "doc" | "source" =>
  /(^|\/)tests?\//.test(rel) || /(^|\/)test_[^/]+$|[._](test|spec)\.[a-z]+$/.test(rel) ? "test" : /(^|\/)docs?\//.test(rel) || /\.(rst|md)$/.test(rel) ? "doc" : "source";

export interface PlanOptions {
  budget?: number;
  maxFiles?: number;
  /** Files already given to the model in full (e.g. the file being edited inline); not retrieved again. */
  exclude?: string[];
}

/** Build the context plan for a request: pinned mentions, retrieved excerpts, companions, all within the budget. */
export function planContext(index: WorkspaceIndex, request: string, opts: PlanOptions = {}): ContextPlan {
  const budget = Math.max(500, opts.budget ?? 6000);
  const maxFiles = opts.maxFiles ?? 8;
  const mentions = parseMentions(request, index);
  const items: PlanItem[] = [];
  let used = 0;
  const taken = new Set<number>();
  const add = (ci: number, score: number, reason: string, kind: PlanItem["kind"], cap = Infinity): boolean => {
    if (taken.has(ci)) return true;
    const c = index.chunks[ci];
    const tokens = estimateTokens(c.text) + 12;
    if (used + tokens > budget || tokens > cap) return false;
    taken.add(ci);
    used += tokens;
    items.push({ path: c.path, startLine: c.startLine, endLine: c.endLine, score: Math.round(score * 100) / 100, tokens, reason, kind, text: c.text });
    return true;
  };

  // 1. Pinned mentions come first and may use up to 60% of the budget.
  const mentionCap = budget * 0.6;
  for (const s of mentions.symbols) add(s.chunk, 99, `explicit @${s.name} mention (defined at ${s.path}:${s.line})`, "mention");
  for (const f of mentions.files) {
    const cs = index.chunks.map((c, i) => ({ c, i })).filter((x) => x.c.path === f);
    for (const { i } of cs) {
      if (used >= mentionCap) break;
      add(i, 99, `explicit @${f} mention`, "mention");
    }
  }

  // 2. Automatic retrieval.
  const exclude = new Set(opts.exclude ?? []);
  const scored = scoreChunks(index, mentions.cleaned).filter((s) => !exclude.has(index.chunks[s.chunk].path));
  const byFile = new Map<string, { best: number; chunks: Scored[] }>();
  for (const s of scored) {
    const p = index.chunks[s.chunk].path;
    const e = byFile.get(p) ?? { best: 0, chunks: [] };
    e.chunks.push(s);
    e.best = Math.max(e.best, s.score);
    byFile.set(p, e);
  }
  type Ranked = { path: string; score: number; reason: string; kind: PlanItem["kind"]; chunks: Scored[] };
  const ranked: Ranked[] = [...byFile.entries()].map(([p, e]) => {
    const top = e.chunks[0];
    // Several matching chunks in one file make the file more relevant than one lucky chunk.
    const score = e.best + 0.25 * e.chunks.slice(1, 4).reduce((a, c) => a + c.score, 0);
    const bits: string[] = [];
    if (top.pathHits.length) bits.push(`path matches "${top.pathHits.join(", ")}"`);
    if (top.symbolHits.length) bits.push(`defines ${index.chunks[top.chunk].symbols.slice(0, 2).join(", ")}`);
    if (top.matched.length) bits.push(`terms: ${top.matched.slice(0, 5).join(", ")}`);
    return { path: p, score, reason: bits.join("; "), kind: "retrieved" as const, chunks: e.chunks };
  });
  ranked.sort((a, b) => b.score - a.score);

  // 3. Companion expansion: the test and doc that share a stem with the top source hits.
  const qTerms = new Set(tokenize(mentions.cleaned));
  const wantsTest = qTerms.has("test");
  const wantsDoc = qTerms.has("doc");
  const topSources = ranked.filter((r) => roleOf(r.path) === "source").slice(0, 2);
  for (const src of topSources) {
    const stem = stemOf(src.path);
    if (stem.length < 2) continue;
    for (const f of index.files) {
      const role = roleOf(f);
      if (role === "source" || stemOf(f) !== stem || f === src.path || exclude.has(f)) continue;
      const factor = (role === "test" && wantsTest) || (role === "doc" && wantsDoc) ? 0.9 : 0.55;
      const companionScore = src.score * factor;
      const existing = ranked.find((r) => r.path === f);
      const why = `${role} companion of ${src.path} (same stem "${stem}")`;
      if (existing) {
        if (existing.score < companionScore) existing.score = companionScore;
        existing.reason = existing.reason ? `${why}; ${existing.reason}` : why;
        existing.kind = "companion";
      } else {
        const cs = index.chunks.map((c, i) => ({ c, i })).filter((x) => x.c.path === f).slice(0, 2);
        ranked.push({ path: f, score: companionScore, reason: why, kind: "companion", chunks: cs.map((x) => ({ chunk: x.i, score: companionScore, matched: [], pathHits: [], symbolHits: [] })) });
      }
    }
  }
  ranked.sort((a, b) => b.score - a.score);

  // 4. Pack: round-robin over the top files so the budget is spread across them
  //    rather than spent on the first file, best chunk of each file first.
  const top = ranked.slice(0, maxFiles);
  const perFileCap = Math.max(400, Math.floor((budget - used) * 0.45));
  const spent = new Map<string, number>();
  const includedFiles = new Set<string>(items.map((i) => i.path));
  for (let round = 0; round < 6; round++) {
    let progressed = false;
    for (const r of top) {
      const s = r.chunks[round];
      if (!s) continue;
      const tokens = estimateTokens(index.chunks[s.chunk].text) + 12;
      const already = spent.get(r.path) ?? 0;
      if (already + tokens > perFileCap && already > 0) continue;
      if (add(s.chunk, r.score, r.reason, r.kind)) {
        spent.set(r.path, already + tokens);
        includedFiles.add(r.path);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  const omitted = ranked.filter((r) => !includedFiles.has(r.path)).slice(0, 6).map((r) => ({ path: r.path, score: Math.round(r.score * 100) / 100, reason: r.reason }));
  return { query: mentions.cleaned, budget, usedTokens: used, items, omitted, unknownMentions: mentions.unknown, indexedFiles: index.files.length, indexedTokens: index.totalTokens };
}

/** Group plan items per file for display. */
export function planFiles(plan: ContextPlan): Array<{ path: string; ranges: string; tokens: number; score: number; reason: string; kind: PlanItem["kind"] }> {
  const m = new Map<string, { path: string; ranges: string[]; tokens: number; score: number; reason: string; kind: PlanItem["kind"] }>();
  for (const it of plan.items) {
    const e = m.get(it.path) ?? { path: it.path, ranges: [], tokens: 0, score: it.score, reason: it.reason, kind: it.kind };
    e.ranges.push(`${it.startLine}-${it.endLine}`);
    e.tokens += it.tokens;
    e.score = Math.max(e.score, it.score);
    m.set(it.path, e);
  }
  return [...m.values()].map((e) => ({ ...e, ranges: e.ranges.join(", ") }));
}

/** Render the plan as the block that is prepended to the user's message / returned by gather_context. */
export function renderPlan(plan: ContextPlan, withCode = true): string {
  const files = planFiles(plan);
  const lines: string[] = [];
  lines.push(`Context selected by cIAo Forge: ${plan.usedTokens} of ${plan.budget} budget tokens, ${plan.items.length} excerpt(s) from ${files.length} file(s); workspace has ${plan.indexedFiles} indexed files (~${plan.indexedTokens} tokens).`);
  lines.push("");
  lines.push("| file | lines | tokens | score | why it was chosen |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const f of files) lines.push(`| ${f.path} | ${f.ranges} | ${f.tokens} | ${f.kind === "mention" ? "pinned" : f.score} | ${f.reason} |`);
  if (plan.omitted.length) {
    lines.push("");
    lines.push(`Ranked but left out to stay within the budget (read them with read_file if needed): ${plan.omitted.map((o) => `${o.path} (${o.score})`).join(", ")}`);
  }
  if (plan.unknownMentions.length) lines.push(`Unresolved @mentions: ${plan.unknownMentions.join(", ")}`);
  if (withCode) {
    for (const it of plan.items) {
      lines.push("");
      lines.push(`--- ${it.path} lines ${it.startLine}-${it.endLine} ---`);
      lines.push(it.text);
    }
  }
  return lines.join("\n");
}
