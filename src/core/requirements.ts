/**
 * Completeness check for agent mode. Pure.
 *
 * A request such as "…be covered by a test, and be documented…" names kinds of files that
 * must change even though it names no file. Models sometimes stop after the implementation
 * and the test. After a turn that applied edits, the runner compares what changed with what
 * the request asked for and, once, sends a follow-up turn naming only what is missing.
 */

const isTest = (p: string) => /(^|\/)(tests?|spec|__tests__)\//i.test(p) || /(^|\/)(test_[^/]+|[^/]+_test\.[^/]+|[^/]+\.(test|spec)\.[^/]+)$/i.test(p);
const isDoc = (p: string) => /(^|\/)docs?\//i.test(p) || /\.(rst|md|mdx|adoc|txt)$/i.test(p) || /(^|\/)(README|CHANGES|CHANGELOG)[^/]*$/i.test(p);

export interface Requirement {
  kind: "test" | "docs";
  missing: string;
}

export function missingRequirements(request: string, changedPaths: string[]): Requirement[] {
  const r = request.toLowerCase();
  const out: Requirement[] = [];
  if (/\b(be documented|document (it|this|the)|add (the )?documentation|update the docs|in the docs)\b/.test(r) && !changedPaths.some(isDoc)) {
    out.push({ kind: "docs", missing: "the request says it must be documented, but no documentation file (for example under docs/) was changed" });
  }
  if (/\b(covered by (a |unit )?tests?|be tested|add (a |unit )?tests?|write (a |unit )?tests?|with (a |unit )?tests?)\b/.test(r) && !changedPaths.some(isTest)) {
    out.push({ kind: "test", missing: "the request says it must be covered by a test, but no test file was changed" });
  }
  return out;
}

export function followUpMessage(missing: Requirement[]): string {
  return [
    "Before you finish: the change is not complete yet.",
    ...missing.map((m) => `- ${m.missing}.`),
    "Find where the neighbouring features are documented or tested (gather_context or search_workspace), add the missing piece with propose_edit following the existing conventions, then give your summary. Do not redo what is already applied.",
  ].join("\n");
}
