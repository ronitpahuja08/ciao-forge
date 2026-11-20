// Print the context plan for a request: node dist/context-probe.js <repo> "<request>" [budget]
import { buildIndex, planContext, renderPlan } from "../src/core/context";
const [repo, request, budget] = process.argv.slice(2);
const t0 = Date.now();
const index = buildIndex(repo);
const t1 = Date.now();
const plan = planContext(index, request, { budget: budget ? Number(budget) : 6000 });
console.log(renderPlan(plan, false));
console.log(`\n(index ${t1 - t0} ms, ${index.chunks.length} chunks; plan ${Date.now() - t1} ms)`);
