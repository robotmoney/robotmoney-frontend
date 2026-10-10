// scripts/release/triage.ts — the owner's recorded triage of a baseline gate's
// failures (runbook R2.5, standing check SP.5).
//
// A baseline gate grades production BEFORE anything changes. A failure there is
// what is already broken, and the runbook's rule is that every one is a decision
// before the cutover: classify it, or file the defect. The decision is a small
// text file the runner reads with `--triage <file>`, one line per accepted
// finding:
//
//   <check id> | <fragment of the gate's detail line> | <reason, issue or decision>
//
//   jobs | model_unavailable:judge model responded 402 | Zen balance empty until the 2026-10-08 top-up; issue 1225
//
// A step marked `triage` (R2.5) whose gate exits non-zero passes only when its
// JSON report names no failed check outside the file: every detail line of
// every FAIL check contains the fragment of an entry for that check. The runner
// journals the file's sha256 and the entries it used. A finding the file does
// not name still stops the run. A triage file never turns a post-release gate
// green: only steps marked `triage` read it.
//
// Pure: no file read, no environment read.

export interface TriageEntry {
  readonly check: string;
  readonly fragment: string;
  readonly reason: string;
}

/** Parse a triage file. Blank lines and `#` lines are ignored; every entry needs all three fields. */
export function parseTriage(text: string): { entries: TriageEntry[] } | { errors: string[] } {
  const entries: TriageEntry[] = [];
  const errors: string[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length !== 3 || parts.some((p) => p === "")) {
      errors.push(`line ${i + 1}: expected "<check> | <fragment> | <reason>"`);
      return;
    }
    entries.push({ check: parts[0]!, fragment: parts[1]!, reason: parts[2]! });
  });
  if (errors.length > 0) return { errors };
  if (entries.length === 0) return { errors: ["the triage file names no finding"] };
  return { entries };
}

interface GateCheck {
  readonly id?: string;
  readonly name?: string;
  readonly status?: string;
  readonly detail?: unknown;
}

/** One failed finding: a FAIL check and one of its detail lines. */
export interface GateFinding {
  readonly check: string;
  readonly detail: string;
}

/** Every finding line of every FAIL check in a gate's JSON report. */
export function failedFindings(report: unknown): GateFinding[] | undefined {
  const checks = (report as { checks?: unknown })?.checks;
  if (!Array.isArray(checks)) return undefined;
  const out: GateFinding[] = [];
  for (const c of checks as GateCheck[]) {
    if (c.status !== "FAIL") continue;
    const check = c.id ?? c.name ?? "?";
    const details = Array.isArray(c.detail) ? c.detail.map(String) : [String(c.detail ?? "")];
    // The gate's warnings and its summary line ride along a FAIL check; they are not findings.
    for (const detail of details) if (!/^warn: |^\d+ distinct message\(s\)/.test(detail)) out.push({ check, detail });
  }
  return out;
}

export interface TriageResult {
  readonly accepted: boolean;
  /** Findings no entry covers. */
  readonly unmatched: readonly GateFinding[];
  /** The entries that covered at least one finding. */
  readonly used: readonly TriageEntry[];
}

/** Does the triage cover every failed finding of the report? A report with no readable checks is never accepted. */
export function applyTriage(report: unknown, entries: readonly TriageEntry[]): TriageResult {
  const findings = failedFindings(report);
  if (findings === undefined || findings.length === 0) return { accepted: false, unmatched: [], used: [] };
  const used = new Set<TriageEntry>();
  const unmatched: GateFinding[] = [];
  for (const f of findings) {
    const entry = entries.find((e) => e.check === f.check && f.detail.includes(e.fragment));
    if (entry) used.add(entry);
    else unmatched.push(f);
  }
  return { accepted: unmatched.length === 0, unmatched, used: [...used] };
}
