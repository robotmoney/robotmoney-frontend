// `bun run rules:check <rule.json> [--universe <path>] [--allow-outside-universe]`
// Validates a rule file (issue 1401): its shape, weights summing to 100, bands
// containing the neutral weight, signal names, then its holdings against the
// Base asset universe (issue 1400). Prints one line per problem to stderr.
// Exit 0: valid, or universe findings allowed by --allow-outside-universe.
// Exit 2: an invalid file, universe findings, or a usage error.
// Exit 1: an unreadable or malformed JSON file.
import { ALLOW_OUTSIDE_FLAG, UNIVERSE_FLAG, universeFromArgs } from "./universe-option.ts";
import { ruleUniverseErrors, validateRuleFile } from "../src/allocate/rules.ts";
import type { RuleFile } from "../src/allocate/types.ts";

const USAGE = `usage: bun run rules:check <rule.json> [${UNIVERSE_FLAG} <path>] [${ALLOW_OUTSIDE_FLAG}]`;
const args = process.argv.slice(2);
const unknown = args.filter((a) => a.startsWith("--") && a !== UNIVERSE_FLAG && a !== ALLOW_OUTSIDE_FLAG);
if (unknown.length) {
  console.error(`unknown option(s): ${unknown.join(" ")}\n${USAGE}`);
  process.exit(2);
}
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== UNIVERSE_FLAG);
if (!file) {
  console.error(USAGE);
  process.exit(2);
}

try {
  const universe = await universeFromArgs(args);
  const data = JSON.parse(await Bun.file(file).text());
  const errors = validateRuleFile(data, { universe, allowOutsideUniverse: true });
  for (const e of errors) console.error(`invalid: ${e}`);
  if (errors.length) process.exit(2);
  const allowed = args.includes(ALLOW_OUTSIDE_FLAG);
  const outside = ruleUniverseErrors(data as RuleFile, universe);
  const prefix = allowed ? "warning (allowed by --allow-outside-universe)" : "refused";
  for (const e of outside) console.error(`${prefix}: ${e}`);
  if (outside.length && !allowed) process.exit(2);
  const rule = data as RuleFile;
  console.error(`ok: ${rule.id} (${rule.status}) is a valid rule file${outside.length ? "" : `, inside the universe (${universe.assets.length} assets, exported ${universe.exported})`}`);
  process.exit(0);
} catch (e) {
  console.error(`${(e as Error).name}: ${(e as Error).message}`);
  // A missing --universe path (RangeError) is a usage error: exit 2, like regime.ts.
  process.exit(e instanceof RangeError ? 2 : 1);
}
