import { execFile } from "node:child_process";

const PY_CHECK = "import ast,sys\ntry:\n ast.parse(sys.stdin.read())\nexcept SyntaxError as e:\n print(f'{e.lineno}\\t{e.msg}'); sys.exit(3)\n";

/** "py" is the Windows launcher. On Windows "python3" is often the Microsoft Store stub (exit 9009). */
const CANDIDATES = ["python3", "python", "py"];

/** Interpreter that worked last time, so later checks spawn one process instead of up to three. */
let working: string | null | undefined;

function check(exe: string, text: string): Promise<{ status: "ok" } | { status: "syntax"; detail: string } | { status: "unusable" }> {
  return new Promise((resolve) => {
    const child = execFile(exe, ["-c", PY_CHECK], { timeout: 8000, windowsHide: true }, (error, stdout) => {
      if (!error) return resolve({ status: "ok" });
      const code = (error as unknown as { code?: number | string }).code;
      if (code === 3) return resolve({ status: "syntax", detail: String(stdout ?? "").trim() || "?\tsyntax error" });
      resolve({ status: "unusable" });
    });
    child.stdin?.on("error", () => {
      /* interpreter missing: reported through the callback */
    });
    child.stdin?.end(text);
  });
}

/**
 * Python syntax guard: resolves to null if `text` parses (or no Python is available),
 * otherwise "line<TAB>message". Runs the interpreter asynchronously so the extension
 * host never blocks while an edit is checked.
 */
export async function pythonSyntaxError(text: string): Promise<string | null> {
  if (working === null) return null;
  const order = working ? [working, ...CANDIDATES.filter((c) => c !== working)] : CANDIDATES;
  for (const exe of order) {
    const r = await check(exe, text);
    if (r.status === "unusable") continue;
    working = exe;
    return r.status === "syntax" ? r.detail : null;
  }
  working = null; // no working Python: do not block edits, and stop probing
  return null;
}

/** Test hook: forget which interpreter worked. */
export function resetPythonProbe(): void {
  working = undefined;
}
