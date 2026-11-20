// Create or update the cIAo Forge agents in a local TrueForge from the committed definitions in agent/.
//
//   npm run setup -- --primary <provider/model> --fallback <provider/model>
//   (or FORGE_PRIMARY_MODEL / FORGE_FALLBACK_MODEL; with no arguments it lists the models TrueForge knows)
//
// Models are whatever you configured in TrueForge (Settings -> Models): this
// script never talks to a model provider and has no provider-specific code.
import * as path from "node:path";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { listModelNames, loadAgentDefs, upsertAgents } from "../src/core/setup";
import { START_HINT } from "../src/core/resilience";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<void> {
  const baseUrl = arg("url") ?? process.env.TRUEFORGE_URL ?? "http://localhost:8790";
  const client = new TrueForge({ baseUrl });
  let models: string[];
  try {
    models = await listModelNames(client);
  } catch {
    console.error(`TrueForge is not reachable at ${baseUrl}. Start it first:\n  ${START_HINT}`);
    process.exit(2);
  }
  const primary = arg("primary") ?? process.env.FORGE_PRIMARY_MODEL;
  const fallback = arg("fallback") ?? process.env.FORGE_FALLBACK_MODEL ?? primary;
  if (!primary || !fallback) {
    console.log(`Models configured in TrueForge at ${baseUrl}:`);
    console.log(models.length ? models.map((m) => `  ${m}`).join("\n") : "  (none yet: add a provider under Settings -> Models in the TrueForge UI)");
    console.log("\nUsage: npm run setup -- --primary <provider/model> --fallback <provider/model>");
    process.exit(models.length ? 0 : 1);
  }
  for (const m of [primary, fallback]) {
    if (!models.includes(m)) {
      console.error(`"${m}" is not a model TrueForge knows. Configured models: ${models.join(", ") || "(none)"}`);
      process.exit(1);
    }
  }
  const done = await upsertAgents(client, loadAgentDefs(path.resolve(__dirname, "..")), { primary, fallback });
  console.log(`Agents ready in TrueForge:\n${done.map((d) => `  ${d}`).join("\n")}`);
  console.log('\nThe "ciao-editor" MCP server is registered automatically when the VS Code extension starts.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
