// Explicit LIVE v0-roster regeneration command (R11 follow-up —
// docs/audits/v0-v1-parity/R11-projects-supabase-audit.md §6). The ONLY way
// the committed backend/src/projects/seed/v0-roster-data.json +
// .manifest.json pair is produced or replaced — NEVER implicit during
// migrations, demo boot, or required per-PR CI (no other code path imports
// roster-seed-generator.ts). An operator runs it deliberately, with read-only
// anon-key access to v0's Supabase, reviews the printed row counts and
// skip/mapping notes, then commits the result.
//
// Usage:
//   V0_ANALYTICS_SUPABASE_URL=https://<ref>.supabase.co \
//   V0_ANALYTICS_SUPABASE_ANON_KEY=<anon key> \
//     bun run scripts/projects-roster-seed-regenerate.ts
//
// (also registered as `bun run projects-roster-seed:regenerate` —
// backend/package.json)
//
// Credentials are read ONLY from the environment (never written to a tracked
// file, never logged). Running with either variable unset FAILS LOUDLY —
// resolveV0SupabaseConfig throws — rather than silently falling back to a
// fabricated/synthetic roster.
import {
  DEFAULT_ROSTER_SEED_MANIFEST_PATH,
  DEFAULT_ROSTER_SEED_PATH,
  replaceRosterSeedAtomically,
} from "../src/projects/seed/roster-seed.ts";
import { generateV0RosterArtifact, resolveV0SupabaseConfig } from "../src/projects/seed/roster-seed-generator.ts";

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export async function main(): Promise<void> {
  const cfg = resolveV0SupabaseConfig();
  console.log(`[projects-roster-seed-regenerate] pulling the 6-table-scope v0 roster from ${cfg.url} ...`);

  const { projects, manifest, stats } = await generateV0RosterArtifact(cfg);

  console.log(
    `[projects-roster-seed-regenerate] projects ${stats.projectsIncluded}/${stats.projectsTotal} ` +
      `agents ${stats.agentsIncluded}/${stats.agentsTotal} coins ${stats.coinsIncluded}/${stats.coinsTotal} ` +
      `wallets ${stats.walletsIncluded}/${stats.walletsTotal} vaults ${stats.vaultsIncluded}/${stats.vaultsTotal}`,
  );
  for (const line of stats.notes) console.warn(`[projects-roster-seed-regenerate] note: ${line}`);

  const outPath = arg("out") ?? DEFAULT_ROSTER_SEED_PATH;
  const manifestOutPath = arg("manifest-out") ?? DEFAULT_ROSTER_SEED_MANIFEST_PATH;
  replaceRosterSeedAtomically(outPath, manifestOutPath, projects, manifest);
  console.log(
    `[projects-roster-seed-regenerate] wrote ${outPath} + ${manifestOutPath} (atomic replace, prior pair untouched on any failure)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(
      `[projects-roster-seed-regenerate] FAILED (committed artifact untouched): ${err instanceof Error ? err.message : err}`,
    );
    process.exitCode = 1;
  });
}
