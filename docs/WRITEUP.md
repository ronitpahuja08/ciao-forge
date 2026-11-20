# cIAo Forge: write-up

TrueFoundry Forge-a-thon, Round 1 · Team ID: **TM-2EBD4223A67** · Repository: **https://github.com/ronitpahuja08/ciao-forge** · Video: **[VIDEO URL]**

## 1. Team

| Member | College or employer | GitHub |
| --- | --- | --- |
| Aadhar Gupta | Masters' Union University | [@Aadhar-Gupta-0](https://github.com/Aadhar-Gupta-0) |
| Ayush Kakkar | Masters' Union University | [@AyushKakkar](https://github.com/AyushKakkar) |
| Ishaan Bansal | Masters' Union University | [@ishaands12](https://github.com/ishaands12) |
| Ronit Pahuja | Masters' Union University | [@ronitpahuja08](https://github.com/ronitpahuja08) |
| Shreshth Behal | Masters' Union University | [@SHRESHTHBEHAL](https://github.com/SHRESHTHBEHAL) |

## 2. Starting point

From scratch. There is no upstream fork and no fork commit. This repository is an export of the extension's directory from our team's private repository, which also holds our earlier cIAo project; the export was squashed into a single commit for submission, so the history here is one commit by design. Runtime dependencies are `@truefoundry/trueforge-sdk`, `@modelcontextprotocol/sdk` and `zod`. One idea is carried over from our own earlier project, cIAo: an agent should know why code is the way it is, which became the `explain_history` tool. No code from that project is included.

## 3. Architecture on TrueForge

The extension is a client of a TrueForge agent and nothing more. It creates a session for a named agent, sends the user's turn with `sessions.createTurnStream`, and renders the streamed events (`model.message.delta`, tool calls, approvals, `turn.done`) in a webview panel. It contains no model-provider SDK, URL or key; a script (`npm run check:eligibility`) fails the build if one appears.

**Editor capabilities are MCP tools.** The extension hosts a Streamable-HTTP MCP server on loopback, protected by a random bearer token, and registers it in TrueForge as the connector `ciao-editor` through the SDK when it starts. Eight tools: `gather_context`, `read_file`, `search_workspace`, `find_symbol`, `list_files`, `explain_history` (read-only), and `propose_edit` and `run_command` (approval required). The agent decides what to read and change; the extension only executes tool calls.

**TrueForge tool approval drives the diff review.** `propose_edit` is listed under `requireApprovalForTools`. When TrueForge pauses the turn with `tool.approval_required`, the extension computes the diff from the tool call's arguments and opens the review. The user's per-hunk decisions are the approval: at least one accepted hunk sends `allow` and the tool then writes only the accepted hunks; rejecting all sends `deny` with a reason the agent sees. We chose this over reviewing after the fact because the harness then holds the single source of truth for what was permitted, and its session log shows an approval event for every edit.

**Harness features used, and why.**
- *Deferred tool loading.* Five core tools are preloaded (`preloadTools`); `find_symbol`, `list_files` and `explain_history` are deferred and fetched by the agent with `get_tool_info` / `call_tool` only when needed. This keeps tool definitions out of every request.
- *Compaction*, with an explicit trigger at 48k input tokens, so a long Task B run on a small-window model summarises old tool output instead of failing.
- *Dynamic subagents* are enabled for the main agent, for delegating a broad read-only search.
- *Two agent shapes.* Inline edits use a separate minimal agent (`ciao-forge-inline`: one edit tool, preloaded, no subagents, six iterations). We added it after testing with a 1.5B local model, which the full agent's deferred-tool prompt confused.
- Sessions, streaming, cancellation (`sessions.cancel`) and the session UI are used as provided. Sandbox, skills and Code Mode are not used (the local sandbox is unavailable on Windows, where we developed).

## 4. How context is selected

Flask at 3.1.3 is about 294k tokens across 218 text files; the default budget for retrieved context is **6,000 tokens** (`ciaoForge.tokenBudget`, tokens estimated as characters ÷ 4).

1. **Explicit mentions first.** `@path/to/file` and `@Symbol` are resolved against the index (suffix match for files, definition lookup for symbols), pinned ahead of everything else, and may use up to 60% of the budget. Unresolved mentions are reported, not guessed.
2. **Chunking.** Files are split at top-level definitions (code) or headings (docs), at most 60 lines per chunk, so an excerpt is a whole function or section.
3. **Scoring.** BM25 over chunk terms, with identifiers split (`get_debug_flag` → debug, flag) and word forms folded (documented → doc). A match in the file path is boosted, weighted by how rare that term is across paths, so `cli.py` counts for "cli" while the many paths under `tests/` do not all count for "test". A match in a defined symbol's name is boosted.
4. **Companion expansion.** For the top source files, the test and the doc page sharing the same stem (`cli.py` → `test_cli.py`, `cli.rst`) are added, ranked higher when the request mentions tests or documentation. This is what finds all three Task B files from a request that names none.
5. **Packing.** Round-robin over the top eight files, best chunk of each first, with a per-file cap of 45% of the remaining budget, so one large file cannot consume it all. Files that ranked but did not fit are listed as omitted.

Every choice carries a reason. The plan is shown in the panel as a table (file, lines, tokens, score, why) before the turn runs, and is prepended to the user message. The agent can ask for more with `gather_context(query)`, under the same budget, and that call and its table appear in the panel and the TrueForge session. For inline edits the query is the instruction plus the identifiers in the selection, the edited file is excluded (it is already in the message), and the budget is 1,200 tokens.

Trade-off: lexical retrieval needs no index build, embedding model or network and runs in under a second, but it cannot bridge vocabulary (a request saying "settings" will not find `config`) except through the small synonym table.

## 5. Model setup

| Model | Where it ran | Used for | Approximate cost |
| --- | --- | --- | --- |
| Mercury 2 (`mercury-2`, Inception) as TrueForge provider `primary` | Inception API, OpenAI-compatible, registered in TrueForge as a custom provider | Demo video, tasks A and B | $0.25 / $0.75 per 1M input / output tokens: about $0.20 to $0.40 per Task B run, under $0.01 per Task A |
| Mercury 2 again, as a separate TrueForge provider `fallback` with its own key entry | Same API | Task C: takes over when `primary` has an invalid key | same |
| Qwen2.5-Coder 1.5B (Q4 GGUF) | Local, llama.cpp server, CPU | Development: weak-model stress test | $0 |
| Scripted test model (`scripts/mock-model.mjs`) | Local | Automated end-to-end tests only | $0 |

For Task C we register the same model twice under two provider entries, so the fallback is a different provider configuration (and credentials), not a different model; any second model plugs into the same slot. All models are configured in TrueForge as providers (catalog or OpenAI-compatible); `config/models.example.json` is the example file. **Switching models:** add the provider in TrueForge, then run `npm run setup -- --primary <provider/model> --fallback <provider/model>` (or the command *cIAo Forge: Set Up TrueForge Agents*). Nothing in the extension is provider-specific.

## 6. Scorecard

| Criterion | Video | Claim |
| --- | --- | --- |
| A1 Inline edit | [mm:ss] | Selection + keybinding + instruction gives a diff in the editor with Accept / Reject on each hunk. |
| A2 Agent mode | [mm:ss] | One request, no files named; the agent finds and edits `cli.py`, `test_cli.py` and `docs/cli.rst`. |
| A3 Streaming and cancellation | [mm:ss] | Tokens stream live; Stop is immediate and reverts anything the cancelled run applied. |
| B1 Context assembly | [mm:ss] | 6,000-token budget; the panel table shows the files chosen for Task B and the reason for each. |
| B2 Diff safety | [mm:ss] | Nothing written before review; per-hunk decisions; an applied change is undone on screen. |
| B3 Resilience | [mm:ss] | Invalid key on the primary: automatic fallback to the second model, no user action, `git status` clean. |
| B4 TrueForge integration | [mm:ss] | Tools are MCP; TrueForge approval drives the review; deferred tool loading visible in the session. |
| C1 Video | n/a | Tasks A, B, C in order, each verified on screen, TrueForge session shown for B. |
| C2 Write-up | n/a | This document. |

## 7. Tools used

Claude Code (Anthropic) was used heavily to write and test the extension, including the end-to-end harness. TrueForge 0.185.1, the TrueForge TypeScript SDK 0.185.0, the MCP TypeScript SDK, esbuild, vitest, VS Code 1.143, llama.cpp.

## 8. Known limitations and what you would do with another month

- **Models without native tool calling cannot drive the agent.** A 1.5B local model printed its tool call as text. We nudge once through TrueForge and then stop with a clear message; we do not parse tool calls out of text, because that would move the loop out of the harness.
- **Retrieval is lexical.** No embeddings and no call graph; synonyms are a hand-written table. Next: symbol-graph expansion (callers and importers of the top hits) and an optional local embedding index.
- **The diff preview is a review tab plus CodeLens on the original lines**, not inline ghost text in the file. Added lines are previewed in the tab and on hover.
- **Approximate matching.** When the model's `old_text` differs only in indentation or quote style we still locate it (whole lines, unique match, flagged to the user). A rejected hunk in the middle of a multi-file change can leave the agent's later edits inconsistent; the agent is told, but we do not re-plan for it.
- **Cancellation rolls back by content hash.** If the user edits a file the cancelled run had changed, that file is left alone and named in the message rather than reverted.
- **One workspace folder**, text files under 200 KB, index rebuilt in memory on change (about 0.4 s on Flask).
- **One real model, and it varies between runs.** The automated suites use a scripted model. With mercury-2, Task B touched all three files in most rehearsals, but one run skipped the docs file until we added a requirements checklist to the agent's instructions. Before we pinned Werkzeug, the model also drifted into unrelated files, trying to fix test failures that were already there at baseline. With another month: a recorded benchmark across several real models, sandboxed command execution through TrueForge's sandbox, Code Mode for bulk search, and a skill carrying per-repository conventions.
