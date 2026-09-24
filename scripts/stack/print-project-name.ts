// Print the compose project a CI job's `bun smoke` boot will use, as a
// `name=<project>` line for `$GITHUB_OUTPUT`.
//
// WHY THIS EXISTS. The CI workflow used to CHOOSE the project, exporting
// SMOKE_PROJECT into the boot so its later steps (the billing diagnostic, the
// always() teardown) could name the same stack. Spec §1 retires SMOKE_PROJECT
// with no alias, so the boot now derives the name itself — and so must the
// workflow, through the same helper, not a second spelling of the rule. A CI
// identity is hashed from the job's own variables (naming.ts CI_IDENTITY_VARS),
// which are identical in every step of one job, so a name printed here before
// the boot is the name the boot uses, even if the boot is later killed.
//
// REFUSES OUTSIDE GitHub Actions. A local identity is random per call, so any
// name printed here would name a stack that never exists.
import { resolveStackEnvironment, stackProjectName } from "./naming.ts";

const environment = resolveStackEnvironment(process.env);
if (environment.class !== "ci") {
  console.error("print-project-name: not running under GitHub Actions; a local boot's project is random per boot.");
  process.exit(1);
}
console.log(`name=${stackProjectName("stack", environment)}`);
