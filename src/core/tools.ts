import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { checkCommand, GuardError, resolveInside } from "./guards";

const PY_CHECK = "import ast,sys\ntry:\n ast.parse(sys.stdin.read())\nexcept SyntaxError as e:\n print(f'{e.lineno}\\t{e.msg}'); sys.exit(3)\n";

/**
 * Python syntax guard: returns null if `text` parses (or no Python is available),
 * otherwise "line<TAB>message". Used so an edit that would leave a .py file
 * unparseable (e.g. a mis-indented line) is rejected before review, with the
 * exact line reported back to the model, instead of breaking the workspace.
 */
function pythonSyntaxError(text: string): string | null {
  for (const exe of ["python3", "python"]) {
    try {
      execFileSync(exe, ["-c", PY_CHECK], { input: text, timeout: 8000, stdio: ["pipe", "pipe", "ignore"] });
      return null;
    } catch (e) {
      const err = e as { status?: number; stdout?: Buffer; code?: string };
      if (err.status === 3) return String(err.stdout ?? "").trim() || "?\tsyntax error";
      if (err.code === "ENOENT") continue;
      return null; // checker itself failed: do not block the edit
    }
  }
  return null;
}
import { applySearchReplaceDetailed, EditError, type SearchReplace } from "./hunks";
import { editKey, type FileIO, type Proposal, type ProposalStore } from "./store";
import { isTextPath, listWorkspaceFiles, planContext, renderPlan, type ContextPlan, type WorkspaceIndex } from "./context";

/** Everything a tool needs from its surroundings. VS Code and the test harness each provide one. */
export interface ToolHost {
  root: string;
  io: FileIO;
  store: ProposalStore;
  getIndex(): WorkspaceIndex;
  currentTurnId(): string;
  /** Show the proposal to the user and resolve once every hunk is decided (or the proposal is discarded). */
  review(p: Proposal): Promise<void>;
  onContextPlan?(plan: ContextPlan, source: "tool" | "auto"): void;
  tokenBudget(): number;
  exec(command: string, cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string; timedOut: boolean }>;
  /** Run a program with an argument vector and no shell. Used when an argument comes from the model. */
  execFile(file: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string; timedOut: boolean }>;
  /** True once the active turn has been cancelled; tools must then refuse to change anything. */
  isCancelled(): boolean;
  log?(msg: string): void;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

const ok = (text: string): ToolResult => ({ text });
const err = (text: string): ToolResult => ({ text, isError: true });
const MAX_READ_LINES = 400;
const MAX_OUTPUT = 8000;

function clip(s: string, max = MAX_OUTPUT): string {
  return s.length <= max ? s : `${s.slice(0, Math.floor(max * 0.4))}\n… [${s.length - max} characters omitted] …\n${s.slice(-Math.floor(max * 0.6))}`;
}

export interface ProposeArgs {
  path: string;
  edits?: SearchReplace[];
  new_content?: string;
  rationale?: string;
}

/**
 * Turn propose_edit arguments into a stored proposal without touching disk.
 * Used both by the TrueForge approval handler (to render the diff before
 * approving the tool call) and by the tool itself, so they share one proposal.
 */
export async function prepareProposal(host: ToolHost, args: ProposeArgs, source: "agent" | "inline" = "agent"): Promise<{ proposal?: Proposal; noChange?: boolean; error?: string }> {
  try {
    const { abs, rel } = resolveInside(host.root, args.path);
    const key = editKey(args);
    const existing = host.store.findByKey(key);
    if (existing && existing.status === "pending") return { proposal: existing };
    const original = await host.io.read(abs);
    let proposed: string;
    let notes: string[] = [];
    if (Array.isArray(args.edits) && args.edits.length > 0) {
      if (original === null) return { error: `${rel} does not exist. To create it, call propose_edit with new_content instead of edits.` };
      const r = applySearchReplaceDetailed(original, args.edits);
      proposed = r.text;
      notes = r.notes;
    } else if (typeof args.new_content === "string") {
      proposed = args.new_content;
      if (original !== null && original.includes("\r\n") && !proposed.includes("\r\n")) proposed = proposed.replace(/\n/g, "\r\n");
    } else {
      return { error: "Provide either edits (a list of {old_text, new_text}) or new_content." };
    }
    if (original !== null && proposed === original) return { noChange: true };
    if (rel.endsWith(".py") && (original === null || pythonSyntaxError(original) === null)) {
      const bad = pythonSyntaxError(proposed);
      if (bad) {
        const [ln, msg] = bad.split("\t");
        const n = Number(ln);
        const lines = proposed.split(/\r?\n/);
        const ctx = Number.isFinite(n) && n > 0
          ? lines.slice(Math.max(0, n - 4), n + 2).map((l, i) => `${String(Math.max(1, n - 3) + i).padStart(5)}  ${l}`).join("\n")
          : "";
        return {
          error: `edit rejected: the result would not be valid Python (${msg} at line ${ln} of ${rel}). Nothing was changed. ` +
            `Check the indentation of new_text against the surrounding code (top-level defs start at column 0, decorators sit directly above their def) and propose the edit again.` +
            (ctx ? `\nThe proposed file around line ${ln} would be:\n${ctx}` : ""),
        };
      }
    }
    const rationale = [args.rationale ?? "", notes.length ? `Note: ${notes.join("; ")}.` : ""].filter(Boolean).join(" ");
    const proposal = host.store.create({ key, turnId: host.currentTurnId(), path: rel, abs, original, proposed, rationale, source });
    return { proposal };
  } catch (e) {
    if (e instanceof GuardError || e instanceof EditError) return { error: e.message };
    return { error: `could not prepare the edit: ${(e as Error).message}` };
  }
}

export const tools = {
  async read_file(host: ToolHost, a: { path: string; start_line?: number; end_line?: number }): Promise<ToolResult> {
    try {
      const { abs, rel } = resolveInside(host.root, a.path);
      const text = await host.io.read(abs);
      if (text === null) return err(`${rel} does not exist. Use list_files or search_workspace to find the right path.`);
      const lines = text.split(/\r?\n/);
      const start = Math.max(1, Math.floor(a.start_line ?? 1));
      const end = Math.min(lines.length, Math.floor(a.end_line ?? start + MAX_READ_LINES - 1), start + MAX_READ_LINES - 1);
      const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join("\n");
      const more = end < lines.length ? `\n[showing lines ${start}-${end} of ${lines.length}; call read_file again with start_line=${end + 1} for more]` : "";
      return ok(`${rel} (lines ${start}-${end} of ${lines.length})\n${body}${more}`);
    } catch (e) {
      return err((e as Error).message);
    }
  },

  async list_files(host: ToolHost, a: { directory?: string; contains?: string }): Promise<ToolResult> {
    let files = listWorkspaceFiles(host.root, 5000);
    if (a.directory && a.directory !== "." && a.directory !== "/") {
      try {
        const { rel } = resolveInside(host.root, a.directory);
        files = files.filter((f) => f.startsWith(`${rel}/`));
      } catch (e) {
        return err((e as Error).message);
      }
    }
    if (a.contains) {
      const needle = a.contains.toLowerCase();
      files = files.filter((f) => f.toLowerCase().includes(needle));
    }
    const shown = files.slice(0, 300);
    return ok(`${files.length} file(s)${files.length > shown.length ? `, first ${shown.length} shown` : ""}:\n${shown.join("\n")}`);
  },

  async search_workspace(host: ToolHost, a: { query: string; regex?: boolean; path_prefix?: string; max_results?: number }): Promise<ToolResult> {
    if (!a.query) return err("query is required");
    let re: RegExp;
    try {
      re = a.regex ? new RegExp(a.query, "i") : new RegExp(a.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    } catch (e) {
      return err(`invalid regular expression: ${(e as Error).message}`);
    }
    const max = Math.min(Math.max(1, a.max_results ?? 40), 100);
    const prefix = (a.path_prefix ?? "").replace(/\\/g, "/").replace(/^\.?\//, "");
    const hits: string[] = [];
    const perFile = new Map<string, number>();
    let total = 0;
    for (const rel of listWorkspaceFiles(host.root, 5000)) {
      if (!isTextPath(rel) || (prefix && !rel.startsWith(prefix))) continue;
      let text: string;
      try {
        const abs = path.join(host.root, rel);
        if (fs.statSync(abs).size > 400_000) continue;
        text = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        total++;
        perFile.set(rel, (perFile.get(rel) ?? 0) + 1);
        if (hits.length < max) hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
      }
    }
    if (total === 0) return ok(`No matches for "${a.query}". Nothing in the workspace contains it; do not assume it exists.`);
    const summary = [...perFile.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([f, n]) => `${f} (${n})`).join(", ");
    return ok(`${total} match(es) in ${perFile.size} file(s)${total > hits.length ? `, first ${hits.length} shown` : ""}.\nFiles: ${summary}\n\n${hits.join("\n")}`);
  },

  async find_symbol(host: ToolHost, a: { name: string }): Promise<ToolResult> {
    if (!a.name) return err("name is required");
    const index = host.getIndex();
    const name = a.name.split(".").pop() ?? a.name;
    const exact = index.symbols.get(name) ?? [];
    let found = exact.map((d) => ({ name, ...d }));
    if (found.length === 0) {
      const lower = name.toLowerCase();
      for (const [sym, defs] of index.symbols) if (sym.toLowerCase().includes(lower)) for (const d of defs) found.push({ name: sym, ...d });
      found = found.slice(0, 25);
      if (found.length === 0) return ok(`No definition named "${a.name}" exists in this workspace. Do not edit or call a symbol that is not defined; search_workspace can confirm.`);
      return ok(`No exact definition of "${a.name}". Similar definitions:\n${found.map((f) => `${f.name}  ${f.path}:${f.line}`).join("\n")}`);
    }
    return ok(`Definition(s) of ${name}:\n${found.map((f) => `${f.path}:${f.line}`).join("\n")}`);
  },

  async gather_context(host: ToolHost, a: { query: string; budget_tokens?: number }): Promise<ToolResult> {
    if (!a.query) return err("query is required");
    const budget = Math.min(a.budget_tokens ?? host.tokenBudget(), host.tokenBudget());
    const plan = planContext(host.getIndex(), a.query, { budget });
    host.onContextPlan?.(plan, "tool");
    return ok(renderPlan(plan, true));
  },

  async explain_history(host: ToolHost, a: { path: string; line?: number }): Promise<ToolResult> {
    try {
      const { rel } = resolveInside(host.root, a.path);
      const line = a.line && a.line > 0 ? Math.floor(a.line) : undefined;
      // `rel` comes from the model: pass it as its own argument, never through a shell.
      const format = "--format=%h%x20%ad%x20%an%x3A%x20%s";
      const args = line
        ? ["log", "-n", "5", "--no-patch", "--date=short", format, `-L${line},${line}:${rel}`]
        : ["log", "-n", "5", "--date=short", format, "--", rel];
      const r = await host.execFile("git", args, host.root, 20_000);
      if (r.code !== 0) return ok(`No git history available for ${rel}${line ? ` line ${line}` : ""}: ${clip(r.output, 400) || "not a git repository"}`);
      return ok(`Last commits touching ${rel}${line ? ` line ${line}` : ""} (why the code is the way it is):\n${clip(r.output.trim(), 3000) || "(no commits)"}`);
    } catch (e) {
      return err((e as Error).message);
    }
  },

  async propose_edit(host: ToolHost, a: ProposeArgs): Promise<ToolResult> {
    if (host.isCancelled()) return err("The run was cancelled by the user. No changes were made.");
    const prep = await prepareProposal(host, a);
    if (prep.error) return err(prep.error);
    if (prep.noChange) return ok(`${a.path} already has exactly this content; nothing to change.`);
    const p = prep.proposal!;
    if (!host.store.isDecided(p)) await host.review(p);
    if (host.isCancelled() || p.status === "discarded") return err("The run was cancelled by the user before this change was applied. Nothing was written.");
    const r = await host.store.apply(p.id, host.io);
    host.log?.(`propose_edit ${p.path}: ${r.message}`);
    return r.ok ? ok(r.message) : err(r.message);
  },

  async run_command(host: ToolHost, a: { command: string }): Promise<ToolResult> {
    if (host.isCancelled()) return err("The run was cancelled by the user. The command was not run.");
    const c = checkCommand(a.command);
    if (!c.ok) return err(`Refused to run "${a.command}": ${c.reason}.`);
    const timeout = /pytest/.test(a.command) ? 180_000 : 60_000;
    const r = await host.exec(a.command.trim(), host.root, timeout);
    const head = r.timedOut ? `Timed out after ${timeout / 1000}s.` : `Exit code ${r.code}.`;
    return { text: `$ ${a.command.trim()}\n${head}\n${clip(r.output)}`, isError: r.timedOut };
  },
};

export type ToolName = keyof typeof tools;

export const READ_ONLY_TOOLS: ToolName[] = ["read_file", "list_files", "search_workspace", "find_symbol", "gather_context", "explain_history"];
export const APPROVAL_TOOLS: ToolName[] = ["propose_edit", "run_command"];
