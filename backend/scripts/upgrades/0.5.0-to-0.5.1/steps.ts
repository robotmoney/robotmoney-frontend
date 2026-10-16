import { APP_CODE, RESTORE_CODE, postflightCode, preflightCode } from "../../lib/rollout-manifest.ts";
import type { RolloutStep } from "../../lib/rollout-manifest.ts";
import { TAG_GLOB } from "./release.ts";

const DIR = "0.5.0-to-0.5.1";
export { TAG_GLOB };

// Same shape as 0.4.0-to-0.5.0's manifest, and deliberately so: v0.5.1 changes
// what the gates ASSERT, not which gates exist or what order they run in. The
// RC tag still files AFTER P4/P5 (release-runbooks.md §3, revised 2026-09-11),
// so a rejected stage pass consumes no rc number.
//
// The one substantive difference is P5.rehearsal's `requires`. For a release
// that carries migrations, a rehearsal is meaningful the moment Gate C proves
// the dump restores — the boot is what applies them. v0.5.1 applies none, so
// the question its rehearsal answers ("does this code serve production-shaped
// rows?") is only worth asking once the LIVE target has been confirmed to be
// at the v0.5.0 baseline this release patches. P5 therefore requires
// P4.preflight-live as well, which P3.gate-c alone does not imply.
export const STEPS: RolloutStep[] = [
  {
    id: "P3.backup", phase: "P3 backup", section: "§4.2", title: "encrypted replica dump captured",
    hostRole: "stage", actor: "agent", requires: [], dependsOn: [],
    artifacts: ["rm-preupgrade-<STAMP>.dump.gpg", "rm-globals-<STAMP>.sql.gpg"], ttlHours: 48,
    verify: "bun run smoke:capture",
  },
  {
    id: "P3.gate-c", phase: "P3 backup", section: "§4.2", title: "dump restores and already carries the v0.5.0 schema",
    hostRole: "stage", actor: "script", requires: ["P3.backup"],
    dependsOn: [...preflightCode(DIR), ...RESTORE_CODE, `backend/scripts/upgrades/${DIR}/restore-check.ts`], ttlHours: 48,
    verify: `bun backend/scripts/upgrades/${DIR}/restore-check.ts $RM_BACKUP_DIR --emit-receipt`,
  },
  {
    id: "P4.preflight-live", phase: "P4 preflight", section: "§4.4", title: "live target is at v0.5.0 with nothing pending",
    hostRole: "stage", actor: "script", requires: ["P3.gate-c"], dependsOn: preflightCode(DIR), ttlHours: 2,
    verify: `bun backend/scripts/upgrades/${DIR}/preflight.ts --emit-receipt`,
  },
  {
    id: "P5.rehearsal", phase: "P5 rehearsal", section: "§5", title: "the RC boots and postflight passes on the smoke-twin",
    hostRole: "stage", actor: "script", requires: ["P3.gate-c", "P4.preflight-live"],
    dependsOn: [...APP_CODE, `backend/scripts/upgrades/${DIR}/stage-rehearsal.ts`], ttlHours: 48,
    verify: `bun backend/scripts/upgrades/${DIR}/stage-rehearsal.ts $RM_BACKUP_DIR --emit-receipt`,
  },
  {
    id: "P6.rc-tag", phase: "P6 release identity", section: "§5.1",
    title: "an RC tag points at HEAD, cut only after stage preflight+rehearsal pass",
    hostRole: "any", actor: "operator", requires: ["P4.preflight-live", "P5.rehearsal"], dependsOn: [], derived: true,
    verify: "git tag --points-at HEAD -l 'v0.5.1-rc.*'",
  },
  {
    id: "P8.postflight-prod", phase: "P8 verify", section: "§7", title: "production schema is unchanged and boot invariants are clean",
    hostRole: "cutover", actor: "script", requires: ["P4.preflight-live", "P5.rehearsal", "P6.rc-tag"],
    dependsOn: postflightCode(DIR, ["backend/src/swarm/domain.ts", "scripts/lib/contract-freshness.ts", "scripts/prerender.ts", "package.json"]), ttlHours: 2,
    verify: `bun backend/scripts/upgrades/${DIR}/postflight.ts --emit-receipt=P8.postflight-prod`,
  },
  {
    id: "P8.verify-prod", phase: "P8 verify", section: "§7",
    title: "the live product satisfies its invariants",
    hostRole: "cutover", actor: "script", requires: ["P8.postflight-prod"],
    dependsOn: [
      "scripts/verify-live.ts",
      "scripts/lib/verify/**",
      "backend/scripts/lib/checks.ts",
      "backend/scripts/lib/rollout-receipt.ts",
    ],
    ttlHours: 2,
    verify: "bun run verify:live --tier readonly --emit-receipt=P8.verify-prod",
  },
];
