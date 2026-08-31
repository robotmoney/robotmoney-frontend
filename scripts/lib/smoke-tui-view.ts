// The standing smoke's TUI STATE MACHINE (issue #456 — extracted out of the
// 2087-line scripts/lib/smoke-main.ts, which the 2026-07-14 maintainability
// review flagged at 1131 lines/finding review-maintainability-032 and which
// had since grown to 2087 lines/45 functions without the split it called
// for). This module owns the SmokeState shape, its transitions (setContainer /
// setStep / startOnboarding / setOnboardStep / swarmProgress), and the
// pure display helpers the panes render with (glyphs, duration formatting,
// column layout).
//
// Every function here takes its state EXPLICITLY as a parameter — no
// module-level mutable state of its own — so smoke-main.ts (or a future unit
// test) owns exactly one SmokeState instance and threads it through. That is
// the same shape the issue asked for the retired process.env.ADMIN_TOKEN
// global mutation to move to.
//
// render() / renderResearch() / renderSwarm() stay in smoke-main.ts: they
// stitch this module's pieces together with smoke-main-only context (the TUI
// handle, the compose project name, boot uptime, the admin password, the
// readiness-polling instance) that has no reason to live anywhere else.
import { color, spinner, truncate, visibleLen } from "./tui.ts";
import type { ContainerLogLine, ContainerTelemetry } from "./smoke-telemetry.ts";

export type Phase = "pending" | "building" | "starting" | "healthy" | "failed";
export type StepStatus = "pending" | "running" | "done" | "failed";
export interface ResearchEntry { id: number; kind: string; state: "queued" | "running" | "done"; asof?: string; at?: string; note: string; }
export interface MemberState { stage: "connect" | "fetch" | "thinking" | "reporting" | "waiting" | "done" | "absent"; stance?: string; confidence?: number; }
// Local structural mirror of the swarm session driver's callback shape
// (scripts/lib/swarm/session.ts SessionProgress). The driver is loaded
// via a dynamic import() (untyped) so this annotation stays decoupled from
// that dynamic boundary.
// `judgeMode` rides only on the `judged` event (issue #817) and says whether
// the judgement that landed was recorded and withheld (`shadow`) or applied
// (`enforce`) — the distinction the soak exists to observe.
export type SessionProgress = (ev:
  | { type: "session"; state: string; sessionId?: number; subject: string; date?: string; judgeMode?: string }
  | { type: "member"; memberId: string; stage: MemberState["stage"]; stance?: string; confidence?: number }
) => void;
// Per-subject swarm pane. Each subject (woon, mav, …) runs on its OWN
// schedule and gets its OWN pane, so the TUI shows them side by side.
export interface SwarmState {
  subjectName: string;
  sessionState: string;
  sessionId?: number;
  members: Record<string, MemberState>;
  publishedCount: number;
  history: { date: string; synthesis: string }[];
  nextAt: number; // epoch-ms of this subject's next session; 0 = running now
}
// Prospective swarm-member onboarding, shown as a full-width checklist
// strip. The steps mirror the real join gates; session/memo/admitted flip to
// done when the new member is observed participating (take + memo) in a live
// session.
export type OnboardStepStatus = "pending" | "running" | "done" | "failed";
export interface OnboardStep { key: string; status: OnboardStepStatus; }
export interface OnboardState { memberId: string; name: string; steps: OnboardStep[]; }
// A member scheduled to be admitted in the future, with the epoch-ms of its
// admission so the TUI can render a live countdown.
export interface UpcomingMember { memberId: string; name: string; at: number; }
// How the DB-writing lanes ended up after a startup failure. This — not the
// error text — is what says whether the database stopped changing, so the TUI
// renders it verbatim rather than implying it.
export type WriterQuiesce = "pending" | "stopped" | "failed" | "none";

// A startup failure, surfaced IN the TUI rather than by exiting. A failed boot
// used to print to a dead terminal and leave the stack writing; the operator
// saw neither the cause nor the fact that the database was still moving.
export interface FatalState {
  step?: string;      // the boot step that failed, if it failed inside one
  message: string;
  detail: string[];   // extra lines (drift rows, hints) shown under the message
  writers: WriterQuiesce;
}

export interface SmokeState {
  services: { name: string; url: string }[];
  containers: { name: string; phase: Phase; detail?: string }[];
  steps: { name: string; status: StepStatus }[];
  research: ResearchEntry[];
  swarms: Record<string, SwarmState>; // keyed by subject id
  onboarded: OnboardState[]; // every prospective member that has entered onboarding
  upcoming: UpcomingMember[]; // scheduled future admissions with a countdown
  messages: string[];
  fatal?: FatalState; // set once, by the startup-failure path only
  // Observed container state, refreshed on a slow timer. Docker's own
  // `restart: unless-stopped` is the supervisor; these are only its readings.
  telemetry: ContainerTelemetry[];
  containerErrors: ContainerLogLine[];
  // Tri-state claim status for the admin credential (issue #553 / D32):
  // undefined = not yet probed (display nothing), false = confirmed unclaimed
  // (the per-boot token is the operator credential — display it), true =
  // claimed (the per-boot token is superseded — never display it).
  adminClaimed?: boolean;
}

export const ONBOARD_STEPS = ["connect", "discover", "toolchain", "apply", "approve", "claim", "session", "memo", "admitted"];

// The Research pane. Lives here rather than in smoke-main for the same reason
// every other pure renderer does (issue #456): it is a function of the state
// and the two countdowns, so smoke-main passes them rather than closing over
// its readiness poller.
export function renderResearchPane(
  state: SmokeState,
  height: number,
  nextRegime: string,
  nextResearch: string,
): string[] {
  const out = [
    color("1", "Research") + color("2", `  next regime ${nextRegime} · research ${nextResearch}`),
    color("2", "kind                 state    detail"),
  ];
  for (const e of state.research.slice(0, Math.max(0, height - 2))) {
    const stateLbl = e.state === "done" ? color("32", "done ") : e.state === "running" ? color("33", "run  ") : color("2", "queue");
    out.push(`${ticks(e.state)} ${e.kind.padEnd(17)} ${stateLbl} ${e.note}`);
  }
  if (state.research.length === 0) out.push(color("2", "  (waiting for the worker's scheduler to fire…)"));
  return out;
}

// ── State transitions ───────────────────────────────────────────────────────
export function setContainer(state: SmokeState, name: string, phase: Phase, detail?: string): void {
  const c = state.containers.find((x) => x.name === name);
  if (c) { c.phase = phase; if (detail !== undefined) c.detail = detail; }
}
export function setStep(state: SmokeState, name: string, status: StepStatus): void {
  const s = state.steps.find((x) => x.name === name);
  if (s) s.status = status;
}
// Record the startup failure. FIRST failure wins: the quiesce path itself can
// raise follow-on errors, and overwriting would replace the real cause with a
// symptom. Marks the owning step failed so the Startup pane and the failure
// pane agree.
export function setFatal(
  state: SmokeState,
  message: string,
  opts: { step?: string; detail?: readonly string[] } = {},
): void {
  if (state.fatal) return;
  state.fatal = { step: opts.step, message, detail: [...(opts.detail ?? [])], writers: "pending" };
  if (opts.step) setStep(state, opts.step, "failed");
}
export function setFatalWriters(state: SmokeState, writers: WriterQuiesce): void {
  if (state.fatal) state.fatal.writers = writers;
}
// Begin (or resume) a member's join checklist. The member is appended to the
// persistent onboarded list so its status checks stay in the pane after
// admission, and it is dropped from the upcoming queue now that its turn has
// arrived.
export function startOnboarding(state: SmokeState, memberId: string, name: string): void {
  if (!state.onboarded.some((o) => o.memberId === memberId)) {
    state.onboarded.push({ memberId, name, steps: ONBOARD_STEPS.map((key) => ({ key, status: "pending" as OnboardStepStatus })) });
  }
  state.upcoming = state.upcoming.filter((u) => u.memberId !== memberId);
}
export function setOnboardStep(state: SmokeState, memberId: string, key: string, status: OnboardStepStatus): void {
  const step = state.onboarded.find((o) => o.memberId === memberId)?.steps.find((s) => s.key === key);
  if (step) step.status = status;
}

// ── Swarm session progress → SmokeState ──────────────────────────────────
// Maps the additive runSession/runAgent callback events onto swarm state
// and logs milestones. All member stages here are REAL pipeline events
// emitted by the agent (connect/fetch/thinking/reporting/done) — no
// fabricated sub-steps.
export function swarmProgress(state: SmokeState, subjectId: string, log: (msg: string) => void): SessionProgress {
  return (ev) => {
    const c = state.swarms[subjectId];
    if (!c) return;
    if (ev.type === "session") {
      c.sessionState = ev.state;
      if (ev.sessionId) c.sessionId = ev.sessionId;
      // Window closed → present members have submitted and now wait for synthesis.
      if (ev.state === "window_closed") {
        for (const id of Object.keys(c.members)) if (c.members[id].stage === "done") c.members[id].stage = "waiting";
      }
      // The judge's mode is the whole point of the `judged` event: "judged"
      // alone cannot tell a recorded-and-withheld judgement from an applied one.
      log(`swarm ${subjectId}: ${ev.state}${ev.judgeMode ? ` (${ev.judgeMode})` : ""}`);
    } else {
      c.members[ev.memberId] = { stage: ev.stage, stance: ev.stance, confidence: ev.confidence };
      // If this is an onboarding prospect, reflect its first live participation
      // (submitting a take + posting a memo) in that member's join checklist.
      const ob = state.onboarded.find((o) => o.memberId === ev.memberId);
      if (ob && ev.stage !== "absent") {
        if (ev.stage === "done") {
          setOnboardStep(state, ob.memberId, "session", "done");
          setOnboardStep(state, ob.memberId, "memo", "done");
          setOnboardStep(state, ob.memberId, "admitted", "done");
          log(`onboarding ${ev.memberId}: admitted — participated + pushed memo`);
        } else {
          setOnboardStep(state, ob.memberId, "session", "running");
        }
      }
    }
  };
}

// ── Pure display helpers ────────────────────────────────────────────────────
export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
// Seconds → "m:ss" for the pane countdowns; "—" when unknown (not yet polled).
export const fmtCountdown = (secs: number | null): string => (secs == null ? "—" : fmtDuration(secs * 1000));

export function phaseGlyph(p: Phase, frame: number): string {
  if (p === "building") return color("33", spinner(frame));
  if (p === "starting") return color("36", spinner(frame));
  if (p === "healthy") return color("32", "✓");
  if (p === "failed") return color("31", "✗");
  return color("2", "·"); // pending
}
export function stepGlyph(s: StepStatus, frame: number): string {
  return s === "done" ? color("32", "✓") : s === "failed" ? color("31", "✗") : s === "running" ? color("33", spinner(frame)) : color("2", "·");
}
export function onboardGlyph(s: OnboardStepStatus, frame: number): string {
  return s === "done" ? color("32", "✓") : s === "failed" ? color("31", "✗") : s === "running" ? color("33", spinner(frame)) : color("2", "·");
}
// Three ticks that advance ONLY on the observable queued→running→done job
// states. They are NOT fabricated fetch/process/report sub-steps — the
// labels stay honest about that granularity (we only observe the queue
// transitions).
export function ticks(st: ResearchEntry["state"]): string {
  const on = color("32", "●"), off = color("2", "○");
  const n = st === "queued" ? 1 : st === "running" ? 2 : 3;
  return [0, 1, 2].map((i) => (i < n ? on : off)).join("");
}
export const STAGE_COLOR: Record<MemberState["stage"], string> = {
  connect: "36", fetch: "34", thinking: "33", reporting: "35", waiting: "36", done: "32", absent: "2",
};
export function memberGlyph(m: MemberState, frame: number): string {
  if (m.stage === "done") return color("32", "✓");
  if (m.stage === "absent") return color("2", "✗");
  if (m.stage === "waiting") return color("36", "◔");
  return color(STAGE_COLOR[m.stage], spinner(frame));
}

// Equal-width column width for k side-by-side panes (accounting for " │ " gaps).
export function columnWidth(width: number, k: number): number {
  return Math.floor((width - 3 * (k - 1)) / k);
}
// N side-by-side columns, joined by vertical rules; each cell truncated/padded
// to an equal width. Rows past a column's content are blank.
export function columns(panes: string[][], width: number): string[] {
  const k = panes.length;
  const gap = " │ ";
  const colW = Math.max(12, columnWidth(width, k));
  const n = Math.max(0, ...panes.map((p) => p.length));
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const cells = panes.map((p) => {
      const cell = truncate(p[i] ?? "", colW);
      return cell + " ".repeat(Math.max(0, colW - visibleLen(cell)));
    });
    out.push(cells.join(gap));
  }
  return out;
}
