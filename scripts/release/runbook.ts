// scripts/release/runbook.ts — the release runbooks as YAML (D61, D70).
//
// A template (runbooks/templates/<name>.yaml) is the general runbook: every
// step a kind of release runs, in order. `kitchen-sink`, the full-stack
// release, is the default. A release's own runbook
// (runbooks/releases/vA.B.C.yaml) names one template and holds a full copy of
// its steps, plus the steps and checks only that release needs. It only adds:
// every template step stays, unchanged and in the template's order. An added
// step may sit anywhere, and carries `added: <its release>`.
//
// The runner runs the release's runbook (./run.ts). It refuses one that drops,
// edits or reorders a template step, so a release can never silently skip a
// standing check. The step-list hash (./steps.ts stepListHash) is taken over
// the release runbook's steps, so a copy with no additions has the template's
// hash.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NotBeforeTemplate, ReceiptSpec, StepHost, StepPhase, StepTemplate } from "./steps.ts";

/** Where the templates and the release runbooks live. */
export const RUNBOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "runbooks");

/**
 * The templates a release may name. `website-only` joins with its template
 * file and the runner mode that runs it (issue 1305, gap Z4).
 */
export const TEMPLATE_NAMES = ["kitchen-sink"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

/** The template a release runbook uses when it names none. */
export const DEFAULT_TEMPLATE: TemplateName = "kitchen-sink";

/** A step of a release runbook: a template step, or one the release added. */
export interface RunbookStep extends StepTemplate {
  /** The release that added this step; absent on a template step. */
  readonly added?: string;
}

export interface Template {
  readonly name: TemplateName;
  readonly steps: readonly StepTemplate[];
}

export interface ReleaseRunbook {
  readonly release: string;
  readonly template: TemplateName;
  /** The release's prose: identity, migrations, exceptions and owner decisions. The runner reads none of it. */
  readonly notes?: string;
  /** The recovery decision (SC.1): what to do before, at and after the first irreversible step. Required; the runner journals its sha256. */
  readonly recovery: string;
  /** Every PR the release ships, each with the step that checks it or why none does (Q05-scope proves the list complete). */
  readonly scope: readonly ScopeEntry[];
  readonly steps: readonly RunbookStep[];
}

/**
 * One change a release ships: its PR, in a few words, and either the step that
 * checks it landed (`check`, a step id of this runbook) or the reason no step
 * does (`none`: docs only, CI only, release tooling the run itself exercises).
 */
export interface ScopeEntry {
  readonly pr: number;
  readonly what: string;
  readonly check?: string;
  readonly none?: string;
}

/** PURE. Why a release's scope list is not one: every entry a PR with a check step of this runbook or a reason. */
export function scopeProblems(scope: unknown, steps: readonly Pick<RunbookStep, "id">[], where: string): string[] {
  if (!Array.isArray(scope) || scope.length === 0) return [`${where}: scope lists every PR the release ships, each with check: <step> or none: <reason>`];
  const out: string[] = [];
  const ids = new Set(steps.map((s) => s.id));
  const seen = new Set<number>();
  for (const e of scope) {
    if (!isObject(e) || !Number.isInteger(e.pr) || (e.pr as number) <= 0 || typeof e.what !== "string" || e.what.trim() === "") {
      out.push(`${where}: a scope entry is {pr, what, check | none}; got ${JSON.stringify(e)}`);
      continue;
    }
    const at = `${where}: scope PR ${e.pr as number}`;
    for (const k of Object.keys(e)) if (!["pr", "what", "check", "none"].includes(k)) out.push(`${at}: unknown key ${k}`);
    if (seen.has(e.pr as number)) out.push(`${at} appears twice`);
    seen.add(e.pr as number);
    const hasCheck = typeof e.check === "string" && e.check !== "";
    const hasNone = typeof e.none === "string" && e.none.trim() !== "";
    if (hasCheck === hasNone) out.push(`${at}: names exactly one of check: <step> or none: <reason>`);
    if (hasCheck && !ids.has(e.check as string)) out.push(`${at}: check ${e.check as string} is no step of this runbook`);
  }
  return out;
}

const STEP_KEYS = new Set([
  "id", "standing", "description", "host", "phase", "cmds", "env", "bootEnv", "expectExit", "receipts", "irreversible",
  "onlyFor", "notBefore", "triage", "maxMinutes", "cloneFrom", "gateAbsent", "added",
]);
const HOSTS: readonly StepHost[] = ["target", "capture", "control"];
/** The three phases, in the order they run (D70 as amended 2026-10-15). */
export const PHASES: readonly StepPhase[] = ["qa", "preflight", "cutover", "soak", "version"];
/** A step's id names its phase: Q02-dump, P02-identity, C10-rolling-boot, S07-soak-gate, V01-subject-spacing. */
export const PHASE_PREFIX: Readonly<Record<StepPhase, string>> = Object.freeze({ qa: "Q", preflight: "P", cutover: "C", soak: "S", version: "V" });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** PURE. One step from its parsed YAML, or the reasons it is not one. */
export function parseStep(raw: unknown, where: string): { step: RunbookStep } | { errors: string[] } {
  if (!isObject(raw)) return { errors: [`${where}: a step is a mapping`] };
  const errors: string[] = [];
  const at = `${where} ${typeof raw.id === "string" ? raw.id : "(no id)"}`;
  for (const k of Object.keys(raw)) if (!STEP_KEYS.has(k)) errors.push(`${at}: unknown key ${k}`);
  if (typeof raw.id !== "string" || raw.id === "") errors.push(`${at}: id is a non-empty string`);
  if (!isStringArray(raw.standing)) errors.push(`${at}: standing is a list of standing check ids`);
  if (typeof raw.description !== "string" || raw.description === "") errors.push(`${at}: description is a non-empty string`);
  if (!HOSTS.includes(raw.host as StepHost)) errors.push(`${at}: host is one of ${HOSTS.join(", ")}`);
  if (!PHASES.includes(raw.phase as StepPhase)) errors.push(`${at}: phase is one of ${PHASES.join(", ")}`);
  else if (typeof raw.id === "string" && !raw.id.startsWith(PHASE_PREFIX[raw.phase as StepPhase])) errors.push(`${at}: a ${raw.phase as string} step's id starts with ${PHASE_PREFIX[raw.phase as StepPhase]}`);
  if (!Array.isArray(raw.cmds) || raw.cmds.length === 0 || !raw.cmds.every((c) => isStringArray(c) && c.length > 0)) {
    errors.push(`${at}: cmds is a non-empty list of argv lists`);
  }
  if (raw.env !== undefined && !(isObject(raw.env) && Object.values(raw.env).every((v) => typeof v === "string"))) errors.push(`${at}: env maps names to strings`);
  if (raw.bootEnv !== undefined && typeof raw.bootEnv !== "boolean") errors.push(`${at}: bootEnv is a boolean`);
  if (!Number.isInteger(raw.expectExit)) errors.push(`${at}: expectExit is an integer`);
  if (!Array.isArray(raw.receipts) || !raw.receipts.every((r) => isObject(r) && typeof r.dir === "string" && typeof r.pattern === "string" && typeof r.required === "boolean" && Object.keys(r).length === 3)) {
    errors.push(`${at}: receipts is a list of {dir, pattern, required}`);
  }
  if (typeof raw.irreversible !== "boolean") errors.push(`${at}: irreversible is a boolean`);
  if (raw.onlyFor !== undefined && raw.onlyFor !== "prod" && raw.onlyFor !== "stage") errors.push(`${at}: onlyFor is prod or stage`);
  const nb = raw.notBefore;
  if (nb !== undefined && !(isObject(nb) && typeof nb.afterStep === "string" && (nb.hours === "watchHours" || (typeof nb.hours === "number" && nb.hours > 0)) && Object.keys(nb).length === 2)) {
    errors.push(`${at}: notBefore is {afterStep, hours} with hours a positive number or watchHours`);
  }
  if (raw.triage !== undefined && typeof raw.triage !== "boolean") errors.push(`${at}: triage is a boolean`);
  if (raw.maxMinutes !== undefined && !(Number.isInteger(raw.maxMinutes) && (raw.maxMinutes as number) > 0)) errors.push(`${at}: maxMinutes is a positive integer`);
  for (const k of ["cloneFrom", "gateAbsent", "added"] as const) {
    if (raw[k] !== undefined && (typeof raw[k] !== "string" || raw[k] === "")) errors.push(`${at}: ${k} is a non-empty string`);
  }
  if (errors.length > 0) return { errors };

  // Fixed key order inside receipts and notBefore: the hash sees them as the code wrote them before the YAML did.
  const step: Record<string, unknown> = {
    id: raw.id, standing: raw.standing, description: raw.description, host: raw.host, phase: raw.phase, cmds: raw.cmds,
    expectExit: raw.expectExit,
    receipts: (raw.receipts as ReceiptSpec[]).map((r) => ({ dir: r.dir, pattern: r.pattern, required: r.required })),
    irreversible: raw.irreversible,
  };
  for (const k of ["env", "bootEnv", "onlyFor", "triage", "maxMinutes", "cloneFrom", "gateAbsent", "added"] as const) {
    if (raw[k] !== undefined) step[k] = raw[k];
  }
  if (nb !== undefined) step.notBefore = { afterStep: (nb as NotBeforeTemplate).afterStep, hours: (nb as NotBeforeTemplate).hours };
  return { step: step as unknown as RunbookStep };
}

function parseSteps(raw: unknown, where: string, errors: string[]): RunbookStep[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push(`${where}: steps is a non-empty list`);
    return [];
  }
  const steps: RunbookStep[] = [];
  for (const r of raw) {
    const p = parseStep(r, where);
    if ("errors" in p) errors.push(...p.errors);
    else steps.push(p.step);
  }
  const ids = steps.map((s) => s.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup !== undefined) errors.push(`${where}: step id ${dup} appears twice`);
  // The phases run in order: QA (stage), then preflight, then cutover. A step out of its phase's place refuses.
  for (let i = 1; i < steps.length; i++) {
    if (PHASES.indexOf(steps[i]!.phase) < PHASES.indexOf(steps[i - 1]!.phase)) errors.push(`${where}: ${steps[i]!.id} (${steps[i]!.phase}) comes after ${steps[i - 1]!.id} (${steps[i - 1]!.phase}); the phases run ${PHASES.join(", ")}`);
  }
  return steps;
}

const isTemplateName = (v: unknown): v is TemplateName => TEMPLATE_NAMES.includes(v as TemplateName);

/** PURE. A template from its YAML text. Throws with every reason it is not one. */
export function parseTemplate(text: string, name: TemplateName): Template {
  const doc = Bun.YAML.parse(text) as unknown;
  const where = `template ${name}`;
  const errors: string[] = [];
  if (!isObject(doc)) throw new Error(`${where}: not a mapping`);
  for (const k of Object.keys(doc)) if (k !== "template" && k !== "steps") errors.push(`${where}: unknown key ${k}`);
  if (doc.template !== name) errors.push(`${where}: names itself ${String(doc.template)}`);
  const steps = parseSteps(doc.steps, where, errors);
  for (const s of steps) if (s.added !== undefined) errors.push(`${where} ${s.id}: a template step carries no added`);
  for (const s of steps) if (s.phase === "version") errors.push(`${where} ${s.id}: a template has no version checks; a release runbook adds its own`);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return { name, steps: deepFreeze(steps) };
}

/** PURE. A release runbook from its YAML text, before the add-only check. Throws with every reason it is not one. */
export function parseReleaseRunbook(text: string, release: string): ReleaseRunbook {
  const doc = Bun.YAML.parse(text) as unknown;
  const where = `runbook ${release}`;
  const errors: string[] = [];
  if (!isObject(doc)) throw new Error(`${where}: not a mapping`);
  for (const k of Object.keys(doc)) if (!["release", "template", "notes", "recovery", "scope", "steps"].includes(k)) errors.push(`${where}: unknown key ${k}`);
  if (typeof doc.recovery !== "string" || doc.recovery.trim() === "") errors.push(`${where}: recovery is the release's recovery decision, as text (SC.1)`);
  if (doc.notes !== undefined && typeof doc.notes !== "string") errors.push(`${where}: notes is text`);
  if (doc.release !== release) errors.push(`${where}: names release ${String(doc.release)}`);
  const template = doc.template ?? DEFAULT_TEMPLATE;
  if (!isTemplateName(template)) errors.push(`${where}: template ${String(template)} is not one of ${TEMPLATE_NAMES.join(", ")}`);
  const steps = parseSteps(doc.steps, where, errors);
  errors.push(...scopeProblems(doc.scope, steps, where));
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const scope = (doc.scope as Record<string, unknown>[]).map((e) => ({ pr: e.pr as number, what: e.what as string, ...(typeof e.check === "string" ? { check: e.check } : {}), ...(typeof e.none === "string" ? { none: e.none } : {}) }));
  return { release, template: template as TemplateName, ...(typeof doc.notes === "string" ? { notes: doc.notes } : {}), recovery: doc.recovery as string, scope: deepFreeze(scope), steps: deepFreeze(steps) };
}

/** PURE. The recovery decision a release runbook's YAML text holds, or undefined. Reads that one key only. */
export function recoveryOf(text: string): string | undefined {
  try {
    const doc = Bun.YAML.parse(text) as unknown;
    const r = isObject(doc) ? doc.recovery : undefined;
    return typeof r === "string" && r.trim() !== "" ? r : undefined;
  } catch {
    return undefined;
  }
}

/** Stable JSON: object keys sorted, so equality never depends on the order a file wrote them. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/**
 * PURE. Why a release runbook is not its template plus additions; empty when it
 * is. Every template step must appear, unchanged, in the template's order. Every
 * other step must carry `added: <the release>` and an id the template lacks.
 */
export function checkAddOnly(template: Template, runbook: ReleaseRunbook): string[] {
  const out: string[] = [];
  const where = `runbook ${runbook.release}`;
  if (runbook.template !== template.name) out.push(`${where}: uses template ${runbook.template}, checked against ${template.name}`);
  const templateIds = new Set(template.steps.map((s) => s.id));
  let next = 0;
  for (const step of runbook.steps) {
    if (templateIds.has(step.id)) {
      const t = template.steps.findIndex((s) => s.id === step.id);
      if (t < next) out.push(`${where}: ${step.id} is out of the template's order`);
      else if (t > next) for (const missed of template.steps.slice(next, t)) out.push(`${where}: template step ${missed.id} is missing (a release never deletes a step)`);
      if (t >= next) next = t + 1;
      if (step.added !== undefined) out.push(`${where}: ${step.id} is a template step, so it carries no added`);
      const { added: _added, ...body } = step;
      if (stable(body) !== stable(template.steps[t])) out.push(`${where}: ${step.id} differs from the template's step (a release never edits a template step; add a step instead)`);
    } else if (step.added !== runbook.release) {
      out.push(`${where}: ${step.id} is not a template step, so it carries added: ${runbook.release}`);
    }
  }
  for (const missed of template.steps.slice(next)) out.push(`${where}: template step ${missed.id} is missing (a release never deletes a step)`);
  return out;
}

/** The path of a template. */
export function templatePath(name: TemplateName, dir: string = RUNBOOKS_DIR): string {
  return join(dir, "templates", `${name}.yaml`);
}

/** The path of a release's runbook. */
export function releaseRunbookPath(release: string, dir: string = RUNBOOKS_DIR): string {
  return join(dir, "releases", `${release}.yaml`);
}

/** Read and parse a template. */
export function loadTemplate(name: TemplateName = DEFAULT_TEMPLATE, dir: string = RUNBOOKS_DIR): Template {
  return parseTemplate(readFileSync(templatePath(name, dir), "utf8"), name);
}

/**
 * Read a release's runbook and prove it only adds to its template. Throws when
 * the file is missing or the check fails: the runner never runs a release
 * without its own runbook, and never runs one that drops a template step.
 */
export function loadReleaseRunbook(release: string, dir: string = RUNBOOKS_DIR): ReleaseRunbook {
  const path = releaseRunbookPath(release, dir);
  if (!existsSync(path)) throw new Error(`release ${release} has no runbook at ${path}; copy a template there (${TEMPLATE_NAMES.join(", ")}) and add only its own steps`);
  const runbook = parseReleaseRunbook(readFileSync(path, "utf8"), release);
  const errors = checkAddOnly(loadTemplate(runbook.template, dir), runbook);
  if (errors.length > 0) throw new Error(`release ${release}'s runbook does not only add to template ${runbook.template}:\n  - ${errors.join("\n  - ")}`);
  return runbook;
}

/** The releases that have a runbook file, by name. */
export function releaseRunbookNames(dir: string = RUNBOOKS_DIR): string[] {
  const d = join(dir, "releases");
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".yaml")).map((f) => f.slice(0, -".yaml".length)).sort();
}

function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null) {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}
