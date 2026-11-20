# Demo video script (target 3:45, hard limit 4:00)

Rules from the brief: tasks **A, B, C in that order**, each followed by its on-screen verification; show the **TrueForge session** briefly during B; you may cut model waiting time, but **never cut between giving an instruction and the diff appearing**; editor visible throughout; public link.

## Before you record (not in the video)

1. TrueForge running with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'`, `npm run models` done (providers `primary` and `fallback`, both Mercury 2 in our setup), then `npm run setup -- --primary primary/coder --fallback fallback/coder`.
2. Flask at tag `3.1.3`, clean (`git status` empty), venv **outside** the repo with `pip install -e . "pytest<9" "werkzeug==3.1.0" asgiref` (full `pytest -q` green before you start), and `ciaoForge.commandPath` pointing at the venv's `bin`/`Scripts`.
3. Rehearse with the real models first: `npm run rehearse -- --task A --repo <flask> --bin <venv bin>` and `--task B`. If Task B does not pass with your primary model, swap models now, not during recording.
4. VS Code window: Flask folder open, font size 15+, the **cIAo Forge** view dragged to the secondary side bar (right) and made wide enough for the context table, integrated terminal open at the bottom with the venv activated, TrueForge UI (`http://localhost:8790`) open in a browser window beside it.
5. A small Flask app for the Task B check, outside the repo, e.g. `demo_app.py`:
   `from flask import Flask; app = Flask(__name__); app.config.update(SECRET_KEY="s3cr3t", DB_PASSWORD="pw", API_TOKEN="t", PLAIN="visible")`
6. Have the three instructions on the clipboard manager or a notes file. They must be typed or pasted **exactly**.

## Task A: inline edit (0:00 to 0:50)

| Time | Do | Say / caption |
| --- | --- | --- |
| 0:00 | Open `src/flask/helpers.py`, select the whole function `get_debug_flag`. | "Task A, inline edit." |
| 0:05 | Press `Ctrl+Shift+I`. Paste: *Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.* Enter. | Do not cut from here until the diff is on screen. |
| 0:15 | The review tab opens beside the file. Point at the two hunks, each with its own **Accept hunk / Reject hunk**, and at the CodeLens in the file. | "Nothing is on disk yet. Each hunk has its own accept and reject." |
| 0:25 | Click **Accept hunk** on each hunk (one at a time, so per-hunk is visible). | |
| 0:35 | Terminal: `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` → `False`. (PowerShell: `$env:FLASK_DEBUG="off"; python -c "…"`) | "Verified." |
| 0:42 | Press `Ctrl+Alt+Z` (Undo Last Applied Change). Show the file restored and `git status` clean. Then redo Task A's accept **only if** you want the change kept; simplest is to leave it undone. | "And an applied change can be undone." (This is the B2 undo shot.) |

## Task B: agent mode (0:50 to 2:35)

| Time | Do | Say / caption |
| --- | --- | --- |
| 0:50 | Click **New** in the panel. Paste, with no files mentioned: *Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "\*\*\*". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.* Enter. | "Task B. I name no files." |
| 0:58 | The **context table** appears first. Hold on it for 3 seconds: `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`, tokens used out of 6000, and the "why it was chosen" column. | "It picked these files itself, within a 6,000-token budget, and says why." (B1) |
| 1:05 | Tokens stream; tool calls appear in the timeline (`gather_context`, `read_file`, …). You may cut waiting here. | |
| 1:20 | First diff (`cli.py`) opens for review. Accept its hunks. Repeat for `tests/test_cli.py` and `docs/cli.rst`. Do not cut between a diff appearing and your accept. | "Three files, reviewed hunk by hunk." |
| 1:50 | Approve the agent's `pytest` command in the panel when asked. | |
| 2:00 | Click **TrueForge session ↗**. In the TrueForge UI show the turn, its tool calls and the approval events. Hold about 8 seconds. Scroll to the `get_tool_info` → `call_tool` (`explain_history`) step: the agent loads that deferred tool before it changes `cli.py` (it did in every rehearsal with the current instructions). | "Same run in TrueForge: turns, tool calls, an approval for every edit, and a deferred tool loaded on demand." (eligibility + B4) |
| 2:12 | Terminal: `pytest tests/test_cli.py -q` → passing. | |
| 2:20 | `flask --help` → `config` listed. `flask --app demo_app config` → JSON with `"***"`. | |
| 2:30 | `git diff --stat` → three files. | "Three files, none named." |

## Task C: resilience (2:35 to 3:40)

| Time | Do | Say / caption |
| --- | --- | --- |
| 2:35 | `git stash` or `git checkout .` so the tree is clean; show `git status` clean. In a second terminal (in the cIAo Forge folder) run `PRIMARY_API_KEY=invalid npm run models`, or in the TrueForge UI replace the **primary** provider's key with `invalid`. | "Task C. The primary model now has an invalid key." |
| 2:50 | Back in VS Code: select `get_debug_flag` again, `Ctrl+Shift+I`, paste the Task A instruction, Enter. | No cut until the diff appears. |
| 2:58 | The panel shows: *Primary agent "ciao-forge-inline" failed: the model provider rejected the credentials… Switching automatically to the fallback agent…* then the diff appears. Scroll or type in the editor while it works to show it is responsive. | "No action from me: the second configured model took over." (B3) |
| 3:15 | With the diff still awaiting review, terminal: `git status` → clean. | "Nothing is written until I accept." |
| 3:22 | Click **Reject all**. `git status` again → no files changed. | "Workspace unchanged." |
| 3:30 | **Required (A3, 10 points).** Restore the key first (`npm run models`). In the panel send the Task B request again; when the first diff appears, accept one hunk, then press **■ Stop** while it is still streaming. Show the message naming the file it rolled back, then `git status` → clean. | "Cancel is immediate, and the hunk it had already applied is rolled back: no half-applied edits." |
| 3:40 | End. Restore the real key after recording: `npm run models`. | |

## After recording

- Upload (YouTube unlisted or Drive "anyone with the link"), open the link in a signed-out window.
- Put the timestamps into the Scorecard in `docs/WRITEUP.md`, fill the team table, Team ID, model table and links, then `npm run writeup` to re-render `docs/WRITEUP.pdf` (must stay within 3 pages).
- If a shot did not happen in your take (for example the model never used a deferred tool), change that Scorecard claim so it matches what the video shows.
