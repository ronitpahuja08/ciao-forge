import * as fs from "node:fs";
import * as path from "node:path";
import { exec, execFile, spawn, type ChildProcess } from "node:child_process";
import type { FileIO } from "./store";

/** Plain node:fs implementation of FileIO (used by tests and as the fallback writer). */
export const nodeIO: FileIO = {
  async read(abs) {
    try {
      return await fs.promises.readFile(abs, "utf8");
    } catch {
      return null;
    }
  },
  async write(abs, text) {
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, text, "utf8");
  },
  async remove(abs) {
    await fs.promises.rm(abs, { force: true });
  },
};

/** Directories that hold a project virtualenv's executables, if the workspace has one. */
export function venvBinDirs(root: string, extra: string[] = []): string[] {
  const out: string[] = [];
  for (const e of extra) if (e && fs.existsSync(e)) out.push(e);
  for (const name of [".venv", "venv", "env"]) {
    for (const sub of ["Scripts", "bin"]) {
      const d = path.join(root, name, sub);
      if (fs.existsSync(d)) out.push(d);
    }
  }
  return out;
}

/**
 * Environment variables passed to commands the agent runs. Everything else in the editor's
 * environment (API keys, tokens, cloud credentials the user exported) is withheld, because a
 * command's output goes back to the model provider.
 */
const ENV_ALLOW = new Set([
  "PATH", "PATHEXT", "HOME", "USER", "USERNAME", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "TZ", "TMPDIR", "TEMP", "TMP",
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS",
  "VIRTUAL_ENV",
]);
const ENV_ALLOW_PREFIX = ["LC_", "FLASK_", "PYTHON", "CONDA_", "XDG_", "PYENV", "ASDF_", "UV_", "PIPENV_", "POETRY_", "NVM_", "NODE_"];
const ENV_DENY = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;

export function commandEnv(pathPrepend: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    const up = k.toUpperCase();
    if (ENV_DENY.test(up)) continue;
    if (ENV_ALLOW.has(up) || ENV_ALLOW_PREFIX.some((p) => up.startsWith(p))) env[k] = v;
  }
  if (pathPrepend.length) {
    const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
    env[key] = [...pathPrepend, env[key] ?? ""].join(path.delimiter);
  }
  env.PYTHONIOENCODING = "utf-8";
  env.NO_COLOR = "1";
  return env;
}

type ExecResult = { code: number | null; output: string; timedOut: boolean };

function collect(resolve: (r: ExecResult) => void) {
  return (error: Error | null, stdout: string, stderr: string) => {
    const output = `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`.trim();
    if (error) {
      const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      resolve({ code: typeof e.code === "number" ? e.code : null, output: output || e.message, timedOut: e.killed === true });
    } else {
      resolve({ code: 0, output, timedOut: false });
    }
  };
}

/** Commands started for the agent that are still running, so Stop can end them. */
const running = new Set<ChildProcess>();

function track(child: ChildProcess): void {
  running.add(child);
  child.once("exit", () => running.delete(child));
  child.once("error", () => running.delete(child));
}

/**
 * Stop every command the agent started (the whole process tree: `exec` runs a shell,
 * and pytest may start workers). Called when the user presses Stop, so a cancelled run
 * cannot keep changing files through a command that is still running.
 */
export function killRunningCommands(): number {
  const n = running.size;
  for (const child of running) {
    if (child.pid === undefined) continue;
    try {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  running.clear();
  return n;
}

/** Run an (already allowlisted) command with a timeout, capturing combined output. Never throws. */
export function execCommand(command: string, cwd: string, timeoutMs: number, pathPrepend: string[] = []): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = exec(command, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: commandEnv(pathPrepend), windowsHide: true }, collect(resolve));
    track(child);
    child.stdin?.end();
  });
}

/** Run a program with an argument vector and no shell, so arguments are never interpreted. Never throws. */
export function execFileCommand(file: string, args: string[], cwd: string, timeoutMs: number, pathPrepend: string[] = []): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: commandEnv(pathPrepend), windowsHide: true, shell: false }, collect(resolve));
    track(child);
    child.stdin?.end();
  });
}
