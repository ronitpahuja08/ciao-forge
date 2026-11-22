# cIAo Forge: write-up

TrueFoundry Forge-a-thon, Round 1 · Team Darwin · Team ID: **TM-2EBD4223A67** · Repository: **https://github.com/ronitpahuja08/ciao-forge** · Video: **https://youtu.be/6Ax-6M08I_g**

## 1. Team

| Member | College or employer | GitHub |
| --- | --- | --- |
| Aadhar Gupta | Masters' Union University | [@Aadhar-Gupta-0](https://github.com/Aadhar-Gupta-0) |
| Ayush Kakkar | Masters' Union University | [@AyushKakkar](https://github.com/AyushKakkar) |
| Ishaan Bansal | Masters' Union University | [@ishaands12](https://github.com/ishaands12) |
| Ronit Pahuja | Masters' Union University | [@ronitpahuja08](https://github.com/ronitpahuja08) |
| Shreshth Behal | Masters' Union University | [@SHRESHTHBEHAL](https://github.com/SHRESHTHBEHAL) |

## 2. Starting point

From scratch. We did not fork Cline, Continue or any other project. The public repository is a single-commit export of the extension from our team's working repository, which is why its history starts with one commit. At runtime we depend on `@truefoundry/trueforge-sdk`, `@modelcontextprotocol/sdk` and `zod`, and nothing else. One idea came from an earlier project of ours, cIAo: before an agent changes a line, it should know why the line is there. That became the `explain_history` tool, which returns the last few commits that touched a file or a line. No code was carried over.

## 3. Architecture on TrueForge

The extension does not call any model provider. It uses the TrueForge TypeScript SDK to create a session for a named agent, sends each request with `sessions.createTurnStream`, and shows the streamed events (text deltas, tool calls, approvals and `turn.done`) in a side panel. There is no provider SDK, URL or key in the extension's source, and `npm run check` fails if one appears.

On start-up the extension runs a small Streamable-HTTP MCP server on `127.0.0.1`, protected by a bearer token, and registers it in TrueForge through the SDK as the connector `ciao-editor`. The agent reaches the editor only through this server, which exposes eight tools. Six only read: `gather_context`, `read_file`, `search_workspace`, `find_symbol`, `list_files` and `explain_history`. Two need approval: `propose_edit` and `run_command`. The agent decides what to read and write, and the extension just runs those calls.

Diff review is built on TrueForge's tool approval. `propose_edit` is listed in the agent's `requireApprovalForTools`, so TrueForge pauses the turn with `tool.approval_required` before the tool runs. We build the diff from the tool call's arguments and open it for review. If the user accepts at least one hunk we answer `allow`, and only the accepted hunks are written. If they reject everything we answer `deny`, with a reason the agent can read. We did it this way so that nothing reaches the disk without passing through TrueForge, and its session log carries an approval event for every edit. Edits that would leave a Python file unparseable are refused before they reach review.

The extension handles model failures itself. When a turn fails, we look at the error first. A credential error goes straight to the fallback agent; a network or server error is retried with backoff first. The same request is then re-sent to a second TrueForge agent bound to the fallback provider. If edits were already applied, we stop instead of re-running.

We used these harness features:
- *Deferred tool loading.* Five core tools are preloaded. `find_symbol`, `list_files` and `explain_history` stay out of the prompt until the agent fetches them with `get_tool_info` and calls them with `call_tool`, which keeps every request smaller. It is visible in the video in the panel and in the TrueForge session.
- *Compaction* at 48k input tokens, so a long Task B run summarises old tool output instead of running out of window.
- *Dynamic subagents* are enabled on the main agent for wide read-only searches; the recorded run did not need one.
- *Two agent shapes, four definitions.* Agent mode uses `ciao-forge`; inline edits use a smaller `ciao-forge-inline` (just `propose_edit` and `read_file`, preloaded, six iterations). Each has a `-fallback` twin bound to the fallback provider, which is the agent that takes over at 3:07. We added it after a 1.5B local model failed to call tools under the full agent's prompt.
- Sessions, streaming, `sessions.cancel` and the session viewer are used without changes. We did not use sandbox, skills or Code Mode; the three tasks did not need them.

## 4. How context is selected

Flask 3.1.3 is about 286k tokens across 218 text files (the panel prints this at 0:30). By default retrieved context gets **6,000 tokens** (`ciaoForge.tokenBudget`; we estimate tokens as characters ÷ 4).

1. We resolve explicit mentions first. `@path/to/file` and `@Symbol` are looked up against an in-memory index and pinned before anything else; `@file` mentions may use up to 60% of the budget. A name that matches nothing is reported back. A file name that matches several paths takes the shortest one.
2. We cut files at top-level definitions, or at headings for docs, and no chunk is longer than 60 lines.
3. We score chunks with BM25. Identifiers are split (`get_debug_flag` becomes *debug*, *flag*) and common word forms are reduced (*documented* becomes *doc*). A query word that appears in a file's path adds weight, and rarer path words count for more. "cli" appears in few paths, so `cli.py` gets a real boost; "test" appears in every path under `tests/`, so it adds little. A match in a defined symbol's name also adds weight.
4. For the two best source files we add their companions: the test and the doc page with the same stem (`cli.py` brings `test_cli.py` and `cli.rst`), weighted higher when the request mentions tests or docs. This is how Task B's three files are found from a request that names none.
5. We pack the top eight files round-robin, taking each file's best chunk first. No file may use more than 45% of the remaining budget. Files that ranked but did not fit are listed as left out.

The plan is shown in the panel before the turn starts, as a table of file, lines, tokens, score and the reason each file was picked, and it is appended to the message the agent receives. The agent can ask for more with `gather_context(query)`, under the same budget. For inline edits the query is the instruction plus the identifiers in the selection, the open file is left out because it is already in the message, and the budget drops to 1,200 tokens.

Lexical search only needs the files on disk. On Flask, building the index took us 0.3 to 0.9 s and each plan about 20 ms. The cost is that it cannot link a request that says "settings" to code called `config` beyond a small synonym table.

## 5. Model setup

| Model | Where it ran | Used for | Approximate cost |
| --- | --- | --- | --- |
| Mercury 2 (`mercury-2`, Inception), TrueForge provider `primary` | Inception's OpenAI-compatible API, added to TrueForge as a custom provider | Video: Tasks A and B | $0.25 / $0.75 per 1M input / output tokens; roughly $0.20 to $0.40 for a Task B run and under a cent for Task A |
| Mercury 2 again, as a separate TrueForge provider `fallback` with its own key | Same API | Video: Task C, after `primary` was given an invalid key | Same rates; under a cent for Task C |
| Qwen2.5-Coder 1.5B (Q4 GGUF) | Our laptop, llama.cpp server, CPU only | Development only: testing with a weak model | $0 |
| Scripted test model (`scripts/mock-model.mjs`) | Local | Automated end-to-end tests only | $0 |

For Task C the fallback is a second provider entry with separate credentials. It is the same model. Any other model can take that slot without code changes. All models live in TrueForge as providers, and `config/models.example.json` is the example file. To switch, add the provider in TrueForge and run `npm run setup -- --primary <provider/model> --fallback <provider/model>`, or use the command *cIAo Forge: Set Up TrueForge Agents*.

## 6. Scorecard

Timestamps refer to the video linked above (3:57). It was recorded on a Mac, so the inline-edit key is `Cmd+Shift+I` there (`Ctrl+Shift+I` elsewhere).

| Criterion | Video | Claim |
| --- | --- | --- |
| A1 Inline edit | 0:20–0:45 | `get_debug_flag` is selected and the instruction typed after the keybinding (0:25). The review tab shows two hunks, each with its own Accept and Reject buttons (0:35). After accepting, `FLASK_DEBUG=off` prints `False` (0:45). |
| A2 Agent mode | 0:55–2:28 | One request with no files named. The agent edits `src/flask/cli.py`, `docs/cli.rst` and `tests/test_cli.py`. `pytest tests/test_cli.py` passes (2:07), `config` appears in `flask --help` (2:10), the masked JSON prints (2:19) and `git diff --stat` shows three files (2:25). |
| A3 Streaming and cancellation | 1:05–1:20, 3:28–3:46 | Tool calls stream into the panel as they arrive. In the last segment (sped up 6x) Stop ends the run and rolls back the one file it had changed (3:43). |
| B1 Context assembly | 0:30–0:40, 1:00 | Each run shows its plan before it starts. Task A's table shows the reason each file was picked (0:38). Task B's table lists the chosen files (`cli.py`, `test_cli.py`, `docs/cli.rst` and five more) with lines, tokens and score, plus the files ranked but left out of the budget (1:00). The reason column is clipped at that panel width. |
| B2 Diff safety | 0:35–0:49 | The review tab offers Accept and Reject on each hunk and says nothing has been written to disk (0:35). The change is applied only after it is accepted (0:37), then undone (status bar, 0:49). |
| B3 Resilience | 2:34–3:28 | `git status` is clean, then the primary key is made invalid. On Task A again the primary returns 401 and the extension switches to the fallback agent (same Mercury 2 model, second provider entry) with no click (3:07). The diff waits for review with nothing written, and `git status` is still clean (3:28). |
| B4 TrueForge integration | 1:20, 1:52–2:01, 3:40 | Editor tools are MCP, and every edit passes TrueForge approval. The deferred `explain_history` tool is called with `call_tool` (panel 1:20, TrueForge session 1:58), and is loaded with `get_tool_info` first in the last run (3:40). |
| C1 Video | 0:20, 0:55, 2:31 | Tasks A, B and C start at these times, in order, each checked on screen, with the TrueForge session shown during B. |
| C2 Write-up | n/a | This document. |

## 7. Tools used

We used Claude Code (Anthropic) heavily, both to write the extension and to build its end-to-end test harness. Also: TrueForge 0.185.1, the TrueForge TypeScript SDK 0.185.0, the MCP TypeScript SDK, esbuild, vitest, VS Code and llama.cpp.

## 8. Known limitations and what you would do with another month

- A model has to support tool calling. The 1.5B local model wrote its tool call as plain text. We ask once more through TrueForge, then stop with a clear message. We chose not to parse tool calls out of text, because that would take the loop out of the harness.
- Our fallback covers a bad key or a failing endpoint, but not an outage at Inception. In the video both providers point at the same API with different keys, so an Inception outage would stop both. Where the panel message says "second model", it means a second provider entry. A different provider can take that slot with one `npm run setup` command.
- Retrieval is lexical. There are no embeddings or call graph, and the synonym table is written by hand. Next we would add symbol-graph expansion (callers and importers of the top hits) and an optional local embedding index.
- The preview is a review tab plus CodeLens on the original lines. There is no inline ghost text; new lines show in the tab and on hover.
- If the model's `old_text` differs only in whitespace or quote style, we still match it, as long as it covers whole lines with exactly one match, and we tell the user. If the user rejects one hunk in the middle of a multi-file change, the agent is told but does not re-plan around it. The video never shows a rejected hunk.
- Cancellation rolls back by content hash. If the user edited a file after the agent changed it, we leave that file alone and name it in the message. The video does not show `git status` after Stop.
- One workspace folder, text files under 200 KB, and the index is rebuilt in memory on the next request after a file changes.
- We tested with one real model, and it is not perfectly consistent. Task B changed code, docs and tests in six of our seven rehearsal runs, though twice the test went into a new file instead of `tests/test_cli.py`. Once it skipped the docs. The run notes are in `test-e2e/results-real-model.txt`. Before we pinned Werkzeug 3.1.0, one Flask test already failed at baseline, and the model wandered into unrelated files trying to fix it. The automated suites use a scripted model, so they test the extension's behaviour. They say nothing about model quality.
- The video joins two sessions. Task B was recorded again in a separate run, so the terminal prompt and the panel history change between tasks. No task is cut between its instruction and its diff. The npm error lines next to `git status` at 3:28 come from a command we mistyped in the terminal, not from the extension.
- With another month: a recorded benchmark across several real models, commands run in TrueForge's sandbox, Code Mode for bulk search, and a skill that carries each repository's conventions.
