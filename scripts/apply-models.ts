// Register model providers in a local TrueForge from a JSON file (default: config/models.json).
// Keys are never stored in the file: "${NAME}" placeholders are filled from the environment or .env.
//
//   cp config/models.example.json config/models.json   # edit providers/models
//   cp .env.example .env                                # put your keys here (gitignored)
//   npm run models
//
// This only configures TrueForge (the same thing its Settings -> Models screen does).
// The extension itself never contacts a model provider.
import * as fs from "node:fs";
import * as path from "node:path";
import { TrueForge } from "@truefoundry/trueforge-sdk";

const project = path.resolve(__dirname, "..");
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  const file = path.join(project, ".env");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      // A variable already set in the shell wins, so `PRIMARY_API_KEY=invalid npm run models` breaks the primary for Task C.
      if (m && !line.trim().startsWith("#") && !process.env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

async function main(): Promise<void> {
  const file = path.resolve(project, arg("file") ?? "config/models.json");
  if (!fs.existsSync(file)) {
    console.error(`${file} not found. Copy config/models.example.json to config/models.json and edit it.`);
    process.exit(1);
  }
  const env = loadEnv();
  const missing = new Set<string>();
  const raw = fs.readFileSync(file, "utf8").replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    if (!env[name]) missing.add(name);
    return env[name] ?? "";
  });
  if (missing.size) {
    console.error(`Missing environment variable(s): ${[...missing].join(", ")}. Put them in .env (gitignored) or export them.`);
    process.exit(1);
  }
  const cfg = JSON.parse(raw) as { trueforgeUrl?: string; providers: Array<Record<string, unknown>> };
  const client = new TrueForge({ baseUrl: arg("url") ?? process.env.TRUEFORGE_URL ?? cfg.trueforgeUrl ?? "http://localhost:8790" });
  for (const p of cfg.providers) {
    await client.settings.modelProviders.createOrUpdate({ manifest: p } as never);
    console.log(`provider ready: ${String(p.name ?? p.type)}`);
  }
  const models = (await client.models.list()) as unknown as { data: Array<{ name: string }> };
  console.log(`\nModels now available in TrueForge:\n${models.data.map((m) => `  ${m.name}`).join("\n")}`);
  console.log("\nNext: npm run setup -- --primary <provider/model> --fallback <provider/model>");
}

main().catch((e) => {
  const err = e as { message?: string; body?: { error?: { message?: string } } };
  console.error(err.body?.error?.message ?? err.message ?? e);
  process.exit(1);
});
