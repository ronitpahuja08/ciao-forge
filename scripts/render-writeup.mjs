#!/usr/bin/env node
// Render docs/WRITEUP.md to docs/WRITEUP.pdf with a locally installed Chrome or Edge (headless).
//   npm run writeup            (set BROWSER_BIN if Chrome/Edge is somewhere unusual)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { marked } from "marked";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const md = fs.readFileSync(path.join(project, "docs", "WRITEUP.md"), "utf8");
const css = `
  @page { size: A4; margin: 11mm 12mm; }
  body { font: 8.6pt/1.33 "Segoe UI", "Helvetica Neue", Arial, sans-serif; color: #111; }
  h1 { font-size: 14pt; margin: 0 0 2pt; }
  h2 { font-size: 10.5pt; margin: 8pt 0 3pt; border-bottom: 0.6pt solid #999; padding-bottom: 1pt; }
  p { margin: 3pt 0; }
  ul, ol { margin: 3pt 0; padding-left: 14pt; }
  li { margin: 1pt 0; }
  code { font: 7.8pt Consolas, "SF Mono", monospace; background: #f1f1f1; padding: 0 2pt; border-radius: 2pt; }
  table { border-collapse: collapse; width: 100%; margin: 4pt 0; }
  th, td { border: 0.5pt solid #aaa; padding: 2pt 4pt; text-align: left; vertical-align: top; }
  th { background: #eee; }
  h2, tr { break-inside: avoid; break-after: avoid-page; }
`;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>cIAo Forge write-up</title><style>${css}</style></head><body>${marked.parse(md)}</body></html>`;
const tmp = path.join(os.tmpdir(), `ciao-forge-writeup-${Date.now()}.html`);
fs.writeFileSync(tmp, html);

const candidates = [
  process.env.BROWSER_BIN,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);
const bin = candidates.find((c) => fs.existsSync(c));
if (!bin) {
  console.error("No Chrome or Edge found. Set BROWSER_BIN to a Chromium-based browser.");
  process.exit(1);
}
const out = path.join(project, "docs", "WRITEUP.pdf");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ciao-forge-pdf-"));
const r = spawnSync(bin, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--user-data-dir=${profile}`, `--print-to-pdf=${out}`, pathToFileURL(tmp).href], { stdio: "pipe", timeout: 60000 });
fs.rmSync(tmp, { force: true });
if (!fs.existsSync(out)) {
  console.error(`PDF was not produced (${r.status}): ${r.stderr?.toString().slice(0, 400)}`);
  process.exit(1);
}
const pages = (fs.readFileSync(out, "latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
const headings = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
console.log(`docs/WRITEUP.pdf: ${pages} page(s), ${headings.length} headings`);
const todo = [...new Set(md.match(/\[[A-Z][A-Z /,.:a-z-]*\]|\[mm:ss\]|\[@handle\]/g) ?? [])];
if (todo.length) console.log(`Still to fill in before submitting: ${todo.join("  ")}`);
if (pages > 3) {
  console.error("The write-up must be 1 to 3 pages.");
  process.exit(1);
}
