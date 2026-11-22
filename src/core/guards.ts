import * as fs from "node:fs";
import * as path from "node:path";

export class GuardError extends Error {}

/**
 * Resolve a workspace-relative path and refuse anything that escapes the
 * workspace root (via `..`, an absolute path elsewhere, or a symlink).
 * Returns the absolute path and the normalised forward-slash relative path.
 */
export function resolveInside(root: string, requested: string): { abs: string; rel: string } {
  if (typeof requested !== "string" || requested.trim() === "") throw new GuardError("path is required");
  if (requested.includes("\0")) throw new GuardError("path contains a null byte");
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, requested);
  const rel = path.relative(rootAbs, abs);
  if (rel === "" ) throw new GuardError("path must point to a file inside the workspace, not the workspace root");
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new GuardError(`path escapes the workspace: ${requested}`);
  // Symlink check: the deepest existing ancestor must still be inside the root.
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try {
    const real = fs.realpathSync.native(probe);
    const realRoot = fs.realpathSync.native(rootAbs);
    const r = path.relative(realRoot, real);
    if (r.startsWith("..") || path.isAbsolute(r)) throw new GuardError(`path resolves outside the workspace: ${requested}`);
  } catch (e) {
    if (e instanceof GuardError) throw e;
  }
  const relPosix = rel.split(path.sep).join("/");
  // Case-insensitive: macOS and Windows file systems treat .GIT as .git.
  if (relPosix.split("/").some((seg) => seg.toLowerCase() === ".git")) throw new GuardError("the .git directory is off limits");
  if (isSensitivePath(relPosix)) throw new GuardError(`${relPosix} looks like a secrets or credentials file; cIAo Forge does not read or edit it`);
  return { abs, rel: relPosix };
}

/**
 * Files that usually hold secrets. The agent may not read, list, index or edit them,
 * because anything the agent sees is sent to the model provider.
 */
const SENSITIVE_NAME: RegExp[] = [
  /^\.env($|\.)/i, // .env, .env.local, .env.production ...
  /\.env$/i, // prod.env
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|asc|gpg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(npmrc|pypirc|netrc|pgpass|git-credentials|htpasswd)$/i,
  /^(credentials|client_secret|token)([._-][^/]*)?\.json$/i,
  /service[-_]?account[^/]*\.json$/i,
  /^secrets?\.(json|ya?ml|toml)$/i,
];
const SENSITIVE_ALLOW = /(^|[._-])(example|sample|template|dist)([._-]|$)/i; // .env.example, credentials.example.json
const SENSITIVE_DIRS = new Set([".ssh", ".aws", ".gnupg", ".docker", ".kube"]);

export function isSensitivePath(relPosix: string): boolean {
  const segs = relPosix.split("/");
  if (segs.slice(0, -1).some((s) => SENSITIVE_DIRS.has(s.toLowerCase()))) return true;
  const name = segs[segs.length - 1];
  if (SENSITIVE_ALLOW.test(name)) return false;
  return SENSITIVE_NAME.some((re) => re.test(name));
}

/** Commands the agent may run, after TrueForge approval. Anything else is refused. */
const ALLOWED: RegExp[] = [
  /^(python3?|py)\s+-m\s+pytest(\s|$)/,
  /^pytest(\s|$)/,
  /^(python3?|py)\s+-m\s+flask(\s|$)/,
  /^flask(\s|$)/,
  /^git\s+(status|diff|log|show)(\s|$)/,
  /^(npm|pnpm|yarn)\s+(test|run\s+(test|lint|compile|build|typecheck))(\s|$)/,
  /^(python3?|py)\s+-c\s+/,
  /^(ruff|mypy|tsc|eslint)(\s|$)/,
];

/** Shell metacharacters that could chain or redirect commands. */
const FORBIDDEN = /[;&|`$<>\n\r]|\bpip\b|\brm\b|\bdel\b|\bcurl\b|\bwget\b/;

/**
 * git options that write files, run configured helpers, or read outside the repository.
 * git accepts any unambiguous prefix of a long option (--outp=x means --output=x), so a
 * token is refused when it is a prefix of one of these of at least three characters.
 */
const GIT_BLOCKED_OPTIONS = ["output", "ext-diff", "textconv", "no-index", "exec", "upload-pack", "git-dir", "work-tree"];
/** pytest options that write or delete files outside its cache (--basetemp is wiped before the run). */
const PYTEST_BLOCKED_OPTIONS = /^--(basetemp|junit-?xml|result-?log|report-?log|html|json-report-file|debug)(=|$)/i;
/**
 * `python -c` exists for quick read-only checks. Code that deletes, writes, spawns processes or
 * hides an import is refused. This is a best-effort filter; TrueForge approval is still required.
 */
const PY_C_BLOCKED = /\b(shutil|subprocess|pathlib|importlib|ctypes|socket|urllib|requests|http|ftplib|__import__|exec|eval|compile|globals|getattr|open|write_text|write_bytes|unlink|rmdir|rmtree|remove|removedirs|rename|replace|system|popen|spawn\w*|execv\w*|fork|kill|chmod|chown|environ|getenv|putenv)\b|\bos\s*\.\s*(?!path\b)\w+/;
/** File names that hold secrets, mentioned anywhere in a command (git show HEAD:.env, git diff -- id_rsa). */
const SECRET_MENTION = /(^|[\s"'=:/\\])(\.env(\.[\w.-]+)?|[\w.-]+\.env|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.(npmrc|pypirc|netrc|pgpass|git-credentials|htpasswd)|[\w.-]+\.(pem|key|p12|pfx|jks|keystore|kdbx)|(credentials|client_secret|token)([._-][\w.-]*)?\.json|service[-_]?account[\w.-]*\.json|secrets?\.(json|ya?ml|toml)|\.(ssh|aws|gnupg|docker|kube)[/\\])(?=$|[\s"':/\\])/i;

function tokens(cmd: string): string[] {
  return (cmd.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ""));
}

export function checkCommand(command: string): { ok: true } | { ok: false; reason: string } {
  const cmd = (command ?? "").trim();
  if (!cmd) return { ok: false, reason: "empty command" };
  if (cmd.length > 400) return { ok: false, reason: "command too long" };
  if (FORBIDDEN.test(cmd)) return { ok: false, reason: "shell operators, redirection and destructive programs are not allowed" };
  if (!ALLOWED.some((re) => re.test(cmd))) {
    return { ok: false, reason: "not on the allowlist (pytest, python -m pytest, flask, python -c, git status/diff/log/show, npm test, linters)" };
  }
  const toks = tokens(cmd);
  // Secrets files stay unreadable through commands too, not just through read_file.
  const secret = toks.find((t) => SECRET_MENTION.test(t) && !SENSITIVE_ALLOW.test(t.split(/[/\\:]/).pop() ?? ""));
  if (secret) return { ok: false, reason: `"${secret}" refers to a secrets or credentials file, which cIAo Forge never reads` };
  if (toks.some((t) => /(^|[/\\:])\.git([/\\]|$)/i.test(t))) return { ok: false, reason: "the .git directory is off limits" };
  if (/^git\s/.test(cmd)) {
    for (const t of toks) {
      if (!t.startsWith("--")) continue;
      const name = t.slice(2).split("=")[0].toLowerCase();
      const hit = name.length >= 3 && GIT_BLOCKED_OPTIONS.find((o) => o.startsWith(name));
      if (hit) return { ok: false, reason: `git --${hit} is not allowed (it can write files, run helpers or read outside the repository)` };
    }
  }
  if (/^((python3?|py)\s+-m\s+)?pytest(\s|$)/.test(cmd)) {
    const bad = toks.find((t) => PYTEST_BLOCKED_OPTIONS.test(t));
    if (bad) return { ok: false, reason: `pytest ${bad.split("=")[0]} is not allowed (it writes or deletes files outside the test cache)` };
  }
  if (/^(python3?|py)\s+-c\s+/.test(cmd)) {
    const code = cmd.replace(/^(python3?|py)\s+-c\s+/, "");
    const m = code.match(PY_C_BLOCKED);
    if (m) return { ok: false, reason: `python -c is for read-only checks; "${m[0]}" can change files, run programs or read secrets` };
  }
  return { ok: true };
}
