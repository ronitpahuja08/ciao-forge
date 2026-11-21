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
  /^(ruff|mypy|tsc|eslint)(\s|$)/,
];

/** Shell metacharacters that could chain or redirect commands. */
const FORBIDDEN = /[;&|`$<>\n\r]|\bpip\b|\brm\b|\bdel\b|\bcurl\b|\bwget\b/;

export function checkCommand(command: string): { ok: true } | { ok: false; reason: string } {
  const cmd = (command ?? "").trim();
  if (!cmd) return { ok: false, reason: "empty command" };
  if (cmd.length > 400) return { ok: false, reason: "command too long" };
  if (FORBIDDEN.test(cmd)) return { ok: false, reason: "shell operators, redirection and destructive programs are not allowed" };
  // git can write files (--output) or run configured helpers (--ext-diff, --textconv) from these read-only commands.
  if (/^git\s/.test(cmd) && /(^|\s)(--output|--ext-diff|--textconv)\b/.test(cmd)) return { ok: false, reason: "git --output, --ext-diff and --textconv are not allowed" };
  if (!ALLOWED.some((re) => re.test(cmd))) {
    return { ok: false, reason: "not on the allowlist (pytest, python -m pytest, flask, git status/diff/log/show, npm test, linters)" };
  }
  return { ok: true };
}
