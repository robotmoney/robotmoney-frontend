// scripts/release/notify.ts — the one owner notification a stage run sends
// when it stops (issue 1555; policy section 4.4.1).
//
// The only transport is a comment on the release's tracking issue: the one open
// issue labelled `release:<release>` (policy section 6). The comment names the
// run stamp, the step, the kind of stop, the detail and the exact command to
// continue. Its text passes through ./scrub.ts before gh sees it.
//
// It never throws and never changes a run's exit code. When the label lookup
// finds no single issue, or gh fails, the message goes to stderr and the caller
// records `notified: false` with the reason.
import { scrubSecrets } from "./scrub.ts";
import { CONTROL_HOST, CONTROL_REPO, shellQuote } from "./steps.ts";

/** What a notification is about: a run's stop, a blocked step, or a driver the supervisor found dead. */
export type NotifyKind = "passed" | "failed" | "refused" | "paused" | "blocked" | "died";

export interface StopEvent {
  readonly release: string;
  readonly target: string;
  /** The run stamp, when the run has one. */
  readonly runTs?: string;
  readonly kind: NotifyKind;
  readonly step?: string;
  readonly detail: string;
  /** The exact command that continues the run. */
  readonly resume: string;
  readonly at: string;
}

export type NotifyResult = { notified: true; issue: number } | { notified: false; reason: string };

export interface NotifyDeps {
  collect(host: string, remote: string): Promise<{ code: number; stdout: string }>;
  error(line: string): void;
}

const NAME = "release:notify";

/** The tracking issue's label (policy section 6). */
export function releaseLabel(release: string): string {
  return `release:${release}`;
}

/** The control-machine command that lists the open issues carrying the release's label. */
export function labelLookupCommand(release: string): string {
  return `cd ${shellQuote(CONTROL_REPO)} && gh issue list --label ${shellQuote(releaseLabel(release))} --state open --json number`;
}

/** The one open issue labelled `release:<release>`, or why there is not exactly one. */
export async function findReleaseIssue(release: string, deps: Pick<NotifyDeps, "collect">): Promise<{ issue: number } | { reason: string }> {
  let r: { code: number; stdout: string };
  try {
    r = await deps.collect(CONTROL_HOST, labelLookupCommand(release));
  } catch (error) {
    return { reason: `gh issue list failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (r.code !== 0) return { reason: `gh issue list exited ${r.code}` };
  let list: unknown;
  try { list = JSON.parse(r.stdout); } catch { return { reason: "gh issue list did not answer JSON" }; }
  const numbers = Array.isArray(list) ? list.map((x) => (x as { number?: unknown })?.number).filter((n): n is number => typeof n === "number") : [];
  if (numbers.length !== 1) return { reason: `${numbers.length} open issues carry the label ${releaseLabel(release)}; exactly one must (policy section 6)` };
  return { issue: numbers[0]! };
}

/** The comment text, scrubbed. */
export function notificationBody(e: StopEvent): string {
  const lines = [
    `**release:run ${e.target} ${e.kind}**${e.runTs ? ` — run \`${e.runTs}\`` : ""}${e.step ? `, step \`${e.step}\`` : ""}`,
    "",
    `- run: ${e.runTs ?? "(none: refused before a journal existed)"}`,
    `- step: ${e.step ?? "(none)"}`,
    `- kind: ${e.kind}`,
    `- at: ${e.at}`,
    `- detail: ${e.detail}`,
    "",
    "Continue with:",
    "```",
    e.resume,
    "```",
  ];
  return scrubSecrets(lines.join("\n"));
}

/** Post one notification. Never throws; on any failure the message goes to stderr. */
export async function notify(e: StopEvent, deps: NotifyDeps): Promise<NotifyResult> {
  let body = "";
  try {
    body = notificationBody(e);
    const found = await findReleaseIssue(e.release, deps);
    if ("reason" in found) return fallback(found.reason, body, deps);
    const r = await deps.collect(CONTROL_HOST, `cd ${shellQuote(CONTROL_REPO)} && printf '%s\\n' ${shellQuote(body)} | gh issue comment ${found.issue} --body-file -`);
    if (r.code !== 0) return fallback(`gh issue comment exited ${r.code}`, body, deps);
    return { notified: true, issue: found.issue };
  } catch (error) {
    return fallback(`notify failed: ${error instanceof Error ? error.message : String(error)}`, body, deps);
  }
}

function fallback(reason: string, body: string, deps: NotifyDeps): NotifyResult {
  try { deps.error(`[${NAME}] not posted (${reason}). The notification:\n${body}`); } catch { /* stderr is the last resort */ }
  return { notified: false, reason };
}
