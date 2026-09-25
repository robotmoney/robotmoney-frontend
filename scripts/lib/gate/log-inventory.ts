// The log inventory both gates build and grade (twin:gate, prod:gate).
//
// WHY DEFAULT-DENY. The first twin gate failed only on a fixed list of known-bad
// patterns. On 2026-09-25 production had been logging hundreds of
// "cannot execute UPDATE in a read-only transaction", "No space left on device"
// and "socket connection was closed" lines for a day, and none of them was on the
// list, so nothing would have failed until someone read the logs by hand. Here
// EVERY error-like line is grouped, and every group must match a committed
// classification (log-classifications.json) that says what it is and why it is
// acceptable. A group that matches nothing FAILS: a new failure mode cannot pass
// a gate unnoticed; it can only be added to the file with a written reason.
//
// Pure: no IO. io.ts reads the logs, the gates call these.

export type Level = "ERROR" | "WARN";

/** One raw log line; `ts` is the docker/driver timestamp when there is one. */
export interface RawLine {
  ts: string | null;
  text: string;
}

export interface InventoryGroup {
  source: string;
  level: Level;
  /** The normalised message: ids, numbers and timestamps collapsed. */
  key: string;
  count: number;
  first: string | null;
  last: string | null;
  /** One real line from the group, for a human and for rule matching. */
  sample: string;
}

/**
 * - expected: the system working as designed (a guard probe being refused, a
 *   success line that happens to contain an error word).
 * - external: a third party misbehaving, already degraded around in code.
 * - fragment: a continuation line of a multi-line error (stack frame, postgres
 *   field); the headline line is classified on its own.
 * - known-issue: a real defect, named by issue/decision. Allowed in a BASELINE
 *   (it is what the release fixes); fails after the release unless the rule
 *   says `tolerateAfterRelease` with a reason.
 */
export type RuleClass = "expected" | "external" | "fragment" | "known-issue";

export interface ClassificationRule {
  id: string;
  /** Case-insensitive regex, tried against the raw sample and the normalised key. */
  match: string;
  /** Optional regex on the source name (container or `driver:<file>`). */
  source?: string;
  class: RuleClass;
  reason: string;
  /** Issue, decision or runbook id the known issue is tracked under. */
  issue?: string;
  /** known-issue only: still acceptable after the release, and why. */
  tolerateAfterRelease?: string;
}

export interface ClassifiedGroup extends InventoryGroup {
  rule: ClassificationRule | null;
}

const ERROR_WORDS =
  /\b(error|errors|exception|fatal|panic|fail|failed|failure|fails|dead|refus(ed|ing)|denied|timeout|timed out|unhealthy|stale|cannot|could not|unable|invalid|rejected|abort(ed)?|crash(ed)?|killed|oom)\b/i;
const WARN_WORDS = /\b(warn|warning|deprecat(ed|ion)|degraded|retry|retrying|throttled|429|fallback)\b/i;

/** ERROR, WARN, or null for a line that is neither. */
export function lineLevel(text: string): Level | null {
  if (ERROR_WORDS.test(text)) return "ERROR";
  if (WARN_WORDS.test(text)) return "WARN";
  return null;
}

/** Collapse ids, numbers and timestamps so repeats of one message count as one. */
export function normalizeLogLine(line: string): string {
  return line
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/0x[0-9a-f]{6,}/gi, "<hex>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/** PURE. Group one source's error- and warning-like lines. */
export function inventory(source: string, lines: readonly RawLine[]): InventoryGroup[] {
  const groups = new Map<string, InventoryGroup>();
  for (const { ts, text } of lines) {
    const level = lineLevel(text);
    if (!level) continue;
    const key = normalizeLogLine(text);
    const id = `${level}\u0001${key}`;
    const g = groups.get(id);
    if (g) {
      g.count++;
      if (ts) g.last = ts;
    } else {
      groups.set(id, { source, level, key, count: 1, first: ts, last: ts, sample: text.trim().slice(0, 400) });
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

const CLASSES: readonly RuleClass[] = ["expected", "external", "fragment", "known-issue"];

/** Validate a parsed classification file; throws naming the first bad rule. */
export function validateRules(raw: unknown): ClassificationRule[] {
  if (!Array.isArray(raw)) throw new Error("log classifications must be a JSON array of rules");
  const seen = new Set<string>();
  return raw.map((r, i) => {
    const rule = r as ClassificationRule;
    const where = `rule #${i + 1}${rule?.id ? ` (${rule.id})` : ""}`;
    if (!rule || typeof rule.id !== "string" || !rule.id) throw new Error(`${where}: missing id`);
    if (seen.has(rule.id)) throw new Error(`${where}: duplicate id`);
    seen.add(rule.id);
    if (typeof rule.match !== "string" || !rule.match) throw new Error(`${where}: missing match`);
    new RegExp(rule.match, "i");
    if (rule.source !== undefined) new RegExp(rule.source, "i");
    if (!CLASSES.includes(rule.class)) throw new Error(`${where}: class must be one of ${CLASSES.join(", ")}`);
    if (typeof rule.reason !== "string" || rule.reason.trim().length < 10) throw new Error(`${where}: a reason of at least 10 characters is required`);
    if (rule.class === "known-issue" && !rule.issue) throw new Error(`${where}: a known-issue must name its issue`);
    return rule;
  });
}

/** PURE. Attach the first matching rule to each group (or null). */
export function classify(groups: readonly InventoryGroup[], rules: readonly ClassificationRule[]): ClassifiedGroup[] {
  const compiled = rules.map((r) => ({ r, m: new RegExp(r.match, "i"), s: r.source ? new RegExp(r.source, "i") : null }));
  return groups.map((g) => {
    const hit = compiled.find(({ m, s }) => (!s || s.test(g.source)) && (m.test(g.sample) || m.test(g.key)));
    return { ...g, rule: hit ? hit.r : null };
  });
}

export type InventoryMode = "baseline" | "post-release";

export interface InventoryVerdict {
  failures: string[];
  warnings: string[];
  unclassifiedErrors: number;
}

/**
 * PURE. Grade a classified inventory.
 *
 * - An unclassified ERROR group fails, in every mode.
 * - An unclassified WARN group is a warning: listed, never silently dropped.
 * - A known-issue group is a warning in a baseline (the release is what fixes
 *   it) and a failure after the release, unless its rule tolerates it with a
 *   written reason.
 */
export function inventoryVerdict(groups: readonly ClassifiedGroup[], mode: InventoryMode): InventoryVerdict {
  const failures: string[] = [];
  const warnings: string[] = [];
  let unclassifiedErrors = 0;
  for (const g of groups) {
    const where = `${g.source}: ×${g.count} "${g.key.slice(0, 160)}"`;
    if (!g.rule) {
      if (g.level === "ERROR") {
        unclassifiedErrors++;
        failures.push(`unclassified error — ${where}`);
      } else warnings.push(`unclassified warning — ${where}`);
      continue;
    }
    if (g.rule.class !== "known-issue") continue;
    const label = `known issue ${g.rule.id} (${g.rule.issue})`;
    if (mode === "baseline" || g.rule.tolerateAfterRelease) warnings.push(`${label} — ${where}`);
    else failures.push(`${label} still present after the release — ${where}`);
  }
  return { failures, warnings, unclassifiedErrors };
}

/** Markdown lines: the full inventory table, one row per group, every source. */
export function renderInventory(groups: readonly ClassifiedGroup[]): string[] {
  const out: string[] = [];
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/`/g, "'");
  const bySource = new Map<string, ClassifiedGroup[]>();
  for (const g of groups) bySource.set(g.source, [...(bySource.get(g.source) ?? []), g]);
  out.push(
    `${groups.length} distinct error/warning message(s) across ${bySource.size} source(s). ` +
      "Every ERROR group must match a committed classification (scripts/lib/gate/log-classifications.json) or the gate fails.",
    "",
    "| Source | Level | Count | First | Last | Classification | Message |",
    "|---|---|---|---|---|---|---|",
  );
  for (const [source, gs] of bySource) {
    for (const g of gs) {
      const cls = g.rule ? `${g.rule.class}: \`${g.rule.id}\`${g.rule.issue ? ` (${g.rule.issue})` : ""}` : "**UNCLASSIFIED**";
      out.push(`| \`${esc(source)}\` | ${g.level} | ${g.count} | ${g.first ?? "—"} | ${g.last ?? "—"} | ${cls} | \`${esc(g.key.slice(0, 180))}\` |`);
    }
  }
  return out;
}
