// Shared parser for the `opencode run --format json` NDJSON transcript
// (docs/architecture.md §11.3 E5, docs/decisions.md D22 "shared components").
//
// Moved out of scripts/lib/swarm/inference.ts so BOTH consumers read the
// stream with one definition: the swarm take author (which wants all the
// authored prose) and the member-agent outcome classifier
// (scripts/agent/classify-outcome.ts, which wants only the agent's FINAL
// message — its verdict — never its running commentary).
//
// opencode 1.16.x emits one JSON object per line; a finalized assistant text
// part is `{"type":"text","part":{"type":"text","text":"…"}}` (the CLI only
// prints a `text` event once the part's `time.end` is set). Non-text events
// (step_start / step_finish / tool_use / reasoning) and unparseable lines are
// ignored — which is also why a transcript wrapped in the member-agent
// primitive's `--- stdout ---`/`--- stderr ---` banners parses fine.

// Every finalized assistant text part, in stream order. Returns [] when the
// transcript carries no assistant text at all (empty/failed/dead run).
export function assistantTextParts(transcript: string): string[] {
  const parts: string[] = [];
  for (const line of transcript.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (ev?.type === "text") {
      const text = ev?.part?.text;
      if (typeof text === "string" && text.trim()) parts.push(text);
    }
  }
  return parts;
}

// The model's authored prose for the whole run. Returns "" when the transcript
// carries no assistant text (empty/failed run) so the caller can throw loudly.
export function extractAssistantText(transcript: string): string {
  return assistantTextParts(transcript).join("\n").trim();
}

// The LAST authored text part — the agent's closing verdict, which is what
// refusal detection keys on: an agent that mentions declining mid-run and then
// goes on to complete the task has not refused. Returns "" for an
// empty/unparseable transcript, so a DEAD run can never be mistaken for a
// REFUSED one (§11.3 E3 layer 0's "distinguishes dead from refused").
export function finalAssistantText(transcript: string): string {
  return assistantTextParts(transcript).at(-1)?.trim() ?? "";
}
