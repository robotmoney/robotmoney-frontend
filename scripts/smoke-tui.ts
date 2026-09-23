#!/usr/bin/env bun
// `bun smoke:tui` — the standalone TUI observer.
//
// STUB (issue #1026, W1 step 1). Signatures and types are real; every body
// throws, and this file is not yet wired into `package.json`, so running it
// does nothing today. It is additive and behaviour-neutral by construction.
//
// ── Why the TUI had to be split out ─────────────────────────────────────────
//
// Spec §1, first paragraph: "`bun smoke --static-port` brings up the production
// cluster and **exits**. Containers stay up under Docker (`restart:
// unless-stopped`). `bun smoke:down` is the only way to stop them.
// `bun smoke:status` and `bun smoke:tui` observe a running stack from another
// terminal; **`bun smoke` never draws a TUI**."
//
// Today it is the other way round: `scripts/lib/smoke-main.ts` draws the TUI
// itself and stays in the foreground, so the invoking terminal is the thing
// holding the deployment up. That couples two entirely unrelated lifetimes —
// the operator's SSH session and the production cluster's — and the coupling
// fails in both directions:
//
//  - The session ends (a laptop sleeps, a VPN drops, a `tmux` is killed) and
//    the deployment goes with it, or is left in whatever half-replaced state
//    the signal found. §1.4's interruption semantics exist precisely because
//    this state is reachable; §1's exit-at-readiness rule exists so it is
//    reachable far less often.
//  - Watching requires OWNING. Two people cannot look at the same deployment,
//    and looking at one from a second terminal means starting a second run —
//    which the deployment lock (§1.2) now correctly refuses. Without a separate
//    observer command, that refusal would leave an operator with no way to see
//    what is happening at all.
//
// So the observer is a distinct, read-only program. It attaches to a RUNNING
// stack, renders it, and detaches. Nothing it does can change the deployment:
// it does not take the deployment lock, it does not take the target lock (§2),
// it does not write the journal, and it does not stop anything —
// "`bun smoke:down` is the only way to stop them."
//
// ── What it observes ────────────────────────────────────────────────────────
//
// Per §1.4, an observer reads "the receipt when present, the journal when not".
// A completed deployment has a receipt and is a static picture; a running or
// interrupted one has only a journal and is a live one. Both are legitimate and
// the TUI must render both, clearly labelled — an operator must never have to
// guess whether the phase on screen is happening now or happened on Tuesday.
//
// ── Relationship to `smoke:status` ──────────────────────────────────────────
//
// `smoke:status` prints once and exits: it is what a script, a runbook step or
// an `ssh host bun smoke:status` uses. This is the interactive one: it
// redraws. They must read the SAME journal and receipt through the same
// functions (`scripts/lib/smoke-journal.ts`), so that a discrepancy between
// what a human saw and what a runbook captured is impossible.
//
// ── Governing spec sections ─────────────────────────────────────────────────
//
//   §1    `bun smoke` exits; `smoke:tui` is its own command and never draws
//         inside a deploying run.
//   §1.1  the instance is what an observer selects by.
//   §1.3  the phase journal is what it renders while a run is in progress.
//   §1.4  receipt-when-present, journal-when-not; and, after replacement began,
//         "`smoke:status` reports the phase and which services are new versus
//         old".
//   §6.2  participants are standing containers with their own lifetime; the
//         observer reports them without touching them.
//
// Acceptance gates served (spec §10, W1): "Sessions and participants survive
// the invoking terminal's exit" — this command is how that is observed without
// re-acquiring the deployment; and "Receipt read by `smoke:status`", whose
// reading path this shares.

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { listInstances, stateRoot, type InstancePaths } from "./lib/smoke-state.ts";
import { readJournal, readReceipt, type DeploymentPlan } from "./lib/smoke-journal.ts";

/** Flags §1 retires "with no alias"; naming one in a refusal is the point. */
const RETIRED_FLAGS = ["--no-tui", "--agents", "--smoke", "--db", "--pg-data", "--twin"];

/** A redraw faster than the docker queries behind it is a load source. */
const MIN_INTERVAL_MS = 1000;
const DEFAULT_INTERVAL_MS = 2000;

/**
 * Parsed argv for the observer. Read-only by construction: there is no field
 * here that could start, stop or mutate anything, and none may be added — a
 * `--down` or `--restart` on the observer would recreate the ownership coupling
 * this command exists to break.
 */
export interface TuiOptions {
  /**
   * Which instance to watch (§1.1). When absent, the observer resolves the
   * single instance with state on this host, and refuses when there are
   * several — see {@link resolveObservedInstance}.
   */
  readonly instance: string | undefined;
  /** Redraw interval, milliseconds. */
  readonly intervalMs: number;
  /**
   * Render one frame and exit, for a non-interactive terminal or a CI log. Not
   * the same thing as `smoke:status`: this is the TUI's own layout, captured
   * once.
   */
  readonly once: boolean;
}

/**
 * Parse argv.
 *
 * Refusal cases:
 *  - any unknown flag refuses, naming it. Spec §1 retires a list of spellings
 *    "with no alias" (`SMOKE_PROJECT`, `--no-tui`, `--agents`, `--smoke`,
 *    `--db`, `--pg-data`, `--twin`); an observer that silently ignored one
 *    would let an operator believe a retired option still meant something.
 *  - `--no-tui` in particular refuses with a pointer to `smoke:status`, since
 *    that is what the flag used to mean and the operator's intent is knowable.
 *  - a non-numeric or sub-second `--interval`: a redraw faster than the docker
 *    queries behind it turns an observer into a load source on the host it is
 *    observing.
 */
export function parseTuiArgs(argv: readonly string[]): TuiOptions {
  let instance: string | undefined;
  let intervalMs = DEFAULT_INTERVAL_MS;
  let once = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--instance") {
      const value = argv[++i];
      if (value === undefined) throw new Error("Refusing: `--instance` needs a name.");
      instance = value;
      continue;
    }
    if (arg === "--once") {
      once = true;
      continue;
    }
    if (arg === "--interval") {
      const value = argv[++i];
      const parsed = value === undefined ? Number.NaN : Number(value);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Refusing: \`--interval ${value ?? ""}\` is not a number of milliseconds.`);
      }
      if (parsed < MIN_INTERVAL_MS) {
        throw new Error(
          `Refusing: an interval of ${parsed}ms turns the observer into a load source; the minimum is ${MIN_INTERVAL_MS}ms.`,
        );
      }
      intervalMs = parsed;
      continue;
    }
    if (arg === "--no-tui") {
      throw new Error("Refusing: `--no-tui` is retired with no alias. Use `bun smoke:status` for a one-shot report.");
    }
    if (RETIRED_FLAGS.includes(arg)) {
      throw new Error(`Refusing: \`${arg}\` is retired with no alias.`);
    }
    throw new Error(`Refusing: unknown flag \`${arg}\`.`);
  }

  return { instance, intervalMs, once };
}

/**
 * Choose the instance to observe.
 *
 * Inputs: the parsed `--instance` (or `undefined`) and the instances with state
 * on this host. Output: the resolved instance's {@link InstancePaths}.
 *
 * Deliberately NOT the resolver in `scripts/lib/smoke-state.ts`. That one
 * implements §1.1's precedence for a run that is about to ACT, and its last two
 * rules — take the persisted local name, else mint a fresh one and persist it —
 * are exactly wrong here: an observer that minted an instance would create
 * state for a deployment that does not exist, and one that fell through to a
 * persisted name could quietly watch a different deployment than the one the
 * operator meant.
 *
 * Refusal cases:
 *  - no instance has state on this host: refuse, saying nothing has been
 *    deployed from here, rather than drawing an empty screen that reads like a
 *    dead stack.
 *  - `--instance` names an instance with no state directory: refuse and list
 *    the names that do exist.
 *  - `--instance` was omitted and several instances have state: refuse and list
 *    them. Guessing is how an operator ends up watching CI while production
 *    burns.
 */
export function resolveObservedInstance(
  requested: string | undefined,
  available: readonly { readonly name: string; readonly paths: InstancePaths }[],
): InstancePaths {
  const names = available.map((entry) => entry.name);
  if (available.length === 0) {
    throw new Error("Refusing: no instance has state on this host — nothing has been deployed from here.");
  }
  if (requested !== undefined) {
    const found = available.find((entry) => entry.name === requested);
    if (found === undefined) {
      throw new Error(`Refusing: instance \`${requested}\` has no state on this host. Known: ${names.join(", ")}.`);
    }
    return found.paths;
  }
  if (available.length > 1) {
    throw new Error(`Refusing: several instances have state here; name one with \`--instance\`. Known: ${names.join(", ")}.`);
  }
  return available[0]!.paths;
}

/**
 * One frame of observed state. A value, not a rendering: the same snapshot
 * feeds the interactive redraw and the `--once` capture, so the two can never
 * disagree about what is true.
 */
export interface ObservedStack {
  readonly instance: string;
  /** `receipt` when the run reached readiness, `journal` while it has not (§1.4). */
  readonly source: "receipt" | "journal";
  /** The phase the run is in, or the phase it stopped at. */
  readonly phase: string;
  /** Whether a deployment lock is currently held — i.e. a run is live. */
  readonly runInProgress: boolean;
  /**
   * Application services and, after the replace phase began, whether each is on
   * the new digest or the old one. §1.4 requires this distinction explicitly.
   */
  readonly services: readonly {
    readonly name: string;
    readonly state: string;
    readonly version: "new" | "old" | "unknown";
  }[];
  /** Standing participant containers (§6.2), by roster name. */
  readonly participants: readonly { readonly name: string; readonly kind: "agent" | "judge"; readonly state: string }[];
  /** Non-fatal notes for the footer, e.g. "journal superseded", "lock held by pid N". */
  readonly notes: readonly string[];
}

/**
 * Collect one snapshot.
 *
 * MUST be read-only in every path: no docker command that starts, stops,
 * removes or recreates anything; no database connection that takes a lock; no
 * write anywhere under the instance's state directory. The observer runs
 * concurrently with a live deployment by design, and a write from here would
 * land in the middle of the journal's before/after phase writes (§1.3).
 *
 * Refusal cases:
 *  - a malformed journal or receipt propagates the refusal from
 *    `scripts/lib/smoke-journal.ts` rather than rendering a blank screen: an
 *    unreadable record is a fact the operator needs, not a missing one.
 *  - docker being unreachable is reported IN the frame, as a note, not thrown:
 *    the journal is still readable and still worth showing, and this is exactly
 *    the moment an operator is trying to find out what happened.
 */
interface SeenContainer {
  readonly name: string;
  readonly state: string;
  readonly image: string;
}

/** `docker ps` only: nothing here starts, stops, removes or recreates anything. */
async function seeContainers(instance: string): Promise<{ containers: SeenContainer[]; note: string | null }> {
  try {
    const child = Bun.spawn(
      [
        "docker",
        "ps",
        "-a",
        "--filter",
        `label=com.docker.compose.project=${instance}`,
        "--format",
        "{{.Names}}\t{{.State}}\t{{.Image}}",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) return { containers: [], note: "docker is unreachable; container state is unknown." };
    const containers = stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [name = "", state = "", image = ""] = line.split("\t");
        return { name, state, image };
      });
    return { containers, note: null };
  } catch {
    return { containers: [], note: "docker is unreachable; container state is unknown." };
  }
}

export async function observe(paths: InstancePaths): Promise<ObservedStack> {
  const instance = basename(paths.dir);
  // Journal first: a malformed one must propagate its own refusal, not be
  // masked by whatever the receipt read says.
  const journal = readJournal(paths);
  const receipt = readReceipt(paths);
  const plan: DeploymentPlan | null = receipt?.plan ?? journal?.plan ?? null;

  const source: "receipt" | "journal" = receipt !== null ? "receipt" : "journal";
  const phase = receipt !== null ? "readiness" : (journal?.phases.at(-1)?.phase ?? "plan");

  const notes: string[] = [];
  const runInProgress = existsSync(paths.lockFile);
  if (runInProgress) {
    let holderPid: unknown;
    try {
      holderPid = (JSON.parse(readFileSync(paths.lockFile, "utf8")) as { holderPid?: number }).holderPid;
    } catch {
      /* an unreadable lock is still a lock */
    }
    notes.push(`lock held by pid ${typeof holderPid === "number" ? holderPid : "unknown"}`);
  }

  const { containers, note } = await seeContainers(instance);
  if (note !== null) notes.push(note);

  const match = (member: string): SeenContainer | undefined => containers.find((c) => c.name.includes(member));

  const services = Object.entries(plan?.images ?? {}).map(([name, digest]) => {
    const container = match(name);
    const version: "new" | "old" | "unknown" =
      container === undefined ? "unknown" : container.image.includes(digest) ? "new" : "old";
    return { name, state: container?.state ?? "absent", version };
  });

  const participants = [
    ...(plan?.roster.agents ?? []).map((name) => ({ name, kind: "agent" as const })),
    ...(plan?.roster.judges ?? []).map((name) => ({ name, kind: "judge" as const })),
  ].map((member) => ({ ...member, state: match(member.name)?.state ?? "absent" }));

  return { instance, source, phase, runInProgress, services, participants, notes };
}

/**
 * Render one snapshot to a string.
 *
 * Must label the source (`receipt` = finished, `journal` = in progress or
 * interrupted) unmissably. Must redact: the frame is a screenshot an operator
 * pastes into an incident thread, and §1.2's redaction promise does not stop at
 * the plan.
 */
/** §1.2's redaction promise does not stop at the plan: the frame is a screenshot. */
function redact(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]*@/gi, "$1:***@");
}

export function renderFrame(stack: ObservedStack, width: number): string {
  const lines = [
    `smoke:tui — instance ${stack.instance}`,
    stack.source === "receipt"
      ? "source: receipt — this deployment FINISHED; nothing below is happening now"
      : "source: journal — this deployment is IN PROGRESS or was interrupted",
    `phase: ${stack.phase}    run in progress: ${stack.runInProgress ? "yes" : "no"}`,
    "services:",
    ...stack.services.map((s) => `  ${s.name}  ${s.state}  ${s.version}`),
    "participants:",
    ...stack.participants.map((p) => `  ${p.name}  ${p.kind}  ${p.state}`),
    "notes:",
    ...stack.notes.map((n) => `  ${redact(n)}`),
  ];
  return lines.map((line) => line.slice(0, Math.max(0, width))).join("\n");
}

/**
 * The command entry point: parse, resolve, then loop {@link observe} +
 * {@link renderFrame} until the operator quits, or render once under `--once`.
 *
 * Exit codes are about the OBSERVER, not the stack. Quitting a TUI that is
 * watching a failed deployment exits 0: the observation succeeded. A non-zero
 * exit means the observer could not observe — no instance, an ambiguous
 * selection, an unreadable journal. Conflating the two would make
 * `smoke:tui --once` unusable in any script that checks a status.
 *
 * Quitting must leave the stack untouched. Not a note — a requirement: this is
 * the command an operator reaches for when something is wrong, and the reflex
 * that ends it is Ctrl-C.
 */
export async function main(argv: readonly string[]): Promise<number> {
  let paths: InstancePaths;
  let options: TuiOptions;
  try {
    options = parseTuiArgs(argv);
    const root = stateRoot(process.env);
    const available = listInstances(root).map((entry) => ({ name: entry.name, paths: entry.paths }));
    paths = resolveObservedInstance(options.instance, available);
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    return 1;
  }

  const width = process.stdout.columns ?? 100;
  const draw = async (): Promise<void> => {
    console.log(renderFrame(await observe(paths), width));
  };

  try {
    if (options.once) {
      await draw();
      return 0;
    }
    // Quitting must leave the stack untouched: there is nothing to undo here,
    // because nothing above was acquired.
    for (;;) {
      await draw();
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    }
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
