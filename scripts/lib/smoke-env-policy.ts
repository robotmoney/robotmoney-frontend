// `bun smoke`'s view of the `--policy` × `deployment_identity` matrix of
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
// Acceptance gates served (spec §10): W1 "No `--policy` against a remote target
// refuses."; W2 "`--policy stage` + typed owner password against
// `deployment_identity = production` refuses; plain stage boot against
// production identity refuses."
export {
  describePolicyVerdict,
  resolveDeploymentPolicy,
  policyFlag,
  POLICY_FLAG,
  POLICY_UNSET_WARNING,
  resolvePolicy,
  type PolicyEnv,
  type PolicyInput,
  type PolicyPosture,
  type PolicySource,
  type PolicyVerdict,
  type TargetConnection,
} from "../../backend/src/deploy-policy.ts";
