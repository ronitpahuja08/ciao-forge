import * as http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { tools, type ToolHost, type ToolResult } from "./tools";

export const MCP_SERVER_NAME = "ciao-editor";

/**
 * The editor's capabilities, exposed to the TrueForge agent as MCP tools.
 * The agent (not the extension) decides what to read, search, change and run.
 */
function buildServer(host: ToolHost): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: "0.1.0" });
  const wrap = (fn: () => Promise<ToolResult>) => async () => {
    try {
      const r = await fn();
      return { content: [{ type: "text" as const, text: r.text }], isError: r.isError === true };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `tool failed: ${(e as Error).message}` }], isError: true };
    }
  };
  const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  /**
   * Some models call a tool directly but wrap its arguments the way TrueForge's
   * deferred-tool `call_tool` expects: {mcp_server, tool_name, input: {...}}.
   * Accept both shapes: every field becomes optional at the top level, `input`
   * is allowed, and handlers receive the unwrapped arguments.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lenient = (shape: Record<string, z.ZodTypeAny>): any => {
    const out: Record<string, z.ZodTypeAny> = {};
    for (const [k, v] of Object.entries(shape)) out[k] = v.isOptional() ? v : v.optional();
    out.input = z.any().optional();
    out.mcp_server = z.string().optional();
    out.tool_name = z.string().optional();
    return out;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const un = (a: any): any => {
    if (a && typeof a === "object" && a.input && typeof a.input === "object") {
      const { input, mcp_server: _s, tool_name: _t, ...rest } = a;
      return { ...rest, ...input };
    }
    if (a && typeof a === "object") { const { mcp_server: _s, tool_name: _t, input: _i, ...rest } = a; return rest; }
    return a;
  };

  server.registerTool(
    "gather_context",
    {
      title: "Gather relevant context",
      description:
        "Retrieve the most relevant code and docs for a query from the whole workspace within a fixed token budget. Returns a table of chosen files with the reason each was chosen, followed by the excerpts. Call this first for any task where you do not already know which files matter; it also returns the matching tests and docs.",
      inputSchema: lenient({ query: z.string().describe("What you are looking for, in words and identifiers"), budget_tokens: z.number().optional().describe("Optional smaller token budget") }),
      annotations: ro,
    },
    (a: any) => wrap(() => tools.gather_context(host, un(a)))(),
  );
  server.registerTool(
    "read_file",
    {
      title: "Read a file",
      description: "Read a workspace file with line numbers. Reads at most 400 lines per call; pass start_line/end_line for a specific range.",
      inputSchema: lenient({ path: z.string().describe("Workspace-relative path"), start_line: z.number().optional(), end_line: z.number().optional() }),
      annotations: ro,
    },
    (a: any) => wrap(() => tools.read_file(host, un(a)))(),
  );
  server.registerTool(
    "search_workspace",
    {
      title: "Search the workspace",
      description: "Case-insensitive text search across workspace files (set regex=true for a regular expression). Returns path:line: text. Use it to confirm a symbol or string really exists before editing.",
      inputSchema: lenient({ query: z.string(), regex: z.boolean().optional(), path_prefix: z.string().optional().describe("Only search under this directory"), max_results: z.number().optional() }),
      annotations: ro,
    },
    (a: any) => wrap(() => tools.search_workspace(host, un(a)))(),
  );
  server.registerTool(
    "find_symbol",
    {
      title: "Find a symbol definition",
      description: "Find where a function, class or type is defined. Says clearly when no such symbol exists.",
      inputSchema: lenient({ name: z.string() }),
      annotations: ro,
    },
    (a: any) => wrap(() => tools.find_symbol(host, un(a)))(),
  );
  server.registerTool(
    "list_files",
    {
      title: "List files",
      description: "List workspace files, optionally under a directory and/or whose path contains a substring.",
      inputSchema: lenient({ directory: z.string().optional(), contains: z.string().optional() }),
      annotations: ro,
    },
    (a: any) => wrap(() => tools.list_files(host, un(a)))(),
  );
  server.registerTool(
    "explain_history",
    {
      title: "Explain why code is the way it is",
      description: "Return the last commits (hash, date, author, message) that touched a file or a specific line. Use it before changing code whose intent is not obvious.",
      inputSchema: lenient({ path: z.string(), line: z.number().optional() }),
      annotations: ro,
    },
    (a: any) => wrap(() => tools.explain_history(host, un(a)))(),
  );
  server.registerTool(
    "propose_edit",
    {
      title: "Propose an edit for user review",
      description:
        "Propose a change to one file. This is the ONLY way to change files. Nothing is written until the user has reviewed the diff hunk by hunk in the editor; only accepted hunks are applied. Prefer `edits`: a list of {old_text, new_text} where old_text is copied exactly from the file and matches exactly one place. Use `new_content` only to create a new file. The result says which hunks the user accepted.",
      inputSchema: lenient({
        path: z.string().describe("Workspace-relative path"),
        edits: z.array(z.object({ old_text: z.string(), new_text: z.string() })).optional().describe("Search/replace edits; each old_text must match exactly once"),
        new_content: z.string().optional().describe("Full content, only for creating a new file"),
        rationale: z.string().optional().describe("One sentence shown to the user above the diff"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (a: any) => wrap(() => tools.propose_edit(host, un(a)))(),
  );
  server.registerTool(
    "run_command",
    {
      title: "Run a verification command",
      description: "Run an allowlisted command in the workspace root after user approval: pytest, python -m pytest, flask, python -c, git status/diff/log/show, npm test, linters. No shell operators. Use it to verify your change.",
      inputSchema: lenient({ command: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (a: any) => wrap(() => tools.run_command(host, un(a)))(),
  );
  return server;
}

export interface RunningMcp {
  port: number;
  url: string;
  token: string;
  close(): Promise<void>;
}

function tokenOk(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header ?? "");
  const want = Buffer.from(`Bearer ${token}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Start the MCP server on loopback only, protected by a bearer token. Stateless: one transport per request. */
export async function startMcpServer(host: ToolHost, opts: { port: number; token: string }): Promise<RunningMcp> {
  const srv = http.createServer(async (req, res) => {
    try {
      if (!req.url?.startsWith("/mcp")) {
        res.writeHead(404).end();
        return;
      }
      if (!tokenOk(req.headers.authorization, opts.token)) {
        res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json", allow: "POST" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
        return;
      }
      let raw = "";
      for await (const c of req) raw += c;
      const body = raw ? JSON.parse(raw) : undefined;
      const server = buildServer(host);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      host.log?.(`mcp request failed: ${(e as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
      }
    }
  });
  // Tool calls wait for a human review, so never time the socket out.
  srv.requestTimeout = 0;
  srv.headersTimeout = 0;
  srv.keepAliveTimeout = 0;
  srv.timeout = 0;
  const listen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      srv.once("error", onErr);
      srv.listen(port, "127.0.0.1", () => {
        srv.off("error", onErr);
        resolve((srv.address() as { port: number }).port);
      });
    });
  let port: number;
  try {
    port = await listen(opts.port);
  } catch {
    port = await listen(0); // preferred port busy (e.g. a second window): take any free one
  }
  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    token: opts.token,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}
