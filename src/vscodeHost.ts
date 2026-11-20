import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { FileIO } from "./core/store";
import type { RunnerConfig } from "./core/runner";

/**
 * Disk access through VS Code. Writes go through WorkspaceEdit so they appear
 * in the editor's own undo stack as well as in cIAo Forge's undo, and are then
 * saved so verification commands see them.
 */
export const vscodeIO: FileIO = {
  async read(abs) {
    const uri = vscode.Uri.file(abs);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (open) return open.getText();
    try {
      return await fs.promises.readFile(abs, "utf8");
    } catch {
      return null;
    }
  },
  async write(abs, text) {
    const uri = vscode.Uri.file(abs);
    if (!fs.existsSync(abs)) {
      // New file: write the exact bytes (VS Code would otherwise apply the platform's default line ending).
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    const doc0 = await vscode.workspace.openTextDocument(uri);
    const full = new vscode.Range(new vscode.Position(0, 0), doc0.lineAt(Math.max(0, doc0.lineCount - 1)).rangeIncludingLineBreak.end);
    edit.replace(uri, full, text);
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) throw new Error(`VS Code refused the edit to ${abs}`);
    const doc = await vscode.workspace.openTextDocument(uri);
    await doc.save();
  },
  async remove(abs) {
    const uri = vscode.Uri.file(abs);
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { uri?: vscode.Uri } | undefined;
        if (input?.uri?.fsPath === uri.fsPath) await vscode.window.tabGroups.close(tab, true);
      }
    }
    try {
      await vscode.workspace.fs.delete(uri, { useTrash: false });
    } catch {
      /* already gone */
    }
  },
};

export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function readConfig(): RunnerConfig & { mcpPort: number; commandPath: string[] } {
  const c = vscode.workspace.getConfiguration("ciaoForge");
  return {
    trueforgeUrl: c.get<string>("trueforgeUrl", "http://localhost:8790"),
    agent: c.get<string>("agent", "ciao-forge"),
    fallbackAgent: c.get<string>("fallbackAgent", "ciao-forge-fallback"),
    maxRetries: Math.max(0, Math.min(5, c.get<number>("maxRetries", 1))),
    tokenBudget: Math.max(500, c.get<number>("tokenBudget", 6000)),
    stallTimeoutMs: Math.max(5, c.get<number>("stallTimeoutSeconds", 60)) * 1000,
    mcpPort: c.get<number>("mcpPort", 8791),
    commandPath: c.get<string[]>("commandPath", []),
  };
}

/** Directory of the Python interpreter selected in VS Code, if any, so `python`/`pytest` resolve to the project's venv. */
export function pythonBinDir(): string[] {
  const p = vscode.workspace.getConfiguration("python").get<string>("defaultInterpreterPath");
  if (p && path.isAbsolute(p) && fs.existsSync(p)) return [path.dirname(p)];
  return [];
}
