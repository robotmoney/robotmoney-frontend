// The one comparison of a replayed regime row with a published one (issue
// 1765, phase 1). Pure. Every replay tool compares through compareRows: the
// release check, the backend's published-run replay, the csvb audit and `bun
// run replay`. No tolerance: each compared field is compared exactly as
// canonical JSON, in a fixed order, and the first field that differs is the
// run's result. Decision D78 (compensated arithmetic) moves numbers in their
// last bits, so a run published before it differs from its replay in those
// bits; `beyondRounding` names the fields that differ by more than that.
import { createHash } from "node:crypto";
import { canonicalStringify } from "../report/canonical.ts";
import { numericDiff } from "./numeric-diff.ts";

/** The fields a replay recomputes, in the order they are compared: the label first (issue 1431). */
export const COMPARED_FIELDS = [
  "regime",
  "composite",
  "compositePercentile",
  "macroRegime",
  "onchainRegime",
  "factorRegime",
  "macroIndex",
  "onchainIndex",
  "factorIndex",
  "macroPercentile",
  "onchainPercentile",
  "factorPercentile",
  "percentiles",
  "correlations",
  "backtest",
] as const;
export type ComparedField = (typeof COMPARED_FIELDS)[number];

/** The as-of labels: a replay must reproduce them exactly for any archived run (issue 1431). */
export const LABEL_FIELDS = ["regime", "macroRegime", "onchainRegime", "factorRegime"] as const satisfies readonly ComparedField[];

/** A regime row as far as a comparison reads it: any compared field may be absent. */
export type ComparedRow = Partial<Record<ComparedField, unknown>> & { date?: string };

/** The name a missing row is reported under. */
export const MISSING_ROW = "as-of row";

/** The compared fields of a row, in order, an absent one as null. */
export function projectRow(row: ComparedRow, fields: readonly string[] = COMPARED_FIELDS): Record<string, unknown> {
  return Object.fromEntries(fields.map((f) => [f, (row as Record<string, unknown>)[f] ?? null]));
}

export interface RowComparison {
  /** Every compared field is equal and both rows exist. */
  readonly match: boolean;
  /** Every differing field, in compared order; [MISSING_ROW] when a side has no row. */
  readonly differing: string[];
  /** The first differing field, with both sides as canonical JSON ("absent" for a missing row). */
  readonly firstDiff: { field: string; published: string; replay: string } | null;
  /** Each differing field, by sub-key where both sides are objects: "percentiles.<ID>", "backtest.<asset>". */
  readonly details: string[];
  /** sha256 of the canonical JSON of each side's compared fields; null for a missing row. */
  readonly publishedSha256: string | null;
  readonly replaySha256: string | null;
  /** Each compared field of the replayed row, as canonical JSON. */
  readonly fields: Record<string, string>;
  /** The differing fields whose difference is more than rounding (D78): a label, null, key or integer, or a number moved by more than 1e-9 of its size. */
  readonly beyondRounding: string[];
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

// The sub-keys of a differing field: each top-level key whose value differs or
// is on one side only, when both sides are objects; else the field itself.
function detailsOf(field: string, a: unknown, b: unknown): string[] {
  if (!isPlainObject(a) || !isPlainObject(b)) return [field];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const out = keys.filter((k) => !(Object.hasOwn(a, k) && Object.hasOwn(b, k) && canonicalStringify(a[k]) === canonicalStringify(b[k]))).map((k) => `${field}.${k}`);
  return out.length > 0 ? out : [field];
}

/**
 * The replayed row against the published one, field by field in `fields`
 * order. A missing row on either side is a mismatch, never a pass.
 */
export function compareRows(published: ComparedRow | null, computed: ComparedRow | null, fields: readonly string[] = COMPARED_FIELDS): RowComparison {
  const r = computed === null ? null : projectRow(computed, fields);
  const p = published === null ? null : projectRow(published, fields);
  const replaySha256 = r === null ? null : sha256(canonicalStringify(r));
  const publishedSha256 = p === null ? null : sha256(canonicalStringify(p));
  const fieldText = r === null ? {} : Object.fromEntries(fields.map((f) => [f, canonicalStringify(r[f])]));
  if (p === null || r === null) {
    const label = (row: Record<string, unknown> | null) => (row === null ? "absent" : canonicalStringify(row.regime ?? null));
    return {
      match: false,
      differing: [MISSING_ROW],
      firstDiff: { field: MISSING_ROW, published: label(p), replay: label(r) },
      details: [MISSING_ROW],
      publishedSha256,
      replaySha256,
      fields: fieldText,
      beyondRounding: [MISSING_ROW],
    };
  }
  const differing: string[] = [];
  const details: string[] = [];
  const beyondRounding: string[] = [];
  let firstDiff: RowComparison["firstDiff"] = null;
  for (const f of fields) {
    const a = canonicalStringify(p[f]);
    const b = canonicalStringify(r[f]);
    if (a === b) continue;
    differing.push(f);
    details.push(...detailsOf(f, p[f], r[f]));
    if (numericDiff(a, b).differences.length > 0) beyondRounding.push(f);
    firstDiff ??= { field: f, published: a, replay: b };
  }
  return { match: differing.length === 0 && publishedSha256 === replaySha256, differing, firstDiff, details, publishedSha256, replaySha256, fields: fieldText, beyondRounding };
}

/**
 * The label tier: only the as-of labels must be equal. A run made before issue
 * 1421's fix computed from values stored to a relative tolerance (D56), so its
 * numbers differ by about 1e-6 while its labels must not. Returns the differing
 * label fields, or [MISSING_ROW] when a side has no row; empty when the labels match.
 */
export function labelMismatches(c: RowComparison): string[] {
  if (c.publishedSha256 === null || c.replaySha256 === null) return [MISSING_ROW];
  return c.differing.filter((f) => (LABEL_FIELDS as readonly string[]).includes(f));
}
