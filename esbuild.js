const esbuild = require("esbuild");
const fs = require("fs");

const common = { bundle: true, platform: "node", target: "node20", sourcemap: false, logLevel: "warning" };
const builds = [
  { ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", format: "cjs", external: ["vscode"] },
  { ...common, entryPoints: ["scripts/e2e.ts"], outfile: "dist/e2e.js", format: "cjs" },
  { ...common, entryPoints: ["scripts/setup-trueforge.ts"], outfile: "dist/setup-trueforge.js", format: "cjs" },
  { ...common, entryPoints: ["scripts/context-probe.ts"], outfile: "dist/context-probe.js", format: "cjs" },
  { ...common, entryPoints: ["scripts/rehearse.ts"], outfile: "dist/rehearse.js", format: "cjs" },
  { ...common, entryPoints: ["scripts/apply-models.ts"], outfile: "dist/apply-models.js", format: "cjs" },
];

(async () => {
  for (const b of builds) {
    if (!fs.existsSync(b.entryPoints[0])) continue;
    await esbuild.build(b);
  }
  console.log("build ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
