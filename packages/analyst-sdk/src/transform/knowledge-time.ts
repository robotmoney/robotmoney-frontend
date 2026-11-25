// Knowledge time (issue 1733, docs/technical/regime-engine.md section 8.1.2).
// Pure: no fs, env, db or network.
//
// A source row is dated by the period it describes (its period date). Many
// series are published later than that: FRED dailies the next business day,
// ICSA the Thursday after its week-ending Saturday, DTWEXBGS the Monday after
// its week, monthly and quarterly series weeks or months after the period.
// Every series therefore declares a publication rule, and a computation for
// day t reads a value only from the day it was published (its known date).
//
// A row may also carry `known`: the UTC instant (or day) that version was
// first seen, from the source ledger. A value seen during its own period day
// is provisional (finding E4): the day had not ended. A later version of the
// same period date is a revision, known from its own `known` day. A value is
// known on the later of its publication date and its `known` day.
//
// knowledgeTimeSeries turns the versions of one series into the series a
// reader sees day by day: on each known date it shows the value of the newest
// period known by then, at its newest version known by then. A revision of an
// older period never reaches back: the past keeps the value it had. So the
// series up to day t depends only on versions known by t (prefix invariance).
import type { Point } from "../types.ts";
import type { PublicationRule } from "../analyze/indicators.ts";

// PublicationRule is declared with the registry (analyze/indicators.ts), so a
// reader of the registry imports no calculation code.
export type { PublicationRule };

/** A source row, optionally with the instant (or day) this version was first known. */
export interface VersionedPoint extends Point {
  known?: string;
}

/** One day of a knowledge-time series: `date` is the known date, `period` the period date of the value shown. */
export interface KnownPoint extends Point {
  period: string;
}

// Raised when a series has no valid publication rule. Names it. publishedOn has
// no series id, so it names the rule kind there instead (issue 1751).
export class PublicationRuleError extends Error {
  constructor(readonly seriesId: string, detail: string) {
    super(`series ${seriesId}: ${detail} (declare publication as same-day, business-days, next-weekday, months-later or calendar-days)`);
    this.name = "PublicationRuleError";
  }
}

const positiveInt = (n: unknown): boolean => typeof n === "number" && Number.isInteger(n) && n > 0;

/** The series' declared publication rule. Throws PublicationRuleError when it is missing or malformed. */
export function publicationRuleOf(s: { id: string; publication?: unknown }): PublicationRule {
  const p = s.publication as { kind?: unknown; days?: unknown; weekday?: unknown; months?: unknown } | undefined;
  if (!p || typeof p !== "object") throw new PublicationRuleError(s.id, "no publication rule declared");
  if (p.kind === "same-day") return { kind: "same-day" };
  if (p.kind === "business-days" && positiveInt(p.days)) return { kind: "business-days", days: p.days as number };
  if (p.kind === "next-weekday" && typeof p.weekday === "number" && Number.isInteger(p.weekday) && p.weekday >= 0 && p.weekday <= 6) {
    return { kind: "next-weekday", weekday: p.weekday };
  }
  if (p.kind === "months-later" && positiveInt(p.months)) return { kind: "months-later", months: p.months as number };
  if (p.kind === "calendar-days" && positiveInt(p.days)) return { kind: "calendar-days", days: p.days as number };
  throw new PublicationRuleError(s.id, `malformed publication rule ${JSON.stringify(p)}`);
}

const DAY_MS = 86_400_000;
const toMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The day the value for `period` is published under `rule`. */
export function publishedOn(period: string, rule: PublicationRule): string {
  const t = toMs(period);
  if (!Number.isFinite(t)) throw new RangeError(`bad period date ${JSON.stringify(period)}`);
  switch (rule.kind) {
    case "same-day":
      return period;
    case "business-days": {
      let ms = t;
      for (let left = rule.days; left > 0; ) {
        ms += DAY_MS;
        const wd = new Date(ms).getUTCDay();
        if (wd !== 0 && wd !== 6) left--;
      }
      return toDay(ms);
    }
    case "next-weekday": {
      const wd = new Date(t).getUTCDay();
      const ahead = ((rule.weekday - wd + 7) % 7) || 7;
      return toDay(t + ahead * DAY_MS);
    }
    case "months-later": {
      const d = new Date(t);
      return toDay(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + rule.months, 1));
    }
    case "calendar-days":
      // A direct call skips publicationRuleOf, so the count is checked here too.
      if (!positiveInt(rule.days)) {
        throw new PublicationRuleError("(calendar-days rule)", `days must be a positive integer, got ${JSON.stringify(rule.days)}`);
      }
      return toDay(t + rule.days * DAY_MS);
  }
}

/**
 * The day a version is known: the later of its publication date and the UTC
 * day it was first seen. A value seen on its own period day is provisional; it
 * is still known that day, and its full-day value is a later version.
 */
export function knownOn(row: VersionedPoint, rule: PublicationRule): string {
  const pub = publishedOn(row.date, rule);
  if (row.known === undefined) return pub;
  const seen = row.known.slice(0, 10);
  return seen > pub ? seen : pub;
}

/** True when a version was seen before its period's UTC day ended (finding E4). */
export function isProvisional(row: VersionedPoint): boolean {
  return row.known !== undefined && row.known.slice(0, 10) <= row.date;
}

/**
 * The series a reader sees by knowledge time, one row per known date, cut at
 * `asof` when given (no row known after it). See the header for the rule.
 */
export function knowledgeTimeSeries(rows: readonly VersionedPoint[], rule: PublicationRule, asof?: string): KnownPoint[] {
  const events = rows
    .map((r, i) => ({ r, i, k: knownOn(r, rule) }))
    .filter((e) => asof === undefined || e.k <= asof)
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i));
  const out: KnownPoint[] = [];
  let best: VersionedPoint | null = null;
  for (let j = 0; j < events.length; j++) {
    const { r, k } = events[j]!;
    // The newest period wins; a later version of that same period replaces it.
    if (best === null || r.date >= best.date) best = r;
    if (j + 1 < events.length && events[j + 1]!.k === k) continue;
    out.push({ date: k, value: best.value, period: best.date });
  }
  return out;
}
