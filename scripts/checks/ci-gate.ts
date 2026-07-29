/** The deterministic policy behind .github/workflows/ci-gate.yml (issue #275). */
export type Outcome = "success" | "failure" | "cancelled" | "skipped" | "missing";
export type Domain = "unit" | "repo-guards" | "backend" | "integration" | "contract" | "frontend" | "e2e";

export interface GateInput {
  changed: Partial<Record<"backend" | "contract" | "frontend" | "scripts", boolean>>;
  docsOnly: boolean;
  draft: boolean;
  outcomes: Partial<Record<Domain, Outcome>>;
}

const systemDomains: Domain[] = ["backend", "integration", "contract", "frontend", "e2e"];

function neededDomains(input: GateInput): Domain[] {
  const changed = input.changed;
  if (input.docsOnly) return ["repo-guards"];
  const codeChanged = Object.values(changed).some(Boolean);
  const needed: Domain[] = ["repo-guards"];
  if (codeChanged) needed.push("unit");
  if (!input.draft) {
    if (changed.backend) needed.push("backend", "e2e");
    if (changed.scripts) needed.push("integration", "e2e");
    if (changed.contract) needed.push("contract");
    if (changed.frontend) needed.push("frontend", "e2e");
  }
  return [...new Set(needed)];
}

/** Returns explicit failures; an empty list is a passing fan-in decision. */
export function evaluateGate(input: GateInput): string[] {
  const errors: string[] = [];
  const needed = neededDomains(input);
  for (const domain of needed) {
    const outcome = input.outcomes[domain] ?? "missing";
    if (outcome !== "success") {
      errors.push(`${domain}: required assurance ended ${outcome}`);
    }
  }
  // A system job may be skipped only for a draft PR.  A ready PR that changed
  // its domain must never get a green fan-in from a skipped workflow.
  if (!input.draft) {
    for (const domain of systemDomains) {
      const relevant = domain === "backend" ? input.changed.backend
        : domain === "integration" ? input.changed.scripts
        : domain === "contract" ? input.changed.contract
        : domain === "frontend" ? input.changed.frontend
        : domain === "e2e" ? input.changed.backend || input.changed.scripts || input.changed.frontend
        : false;
      if (relevant && input.outcomes[domain] === "skipped") errors.push(`${domain}: path-skipped despite matching changed files`);
    }
  }
  const codeChanged = !input.docsOnly && Object.values(input.changed).some(Boolean);
  const testsRan = (["unit", "backend", "integration", "contract", "frontend", "e2e"] as Domain[])
    .some((domain) => input.outcomes[domain] === "success");
  if (codeChanged && !testsRan) errors.push("invariant-2: code changed but no test-executing job ran");
  return [...new Set(errors)];
}

function bool(name: string): boolean { return process.env[name] === "true"; }
function outcome(name: string): Outcome {
  const value = process.env[`RESULT_${name.toUpperCase().replaceAll("-", "_")}`] ?? "missing";
  if (["success", "failure", "cancelled", "skipped", "missing"].includes(value)) return value as Outcome;
  throw new Error(`invalid outcome for ${name}: ${value}`);
}

function outcomesFromGitHub(): Partial<Record<Domain, Outcome>> {
  const sha = process.env.GITHUB_SHA;
  if (!sha || !process.env.GITHUB_REPOSITORY) return {};
  const domains: Record<string, Domain> = {
    unit: "unit", "repo-guards": "repo-guards", backend: "backend", integration: "integration",
    contract: "contract", frontend: "frontend", e2e: "e2e",
  };
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = Bun.spawnSync(["gh", "run", "list", "--repo", process.env.GITHUB_REPOSITORY!, "--commit", sha, "--limit", "100", "--json", "name,status,conclusion"]);
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    const runs = JSON.parse(new TextDecoder().decode(result.stdout)) as { name: string; status: string; conclusion: string | null }[];
    const relevant = runs.filter((run) => run.name in domains);
    if (relevant.length > 0 && relevant.every((run) => run.status === "completed")) {
      return Object.fromEntries(relevant.map((run) => [domains[run.name]!, run.conclusion === "success" ? "success" : run.conclusion === "cancelled" ? "cancelled" : run.conclusion === "skipped" ? "skipped" : "failure"])) as Partial<Record<Domain, Outcome>>;
    }
    Bun.sleepSync(10_000);
  }
  throw new Error("timed out waiting for assurance workflow conclusions");
}

if (import.meta.main) {
  const explicit = Object.keys(process.env).some((name) => name.startsWith("RESULT_"));
  const outcomes = explicit
    ? Object.fromEntries((["unit", "repo-guards", "backend", "integration", "contract", "frontend", "e2e"] as Domain[]).map((name) => [name, outcome(name)]))
    : outcomesFromGitHub();
  const input: GateInput = {
    changed: { backend: bool("CHANGED_BACKEND"), contract: bool("CHANGED_CONTRACT"), frontend: bool("CHANGED_FRONTEND"), scripts: bool("CHANGED_SCRIPTS") },
    docsOnly: bool("CHANGED_DOCS_ONLY"),
    draft: bool("IS_DRAFT"),
    outcomes,
  };
  const errors = evaluateGate(input);
  if (errors.length) {
    console.error("ci-gate: FAILED");
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log("ci-gate: OK");
}
