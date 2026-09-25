// `bun smoke`'s view of the `RM_ENV` policy × `deployment_identity` matrix of
// smoke-production-spec.md §4.3 — a RE-EXPORT, not a copy.
//
// The matrix has exactly one implementation, backend/src/deploy-policy.ts, which
// the api image (preflight check 5), `bun run migrate` and `bun smoke --migrate`
// (checkMigrateGates) and this boot all call. It lives under backend/src/ because
// backend/Dockerfile copies nothing from scripts/; the host can import across
// that boundary, the container cannot. Three copies of the table existed before
// (#1026 W1 criterion 13), and a table held in three places is three tables.
//
// ── Naming note (read before renaming) ──────────────────────────────────────
//
// `scripts/lib/smoke-env.ts` is an unrelated live module (the demo data-path
// resolver, `resolveSmokeEnv`). This one keeps the `-policy` suffix so the two
// never merge by accident.
//
// Acceptance gates served (spec §10): W1 "Unset `RM_ENV` against a remote target
// refuses."; W2 "`RM_ENV=stage` + typed owner password against
// `deployment_identity = production` refuses; plain stage boot incl.
// `--allow-insecure` against production identity refuses."
export {
  describePolicyVerdict,
  refuseWeakeningFlagsOnProd,
  resolveDeploymentPolicy,
  resolveRmEnv,
  RM_ENV_UNSET_WARNING,
  type PolicyEnv as RmEnv,
  type PolicyInput,
  type PolicyPosture,
  type PolicyVerdict,
  type RmEnvSource,
  type TargetConnection,
} from "../../backend/src/deploy-policy.ts";
