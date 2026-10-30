// `npm run doctor` — checks this machine is ready to run AgentStudio (and live work). Read-only, spends nothing.
import { runChecks } from "../src/doctor.js";

const ICON = { ok: "✅", warn: "⚠️ ", fail: "❌", info: "ℹ️ " } as const;
const checks = await runChecks({ network: !process.argv.includes("--offline") });
let group = "";
for (const c of checks) {
  if (c.group !== group) {
    group = c.group;
    console.log(`\n${group}`);
  }
  console.log(`  ${ICON[c.status]} ${c.label.padEnd(34)} ${c.detail}`);
  if (c.fix && c.status !== "ok") console.log(`     → ${c.fix}`);
}
const failed = checks.filter((c) => c.status === "fail").length;
const warned = checks.filter((c) => c.status === "warn").length;
console.log(`\n${failed ? `❌ ${failed} problem(s)` : "✅ Ready"}${warned ? ` · ⚠️  ${warned} warning(s)` : ""}`);
process.exit(failed ? 1 : 0);
