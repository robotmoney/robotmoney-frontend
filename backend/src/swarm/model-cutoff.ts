// A language model asked to act as of a date before its training cutoff already
// knows what happened next, so its answer is not a forecast (issue 1742, finding
// R4 of the lucky-weight-invariant review). This is the pure guard. The table it
// reads lives next to the pinned judge model in judge-model-policy.ts.
//
// A model with no declared cutoff is refused for any date before today. A
// session dated today passes for every model, exactly as before.

import { MODEL_CUTOFF_DATES } from "./judge-model-policy.ts";

export class SessionBeforeModelCutoffError extends Error {
  readonly code = "session_before_model_cutoff";
  constructor(
    readonly model: string | null,
    readonly sessionDate: string,
    readonly cutoff: string | null,
  ) {
    super(
      cutoff
        ? `session dated ${sessionDate} is before the training cutoff ${cutoff} of judge model "${model}"`
        : `session dated ${sessionDate} is before today and judge model "${model ?? "(none)"}" declares no training cutoff`,
    );
    this.name = "SessionBeforeModelCutoffError";
  }
}

/** Dates are `YYYY-MM-DD`, so string order is date order. `today` is the database's UTC date. */
export function assertSessionNotBeforeModelCutoff(
  model: string | null | undefined,
  sessionDate: string,
  today: string,
): void {
  const id = model ? model.trim().replace(/^opencode\//, "") : null;
  const cutoff = id ? MODEL_CUTOFF_DATES[id] ?? null : null;
  const floor = cutoff ?? today;
  if (sessionDate < floor) throw new SessionBeforeModelCutoffError(id, sessionDate, cutoff);
}
