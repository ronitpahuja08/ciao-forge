# cIAo Forge

A coding agent that lives in VS Code and runs its whole agent loop on [TrueForge](https://github.com/truefoundry/trueforge). You ask for a change; the agent finds the files itself, proposes edits, and you accept or reject **each hunk** before anything is written. Built for the TrueFoundry Forge-a-thon (Techfest 2026-27, IIT Bombay).

[![CI](https://github.com/ronitpahuja08/ciao-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/ronitpahuja08/ciao-forge/actions/workflows/ci.yml)

**[Demo video](https://youtu.be/o5FtUkLNeg4)** (tasks A, B and C on Flask 3.1.3) · **[Write-up (PDF)](docs/WRITEUP.pdf)** · Team ID TM-2EBD4223A67

- **Inline edit**: select code, press `Ctrl+Shift+I` (`Cmd+Shift+I`), type an instruction, review the diff in the editor.
- **Agent mode**: one request in the panel drives a TrueForge tool loop that discovers and edits several files nobody named.
- **Context assembly**: `@file` / `@symbol` mentions plus automatic retrieval within a token budget, with a visible table of what was chosen and why.
- **Diff review**: per-hunk Accept / Reject, no write before review, every applied change can be undone.
- **Streaming and cancellation**: tokens appear as TrueForge streams them; Stop is immediate and rolls back anything the cancelled run had applied.
- **Resilience**: retry with backoff, then automatic fallback to a second model configured in TrueForge.

## How it meets the eligibility rules

| Rule | Where |
| --- | --- |
| The extension is a client of a TrueForge agent: it creates sessions, sends turns, renders streamed events | [`src/core/runner.ts`](src/core/runner.ts) (TypeScript SDK only) |
| Editor capabilities are MCP tools, so the agent decides what to read and change | [`src/core/mcpServer.ts`](src/core/mcpServer.ts), [`src/core/tools.ts`](src/core/tools.ts): `gather_context`, `read_file`, `search_workspace`, `find_symbol`, `list_files`, `explain_history`, `propose_edit`, `run_command` |
| TrueForge runs in local mode | `npx @truefoundry/trueforge@0.185.1` (below) |
| The model is configured in TrueForge; the extension never calls a provider | No provider SDK, URL or key anywhere in `src/`; enforced by `npm run check:eligibility` |
| The agent definition is in the repository | [`agent/`](agent/): four JSON definitions and their instructions |
| No secrets committed, example configuration shipped | [`config/models.example.json`](config/models.example.json), [`.env.example`](.env.example) |

**Starting point:** written from scratch for this competition. There is no upstream fork, so there is no fork commit to declare. Dependencies: `@truefoundry/trueforge-sdk`, `@modelcontextprotocol/sdk`, `zod`. Licence: MIT.

## Quickstart from a clean clone

Requirements: Node 20+, VS Code 1.95+, Git. For the Flask tasks: Python 3.10+.

```bash
git clone https://github.com/ronitpahuja08/ciao-forge && cd ciao-forge
npm install
npm run build
```

### 1. Start TrueForge locally

TrueForge must be allowed to call the editor's tool server on loopback, so start it with this variable (it must be a JSON array):

```bash
# macOS / Linux / Git Bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@0.185.1
```

```powershell
# Windows PowerShell
$env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'; npx @truefoundry/trueforge@0.185.1
```

It serves the API and UI on `http://localhost:8790`. Leave it running.

### 2. Configure your models in TrueForge

Use any models you like: a paid API, a free tier, a gateway, or a local OpenAI-compatible server. Two models from different providers give you automatic fallback.

Either add them in the TrueForge UI (Settings → Models), or from the example file:

```bash
cp config/models.example.json config/models.json   # keep the providers you use, set model ids
cp .env.example .env                               # put the keys here; .env is gitignored
npm run models                                     # registers the providers in TrueForge
```

### 3. Load the agent definitions

```bash
npm run setup                                                     # lists the models TrueForge knows
npm run setup -- --primary primary/coder --fallback fallback/coder
```

This creates four agents from [`agent/`](agent/): `ciao-forge` and `ciao-forge-fallback` (agent mode), and `ciao-forge-inline` and `ciao-forge-fallback-inline` (a minimal one-tool agent for inline edits). You can do the same from VS Code with **cIAo Forge: Set Up TrueForge Agents**. To switch models later, run it again with different names; nothing in the extension changes.

### 4. Run the extension

Open this folder in VS Code and press `F5` (**Run cIAo Forge**), or install the package:

```bash
npm run package && code --install-extension ciao-forge-0.1.0.vsix
```

In the window that opens, open the repository you want to work on. The extension starts its MCP server on `127.0.0.1` (protected by a random bearer token) and registers it in TrueForge as the `ciao-editor` connector automatically. Open the **cIAo Forge** view in the activity bar.

Settings (`ciaoForge.*`): `trueforgeUrl` (default `http://localhost:8790`; use `localhost`, TrueForge does not listen on `127.0.0.1` on every platform), `agent`, `fallbackAgent`, `tokenBudget` (6000), `maxRetries` (1), `commandPath`, `mcpPort`, `stallTimeoutSeconds`.

## The three fixed tasks on Flask 3.1.3

```bash
git clone https://github.com/pallets/flask && cd flask && git checkout 3.1.3     # commit 22d92470
python -m venv ../flask-venv                       # outside the repo, so `git status` stays clean
../flask-venv/bin/pip install -e . "pytest<9" "werkzeug==3.1.0" asgiref      # Windows: ..\flask-venv\Scripts\pip
```

The pins matter: `tests/test_cli.py` at this tag imports a private pytest name that pytest 9 removed, and with a newer Werkzeug (or without `asgiref`) two unrelated Flask tests fail before any change. A real model that runs the whole suite then wanders off to "fix" them; with these pins the full suite (`pytest -q`, 485 tests) is green on a clean checkout. Set `ciaoForge.commandPath` to the venv's `bin` (or `Scripts`) directory so the agent's `pytest` runs inside it.

**Task A (inline edit).** Open `src/flask/helpers.py`, select the function `get_debug_flag`, press `Ctrl+Shift+I`, and type: *Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.* The review tab opens beside the file with each hunk and its own Accept / Reject; the same hunks appear in the file as CodeLens. Accept. Verify:

```bash
FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"   # False
```

**Task B (agent mode).** In the panel, with no files mentioned, send: *Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "\*\*\*". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.* The panel first shows the context table (which files were chosen, how many tokens, and why). Review and accept the hunks for each file. Click **TrueForge session ↗** to show the run's turns and tool calls in the TrueForge UI. Verify:

```bash
pytest tests/test_cli.py -q
flask --help
flask --app <any app> config
git diff --stat          # three files
```

**Task C (resilience).** Break the primary provider's key: `PRIMARY_API_KEY=invalid npm run models` (or edit the key in the TrueForge UI, or point it at an unreachable URL). Repeat Task A. Run `npm run models` afterwards to restore the real key. The fallback can be a second model, or the same model registered as a second provider (that's what our demo uses). The panel shows that the primary failed and that the fallback agent took over, with no action from you; the diff appears as before. `git status` shows no changes, because nothing is written before you accept.

You can rehearse A and B without the editor, with your real models, through the same code path: `npm run rehearse -- --task A --repo /path/to/flask --bin /path/to/flask-venv/bin`.

## How it works

```
VS Code extension                      TrueForge (local)                 model(s) configured
┌──────────────────────────┐  SDK:     ┌──────────────────────┐          in TrueForge
│ agent panel (webview)    │ sessions, │ agent loop, sessions │ ───────▶ primary / fallback
│ inline edit command      │ turns,    │ streaming, approvals │
│ review tab + CodeLens    │ approvals │ deferred tools,      │
│ turn runner ─────────────┼──────────▶│ compaction, subagents│
│ MCP server (127.0.0.1) ◀─┼───────────│ MCP client           │
│   8 editor tools         │ tool calls└──────────────────────┘
└──────────────────────────┘
```

**Approval drives the diff review.** `propose_edit` requires approval in the agent definition. When TrueForge pauses a turn with `tool.approval_required`, the extension builds the diff from the tool call's arguments and opens the review. Your per-hunk decisions are the approval: if you accept at least one hunk the extension answers `allow`, the tool runs, and only the accepted hunks are written; if you reject them all it answers `deny` with the reason, and the agent is told. `run_command` is approved in the panel.

**No silent writes, and undo.** Proposals live in memory ([`src/core/store.ts`](src/core/store.ts)). A write happens only for accepted hunks, only if the file still matches what the diff was computed against, and goes through a `WorkspaceEdit`, so both `Ctrl+Z` and **cIAo Forge: Undo Last Applied Change** (`Ctrl+Alt+Z`) revert it. Undo refuses if you have edited the file since.

**Cancellation.** Stop aborts the stream, cancels the TrueForge session, discards unreviewed proposals and reverts every change the cancelled run had already applied, newest first, so a multi-file change is never left half done.

**Completeness check.** In agent mode, after a run that applied edits, the extension compares what changed with what the request asked for. If the request says the change must be documented or covered by a test and no such file changed, it sends one follow-up turn in the same TrueForge session naming only what is missing ([`src/core/requirements.ts`](src/core/requirements.ts)).

**Models without tool calling (inline edit).** If the model answers an inline edit with a code block or a tool call written as text instead of calling `propose_edit`, the extension turns that answer into a proposal and shows it in the same per-hunk review ([`extractTextEdit`](src/core/inline.ts)). The model call still runs in TrueForge; nothing is written without review.

**Context.** See the write-up, section 4, or run `npm run context -- /path/to/repo "your request"` to print the plan for any request.

**Resilience.** A failed model call is classified (credentials, unreachable, rate limit, server error). Retryable failures are retried with exponential backoff (`maxRetries`), then the same request is sent to the fallback agent in a new session. If both fail you get one plain message and the workspace is untouched. The extension never re-runs a request after edits were applied.

**Safety.** Tools refuse paths outside the workspace and inside `.git`, and never read, list, index or edit secrets files (`.env*` except examples, keys, `id_rsa`, `.npmrc`, `credentials*.json`, service-account files, `.ssh/`, `.aws/`). `run_command` needs the user's approval in TrueForge, shown with the exact command, and accepts only an allowlist (pytest, flask, read-only git without `--output`, npm test, linters) with no shell operators. The allowlist narrows what the agent can ask for; it is not a sandbox: `pytest` and `flask` execute project code (tests, `conftest.py`, the app), so an approved command can still read or write any file your user account can, without a diff review. `python -c` is deliberately not allowed, because it would let the agent read a secrets file the tools refuse to open. Read the command before you approve it. Commands run with a scrubbed environment: variables that look like keys, tokens or passwords are withheld, so the agent cannot print them back to the model. Read-only tools never go through a shell; model-supplied paths are passed as program arguments. The MCP server listens on loopback only and requires a bearer token.

## Tests

```bash
npm run check          # type-check, 55 unit tests, eligibility guard
npm run e2e            # 55 checks (74 with FLASK_DIR) against a real local TrueForge, scripted models, no API key
FLASK_DIR=/path/to/flask PY_BIN=/path/to/flask-venv/bin npm run e2e    # adds tasks A, B, C on Flask 3.1.3
npm run e2e:vscode     # 14 checks inside a real VS Code window
```

The end-to-end suites use [`scripts/mock-model.mjs`](scripts/mock-model.mjs), a scripted OpenAI-compatible server registered in TrueForge as a model provider, so the complete loop (sessions, turns, MCP calls, approvals, streaming, cancel, fallback) is exercised deterministically. It is test tooling only. Recorded results are in [`test-e2e/`](test-e2e/).

## Repository layout

```
agent/           agent definitions and instructions loaded into TrueForge
src/core/        everything that does not need VS Code: tools, MCP server, runner, context, hunks, store, resilience
src/ui/          agent panel and review tab; src/extension.ts wires it together
media/           webview scripts and styles
scripts/         setup, model registration, rehearsal, end-to-end suites, eligibility guard
config/          example model configuration
docs/            write-up (PDF) and demo script
```

## Licence

MIT. See [LICENSE](LICENSE).
