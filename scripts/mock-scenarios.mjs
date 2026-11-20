// Scripted behaviours for scripts/mock-model.mjs (offline tests only).
// Each scenario matches on the latest user message and plays one step per
// model call; the step index is the number of tool results seen so far.

const slowText = Array.from({ length: 400 }, (_, i) => `token${i} `).join("");

export const scenarios = [
  {
    name: "slow-stream",
    match: (t) => /SLOW_STREAM_TEST/.test(t),
    steps: [{ text: slowText, delay: 40 }],
  },
  {
    name: "slow-then-edit",
    // Streams, proposes an edit to a.txt, then streams slowly again so a test
    // can cancel AFTER one edit was applied and check it is rolled back.
    match: (t) => /CANCEL_AFTER_EDIT_TEST/.test(t),
    steps: [
      { text: "Editing a.txt first. ", tools: [{ name: "propose_edit", args: { path: "a.txt", edits: [{ old_text: "alpha", new_text: "ALPHA" }], rationale: "test" } }] },
      { text: slowText, delay: 40 },
    ],
  },
  {
    name: "text-tool-call",
    // First reply spells the tool call out as JSON text (as some small models do);
    // after the extension's nudge it makes the real call.
    match: (t) => /TEXT_TOOL_CALL_TEST/.test(t) || /tool call written as text/.test(t),
    steps: [
      ({ userText }) =>
        /tool call written as text/.test(userText)
          ? { text: "Calling the tool now. ", tools: [{ name: "propose_edit", args: { path: "a.txt", edits: [{ old_text: "alpha", new_text: "ALPHA" }] } }] }
          : { text: '```json\n{"name": "propose_edit", "arguments": {"path": "a.txt", "edits": [{"old_text": "alpha", "new_text": "ALPHA"}]}}\n```' },
      { text: "Done." },
    ],
  },
  {
    name: "deferred-tool",
    // Uses a deferred tool the way TrueForge's deferred tool loading requires: discover, then call.
    match: (t) => /DEFERRED_TOOL_TEST/.test(t),
    steps: [
      { text: "Loading the deferred tool definition. ", tools: [{ name: "get_tool_info", args: { mcp_server: "ciao-editor", tool_name: "find_symbol" } }] },
      { text: "Calling it. ", tools: [{ name: "call_tool", args: { mcp_server: "ciao-editor", tool_name: "find_symbol", input: { name: "greet" } } }] },
      ({ toolResults }) => ({ text: `find_symbol said: ${(toolResults.at(-1) ?? "").slice(0, 200)}` }),
    ],
  },
  {
    name: "echo-tools",
    match: (t) => /LIST_TOOLS_TEST/.test(t),
    steps: [{ text: "ok" }],
  },
  {
    name: "multi-file",
    match: (t) => /MULTI_FILE_TEST/.test(t),
    steps: [
      { text: "Looking for the relevant files. ", tools: [{ name: "gather_context", args: { query: "greeting message shout" } }] },
      { text: "Reading the module. ", tools: [{ name: "read_file", args: { path: "pkg/greet.py" } }] },
      { text: "Updating the implementation. ", tools: [{ name: "propose_edit", args: { path: "pkg/greet.py", edits: [{ old_text: 'return "hello"', new_text: 'return "hello, world"' }], rationale: "new greeting" } }] },
      { text: "Updating the test. ", tools: [{ name: "propose_edit", args: { path: "tests/test_greet.py", edits: [{ old_text: '== "hello"', new_text: '== "hello, world"' }], rationale: "keep the test in sync" } }] },
      { text: "Documenting it. ", tools: [{ name: "propose_edit", args: { path: "docs/greet.md", new_content: "# greet\n\nReturns `hello, world`.\n", rationale: "new doc page" } }] },
      { text: "Done: changed pkg/greet.py, tests/test_greet.py and docs/greet.md." },
    ],
  },
  {
    name: "task-a",
    match: (t) => /get_debug_flag/.test(t) && /'off'|off/.test(t),
    steps: [
      {
        text: "I'll extend the false-value set in `get_debug_flag` and update its docstring. ",
        tools: [
          {
            name: "propose_edit",
            args: {
              path: "src/flask/helpers.py",
              rationale: "Treat 'off' and 'n' as false, case-insensitively, and list every false value in the docstring.",
              edits: [
                {
                  old_text:
                    '    """Get whether debug mode should be enabled for the app, indicated by the\n    :envvar:`FLASK_DEBUG` environment variable. The default is ``False``.\n    """\n    val = os.environ.get("FLASK_DEBUG")\n    return bool(val and val.lower() not in {"0", "false", "no"})',
                  new_text:
                    '    """Get whether debug mode should be enabled for the app, indicated by the\n    :envvar:`FLASK_DEBUG` environment variable. The default is ``False``.\n\n    The values ``0``, ``false``, ``no``, ``off`` and ``n`` are treated as\n    false, case-insensitively. An unset or empty variable is also false.\n    Any other value enables debug mode.\n    """\n    val = os.environ.get("FLASK_DEBUG")\n    return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})',
                },
              ],
            },
          },
        ],
      },
      ({ toolResults }) => ({ text: `Finished. Result of the proposal: ${(toolResults.at(-1) ?? "").slice(0, 160)}` }),
    ],
  },
  {
    name: "task-b",
    match: (t) => /flask config/.test(t) && /masking/i.test(t),
    steps: [
      { text: "First I'll find where the built-in commands are defined, tested and documented. ", tools: [{ name: "gather_context", args: { query: "built-in CLI command routes shell run flask --help test documented" } }] },
      { text: "Reading the command definitions. ", tools: [{ name: "search_workspace", args: { query: "routes_command" } }] },
      { text: "Checking how the existing commands got there. ", tools: [{ name: "get_tool_info", args: { mcp_server: "ciao-editor", tool_name: "explain_history" } }] },
      { text: "", tools: [{ name: "call_tool", args: { mcp_server: "ciao-editor", tool_name: "explain_history", input: { path: "src/flask/cli.py" } } }] },
      {
        text: "Adding the `config` command next to `routes`. ",
        tools: [
          {
            name: "propose_edit",
            args: {
              path: "src/flask/cli.py",
              rationale: "New built-in `flask config` command with secret masking; registered on FlaskGroup so it shows in --help.",
              edits: [
                { old_text: "from __future__ import annotations\n\nimport ast\n", new_text: "from __future__ import annotations\n\nimport ast\nimport json\n" },
                {
                  old_text: "            self.add_command(routes_command)\n",
                  new_text: "            self.add_command(routes_command)\n            self.add_command(config_command)\n",
                },
                {
                  old_text: 'cli = FlaskGroup(\n    name="flask",',
                  new_text:
                    '_SENSITIVE_CONFIG_MARKERS = ("SECRET", "PASSWORD", "TOKEN", "KEY")\n\n\n@click.command("config", short_help="Show the app\'s configuration as JSON.")\n@with_appcontext\ndef config_command() -> None:\n    """Print the loaded application\'s configuration as JSON.\n\n    The value of any key containing ``SECRET``, ``PASSWORD``, ``TOKEN`` or\n    ``KEY`` is replaced with ``"***"``.\n    """\n    masked = {\n        key: "***"\n        if any(marker in key.upper() for marker in _SENSITIVE_CONFIG_MARKERS)\n        else value\n        for key, value in current_app.config.items()\n    }\n    click.echo(json.dumps(masked, indent=2, sort_keys=True, default=str))\n\n\ncli = FlaskGroup(\n    name="flask",',
                },
              ],
            },
          },
        ],
      },
      {
        text: "Covering it with a test. ",
        tools: [
          {
            name: "propose_edit",
            args: {
              path: "tests/test_cli.py",
              rationale: "Test that `flask config` prints JSON, masks sensitive keys and is listed in --help.",
              edits: [
                {
                  old_text: "def test_cli_empty(app):",
                  new_text:
                    'def test_config_command_masks_secrets(runner):\n    def create_app():\n        app = Flask("configapp")\n        app.config["SECRET_KEY"] = "s3cr3t"\n        app.config["DB_PASSWORD"] = "hunter2"\n        app.config["API_TOKEN"] = "abc"\n        app.config["GREETING"] = "hello"\n        return app\n\n    cli = FlaskGroup(create_app=create_app)\n    result = runner.invoke(cli, ["config"])\n    assert result.exit_code == 0\n    data = json.loads(result.output)\n    assert data["SECRET_KEY"] == "***"\n    assert data["DB_PASSWORD"] == "***"\n    assert data["API_TOKEN"] == "***"\n    assert data["GREETING"] == "hello"\n    assert "s3cr3t" not in result.output\n\n\ndef test_config_command_in_help(runner):\n    cli = FlaskGroup(create_app=lambda: Flask("configapp"))\n    result = runner.invoke(cli, ["--help"])\n    assert result.exit_code == 0\n    assert "config" in result.output\n\n\ndef test_cli_empty(app):',
                },
                { old_text: "import importlib.metadata\n", new_text: "import importlib.metadata\nimport json\n" },
              ],
            },
          },
        ],
      },
      {
        text: "Documenting it alongside the other built-in commands. ",
        tools: [
          {
            name: "propose_edit",
            args: {
              path: "docs/cli.rst",
              rationale: "Document `flask config` in the CLI docs next to the other built-in commands.",
              edits: [
                {
                  old_text: ".. _dotenv:\n\nEnvironment Variables From dotenv\n---------------------------------\n",
                  new_text:
                    'Show the Configuration\n----------------------\n\nThe ``config`` command prints the loaded application\'s configuration as\nJSON. The value of any key containing ``SECRET``, ``PASSWORD``, ``TOKEN``\nor ``KEY`` is masked as ``"***"`` so the output is safe to share.\n\n.. code-block:: text\n\n    $ flask --app hello config\n    {\n      "DEBUG": false,\n      "SECRET_KEY": "***",\n      ...\n    }\n\n\n.. _dotenv:\n\nEnvironment Variables From dotenv\n---------------------------------\n',
                },
              ],
            },
          },
        ],
      },
      { text: "Verifying with the test suite. ", tools: [{ name: "run_command", args: { command: "python -m pytest tests/test_cli.py -q" } }] },
      ({ toolResults }) => ({
        text: `Done. I added the \`flask config\` command in src/flask/cli.py, tests in tests/test_cli.py and docs in docs/cli.rst. Test run: ${(toolResults.at(-1) ?? "").slice(-200)}`,
      }),
    ],
  },
];
