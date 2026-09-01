import { APP_CODE, RESTORE_CODE, postflightCode, preflightCode } from "../../lib/rollout-manifest.ts";
import type { RolloutStep } from "../../lib/rollout-manifest.ts";
import { TAG_GLOB } from "./release.ts";

const DIR = "0.3.0-to-0.4.0";
export { TAG_GLOB };
export const STEPS: RolloutStep[] = [
  { id: "P2.rc-tag", phase: "P2 release identity", section: "§1", title: "an RC tag points at HEAD", hostRole: "any", actor: "operator", requires: [], dependsOn: [], derived: true, verify: "git tag --points-at HEAD -l 'v0.4.0-rc.*'" },
  { id: "P3.backup", phase: "P3 backup", section: "§3", title: "encrypted replica dump captured", hostRole: "stage", actor: "agent", requires: [], dependsOn: [], artifacts: ["rm-preupgrade-<STAMP>.dump.gpg", "rm-globals-<STAMP>.sql.gpg"], ttlHours: 48, verify: "bun run smoke:capture" },
  { id: "P3.gate-c", phase: "P3 backup", section: "§5", title: "dump restores and passes v0.4 preflight", hostRole: "stage", actor: "script", requires: ["P3.backup"], dependsOn: [...preflightCode(DIR), ...RESTORE_CODE, `backend/scripts/upgrades/${DIR}/restore-check.ts`], ttlHours: 48, verify: `bun scripts/upgrades/${DIR}/restore-check.ts $RM_BACKUP_DIR --emit-receipt` },
  { id: "P4.preflight-live", phase: "P4 preflight", section: "§3", title: "live v0.3 database is safe to migrate", hostRole: "stage", actor: "script", requires: ["P3.gate-c"], dependsOn: preflightCode(DIR), ttlHours: 2, verify: `bun scripts/upgrades/${DIR}/preflight.ts --emit-receipt` },
  { id: "P5.rehearsal", phase: "P5 rehearsal", section: "§5", title: "RC migrates and postflight passes on the smoke-twin", hostRole: "stage", actor: "script", requires: ["P3.gate-c"], dependsOn: [...APP_CODE, `backend/scripts/upgrades/${DIR}/stage-rehearsal.ts`], ttlHours: 48, verify: `bun scripts/upgrades/${DIR}/stage-rehearsal.ts $RM_BACKUP_DIR --emit-receipt` },
  { id: "P8.postflight-prod", phase: "P8 verify", section: "§7", title: "production schema and judge invariants are clean", hostRole: "cutover", actor: "script", requires: ["P4.preflight-live", "P5.rehearsal"], dependsOn: postflightCode(DIR, ["backend/src/swarm/**", "backend/src/db/append-only-guard.ts"]), ttlHours: 2, verify: `bun scripts/upgrades/${DIR}/postflight.ts --emit-receipt=P8.postflight-prod` },
];
