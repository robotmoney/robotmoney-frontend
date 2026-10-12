// Synthetic site probe for a rollout window (issue 1220 (d)).
//   bun scripts/rollout-probe.ts run <url> <receipts.jsonl>     probe every 15 s until killed
//   bun scripts/rollout-probe.ts plan <plan.json>   refuse an unordered plan or a website stop with no owner decision
//   bun scripts/rollout-probe.ts grade <receipts.jsonl> <startMs> <endMs>   postflight grade; exit 1 on failure
import { appendFileSync, readFileSync } from "node:fs";
import { assertRolloutPlan, gradeProbeReceipts, PROBE_INTERVAL_MS, probeOnce, readProbeReceipts } from "./lib/rollout-probe.ts";

const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === "run" && a && b) {
  for (;;) {
    appendFileSync(b, `${JSON.stringify(await probeOnce(a))}\n`);
    await Bun.sleep(PROBE_INTERVAL_MS);
  }
} else if (cmd === "plan" && a) {
  assertRolloutPlan(JSON.parse(readFileSync(a, "utf8")));
  console.log("rollout plan ok");
} else if (cmd === "grade" && a && b && c) {
  const grade = gradeProbeReceipts(readProbeReceipts(a), { start: Number(b), end: Number(c) });
  console.log(JSON.stringify(grade));
  process.exit(grade.ok ? 0 : 1);
} else {
  console.error("usage: rollout-probe.ts run <url> <receipts> | plan <plan.json> | grade <receipts> <startMs> <endMs>");
  process.exit(2);
}
