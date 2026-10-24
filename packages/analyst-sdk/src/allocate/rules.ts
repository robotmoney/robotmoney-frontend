// Rule file validation (issue 1401). validateRuleFile checks a parsed rule file:
// the shape, that weights sum to 100 per state, that each band contains its
// neutral weight, that every signal name parses (signals.ts), and that every
// holding is in the universe and inside its caps (universe.ts checkHoldings).
// Each error starts with the path of the field it is about.
//
// Pure: no fs, env or network (scripts/tests/unit/analyst-sdk-purity.test.ts).
// Reading a rule file happens in bin/ or the caller.
import { parseSignalName, SignalNameError } from "./signals.ts";
import { LABEL_SOURCES, RULE_STATES, RULE_STATUSES, type EngineRuleFile, type RuleFile } from "./types.ts";
import { checkHoldings, loadUniverse, type HoldingsByState, type Universe } from "./universe.ts";

/** A rule file that failed validation; `errors` holds every message. */
export class RuleFileError extends Error {
  override readonly name = "RuleFileError";
  constructor(readonly errors: string[]) {
    super(errors.join("\n"));
  }
}

export interface ValidateRuleFileOptions {
  /** The universe to check holdings against; the shipped one by default. */
  universe?: Universe;
  /** Skip the universe check, like the CLI's `--allow-outside-universe`. */
  allowOutsideUniverse?: boolean;
}

const SUM_TOLERANCE = 1e-6;
const BASE_FIELDS = ["id", "name", "author", "date", "status", "description", "drift"];
const STATES_FIELDS = [...BASE_FIELDS, "label", "states"];
const ENGINE_FIELDS = [...BASE_FIELDS, "engine"];
const SLEEVE_FIELDS = ["holding", "signal", "min", "max", "scale", "volTarget"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
  && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

function unknownFields(o: Record<string, unknown>, allowed: readonly string[], at: string, errors: string[]): void {
  for (const k of Object.keys(o)) {
    if (allowed.includes(k)) continue;
    const why = /cap/i.test(k) ? " (caps come from the universe, not the rule file)" : "";
    errors.push(`${at}${k}: unknown field${why}`);
  }
}

/** A map of holding to weight: finite, not negative, summing to 100. True when its holdings are usable. */
function checkWeights(v: unknown, at: string, errors: string[]): v is Record<string, number> {
  if (!isObj(v) || Object.keys(v).length === 0) {
    errors.push(`${at}: must be a non-empty object of holding to weight`);
    return false;
  }
  let ok = true;
  for (const [k, w] of Object.entries(v)) {
    if (!isNum(w)) { errors.push(`${at}.${k}: weight must be a number`); ok = false; }
    else if (w < 0) { errors.push(`${at}.${k}: weight ${w} is negative`); ok = false; }
  }
  if (!ok) return false;
  const sum = Object.values(v as Record<string, number>).reduce((a, b) => a + b, 0);
  // A wrong sum is reported, but the holdings still count, so it is the only error.
  if (Math.abs(sum - 100) > SUM_TOLERANCE) errors.push(`${at}: weights sum to ${sum}, not 100`);
  return true;
}

function checkDrift(v: unknown, holdings: Set<string>, errors: string[]): void {
  if (!isObj(v)) { errors.push("drift: must be an object { points, relative, byHolding? }"); return; }
  unknownFields(v, ["points", "relative", "byHolding"], "drift.", errors);
  if (!isNum(v.points) || v.points <= 0) errors.push("drift.points: must be a number above 0");
  if (!isNum(v.relative) || v.relative < 0 || v.relative > 1) errors.push("drift.relative: must be a fraction, 0 to 1");
  if (v.byHolding === undefined) return;
  if (!isObj(v.byHolding)) { errors.push("drift.byHolding: must be an object of holding to points"); return; }
  for (const [k, p] of Object.entries(v.byHolding)) {
    if (!isNum(p) || p <= 0) errors.push(`drift.byHolding.${k}: must be a number above 0`);
    if (!holdings.has(k)) errors.push(`drift.byHolding.${k}: not a holding of this rule file`);
  }
}

function checkStates(r: Record<string, unknown>, errors: string[]): Set<string> {
  const holdings = new Set<string>();
  if (!LABEL_SOURCES.includes(r.label as never)) errors.push(`label: must be one of ${LABEL_SOURCES.join(", ")}`);
  if (!isObj(r.states)) { errors.push("states: must be an object of state to weights"); return holdings; }
  const want = r.label === "fixed" ? ["neutral"] : RULE_STATES;
  for (const s of want) {
    if (!(s in r.states)) { errors.push(`states.${s}: missing`); continue; }
    if (checkWeights(r.states[s], `states.${s}`, errors)) for (const k of Object.keys(r.states[s] as object)) holdings.add(k);
  }
  for (const s of Object.keys(r.states)) {
    if (want.includes(s as never)) continue;
    errors.push(r.label === "fixed" && RULE_STATES.includes(s as never)
      ? `states.${s}: a fixed rule holds only neutral`
      : `states.${s}: unknown state (${want.join(", ")})`);
  }
  return holdings;
}

function checkEngine(v: unknown, errors: string[]): Set<string> {
  const holdings = new Set<string>();
  if (!isObj(v)) { errors.push("engine: must be an object { neutral, sleeves, buffer, dollarBook }"); return holdings; }
  unknownFields(v, ["neutral", "sleeves", "buffer", "dollarBook"], "engine.", errors);
  const neutralOk = checkWeights(v.neutral, "engine.neutral", errors);
  const neutral = (neutralOk ? v.neutral : {}) as Record<string, number>;
  for (const k of Object.keys(neutral)) holdings.add(k);
  const role = new Map<string, string>(); // holding -> the field that claims it

  const claim = (h: string, at: string) => {
    const prior = role.get(h);
    if (prior) errors.push(`${at}: ${h} is already ${prior}`);
    else role.set(h, at);
  };

  if (!Array.isArray(v.sleeves) || v.sleeves.length === 0) errors.push("engine.sleeves: must be a non-empty array");
  else v.sleeves.forEach((s: unknown, i: number) => {
    const at = `engine.sleeves[${i}]`;
    if (!isObj(s)) { errors.push(`${at}: must be an object`); return; }
    unknownFields(s, SLEEVE_FIELDS, `${at}.`, errors);
    if (!isStr(s.holding)) errors.push(`${at}.holding: missing`);
    else {
      claim(s.holding, `${at}.holding`);
      if (neutralOk && !(s.holding in neutral)) errors.push(`${at}.holding: ${s.holding} has no weight in engine.neutral`);
    }
    if (!isStr(s.signal)) errors.push(`${at}.signal: missing`);
    else {
      try { parseSignalName(s.signal); } catch (e) {
        if (!(e instanceof SignalNameError)) throw e;
        errors.push(`${at}.signal: ${e.message}`);
      }
    }
    const bandOk = isNum(s.min) && isNum(s.max) && s.min >= 0 && s.max <= 100 && s.min <= s.max;
    if (!bandOk) errors.push(`${at}: band min..max must be numbers with 0 <= min <= max <= 100`);
    else if (isStr(s.holding) && s.holding in neutral) {
      const n = neutral[s.holding]!;
      if (n < (s.min as number) || n > (s.max as number))
        errors.push(`${at}: band ${s.min}..${s.max} does not contain the neutral weight ${n} (engine.neutral.${s.holding})`);
    }
    if (!isNum(s.scale) || s.scale <= 0) errors.push(`${at}.scale: must be a number above 0`);
    if (s.volTarget !== undefined && (!isNum(s.volTarget) || s.volTarget <= 0)) errors.push(`${at}.volTarget: must be a number above 0`);
  });

  if (!isStr(v.buffer)) errors.push("engine.buffer: must name the cash holding");
  else {
    claim(v.buffer, "engine.buffer");
    if (neutralOk && !(v.buffer in neutral)) errors.push(`engine.buffer: ${v.buffer} has no weight in engine.neutral`);
  }

  const book = v.dollarBook;
  if (!isObj(book)) errors.push("engine.dollarBook: must be an object { instruments, trailingDays }");
  else {
    unknownFields(book, ["instruments", "trailingDays"], "engine.dollarBook.", errors);
    if (!Array.isArray(book.instruments) || book.instruments.length === 0) errors.push("engine.dollarBook.instruments: must be a non-empty array");
    else book.instruments.forEach((h: unknown, i: number) => {
      const at = `engine.dollarBook.instruments[${i}]`;
      if (!isStr(h)) { errors.push(`${at}: must be a holding id`); return; }
      claim(h, at);
      holdings.add(h);
    });
    if (!Number.isInteger(book.trailingDays) || (book.trailingDays as number) <= 0) errors.push("engine.dollarBook.trailingDays: must be a whole number of days above 0");
  }

  for (const k of Object.keys(neutral))
    if (!role.has(k)) errors.push(`engine.neutral.${k}: not a sleeve, the buffer or a dollar-book instrument`);
  return holdings;
}

export const isEngineRule = (r: RuleFile): r is EngineRuleFile => "engine" in r;

/**
 * The holdings a rule file can take, per state, for checkHoldings. A states rule:
 * its states. An engine rule: `neutral`, and `max` with each sleeve at its band
 * ceiling (the most the engine can place in it).
 */
export function ruleHoldings(rule: RuleFile): HoldingsByState {
  if (!isEngineRule(rule)) return rule.states as HoldingsByState;
  return {
    neutral: rule.engine.neutral,
    max: Object.fromEntries(rule.engine.sleeves.map((s) => [s.holding, s.max])),
  };
}

/** Every holding of a valid rule file that is not in the universe or is over a cap, as path-first messages. */
export function ruleUniverseErrors(rule: RuleFile, universe: Universe): string[] {
  const engine = isEngineRule(rule);
  const sleeveIndex = engine ? new Map(rule.engine.sleeves.map((s, i) => [s.holding, i])) : new Map<string, number>();
  const out = checkHoldings(ruleHoldings(rule), universe).map((f) => {
    const field = !engine ? `states.${f.state}` : f.state === "max" ? "engine.sleeves" : "engine.neutral";
    let at: string;
    if (f.kind === "group_cap") at = engine && f.state === "max" ? "engine.sleeves (band ceilings)" : field;
    else if (engine && f.state === "max") at = `engine.sleeves[${sleeveIndex.get(f.holding)}].max`;
    else at = `${field}.${f.holding}`;
    return `${at}: ${f.message}`;
  });
  if (engine) {
    const ids = new Set(universe.assets.map((a) => a.id));
    rule.engine.dollarBook.instruments.forEach((h, i) => {
      if (!ids.has(h)) out.push(`engine.dollarBook.instruments[${i}]: ${h} is not in the universe`);
    });
  }
  return out;
}

/**
 * Every problem with a parsed rule file, each message starting with the field
 * path. An empty array means the file is valid. The universe check runs only on
 * a file whose shape is valid.
 */
export function validateRuleFile(data: unknown, opts: ValidateRuleFileOptions = {}): string[] {
  const errors: string[] = [];
  if (!isObj(data)) return ["(root): a rule file must be a JSON object"];
  for (const k of ["id", "name", "author"] as const) if (!isStr(data[k])) errors.push(`${k}: missing`);
  if (!isDate(data.date)) errors.push("date: must be a YYYY-MM-DD date");
  if (!RULE_STATUSES.includes(data.status as never)) errors.push(`status: must be one of ${RULE_STATUSES.join(", ")}`);
  if (data.description !== undefined && typeof data.description !== "string") errors.push("description: must be a string");

  const hasStates = "states" in data;
  const hasEngine = "engine" in data;
  let holdings = new Set<string>();
  if (hasStates === hasEngine) {
    errors.push(hasStates ? "states/engine: a rule file has states or engine, not both" : "states/engine: a rule file needs states or engine");
    unknownFields(data, [...new Set([...STATES_FIELDS, ...ENGINE_FIELDS])], "", errors);
  } else if (hasStates) {
    unknownFields(data, STATES_FIELDS, "", errors);
    holdings = checkStates(data, errors);
  } else {
    unknownFields(data, ENGINE_FIELDS, "", errors);
    holdings = checkEngine(data.engine, errors);
  }
  checkDrift(data.drift, holdings, errors);

  if (errors.length || opts.allowOutsideUniverse) return errors;
  return ruleUniverseErrors(data as unknown as RuleFile, opts.universe ?? loadUniverse());
}

/** The rule file, typed, or a RuleFileError holding every problem. */
export function parseRuleFile(data: unknown, opts: ValidateRuleFileOptions = {}): RuleFile {
  const errors = validateRuleFile(data, opts);
  if (errors.length) throw new RuleFileError(errors);
  return data as RuleFile;
}
