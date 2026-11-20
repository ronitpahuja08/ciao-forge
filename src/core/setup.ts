import * as fs from "node:fs";
import * as path from "node:path";
import type { TrueForge } from "@truefoundry/trueforge-sdk";
import { MCP_SERVER_NAME } from "./mcpServer";

export interface AgentDef {
  name: string;
  description: string;
  manifest: { model: { name: string }; instructions?: string; [k: string]: unknown };
}

/** Load the committed agent definitions from `agent/`, inlining `@file:` instruction references. */
export function loadAgentDefs(projectDir: string): AgentDef[] {
  const dir = path.join(projectDir, "agent");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".agent.json"))
    .sort()
    .map((f) => {
      const def = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as AgentDef;
      const ins = def.manifest.instructions;
      if (typeof ins === "string" && ins.startsWith("@file:")) {
        def.manifest.instructions = fs.readFileSync(path.join(projectDir, ins.slice("@file:".length)), "utf8");
      }
      return def;
    });
}

/** Point TrueForge at the editor's MCP server (Settings -> Connectors -> ciao-editor). Idempotent. */
export async function registerMcp(client: TrueForge, url: string, token: string): Promise<void> {
  await client.settings.mcpServers.createOrUpdate({
    manifest: {
      type: "remote",
      name: MCP_SERVER_NAME,
      description: "cIAo Forge editor tools: read, search, gather context, propose edits for review, run verification commands.",
      url,
      auth: { type: "header", headers: { Authorization: `Bearer ${token}` } },
    },
  });
}

async function listAgents(client: TrueForge): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  const page = (await client.agents.list({})) as unknown as AsyncIterable<{ id: string; name: string }> & { data?: Array<{ id: string; name: string }> };
  for await (const a of page) out.push({ id: a.id, name: a.name });
  return out;
}

/** Create or update the two agents with the chosen models (any model configured in TrueForge). */
export async function upsertAgents(client: TrueForge, defs: AgentDef[], models: { primary: string; fallback: string }): Promise<string[]> {
  const existing = await listAgents(client);
  const done: string[] = [];
  for (const def of defs) {
    const model = def.name.includes("-fallback") ? models.fallback : models.primary;
    const body = { name: def.name, description: def.description, manifest: { ...def.manifest, model: { ...def.manifest.model, name: model } } };
    const found = existing.find((a) => a.name === def.name);
    if (found) await client.agents.update(found.id, { description: body.description, manifest: body.manifest } as never);
    else await client.agents.create(body as never);
    done.push(`${def.name} -> ${model}`);
  }
  return done;
}

export async function listModelNames(client: TrueForge): Promise<string[]> {
  const r = (await client.models.list()) as unknown as { data?: Array<{ name: string }> };
  return (r.data ?? []).map((m) => m.name);
}
