// THE D-A7 REFUSAL TAXONOMY, where the judge now runs (issue #1026, D53 point 4).
//
// The inline backend judge carried these names in `judge.ts` until D53 deleted
// it. The names survive because an operator fixes each one differently, and a
// participant that answered every vendor failure with the same free text sent
// every one of them to the same place:
//
//   credit_exhausted         the vendor was asked and answered 402, or named
//                            credit / balance / quota / payment. Top up the
//                            account. Never a retryable blip.
//   credential_rejected      401 or 403 with no model complaint in the body. A
//                            revoked, wrong or truncated key. Fix the key.
//   model_not_supported      the body names the MODEL, not the credential. Zen
//                            answers the `opencode/`-prefixed selector with
//                            401 + `ModelError`, which reads as "bad key" and
//                            is not. Fix the model id.
//   model_unconfigured       no model was given to this judge. Nothing was
//                            asked.
//   credential_unconfigured  a model was given and no key. Nothing was asked.
//   model_disallowed         the model given is one this environment may not
//                            use (judge-model-policy.ts: the keyless free
//                            family everywhere, anything but the pinned model
//                            on an acceptance path). Nothing was asked.
//   model_timeout            the vendor was asked and did not answer within
//                            the judge's timeout.
//   model_unavailable:<n>    the vendor answered HTTP <n> and it was none of
//                            the above — a 429 or a 5xx.
//
// AND ONE THAT IS NOT IN IT: `runner`. The judge runner's own fault — a
// prompt file it could not read, a DNS failure, a crash — says nothing about
// the vendor and must never be reported as a vendor refusal (judge-runner.ts,
// "why two of its arms must never merge"). It is its own code, beside the
// taxonomy rather than inside it.
//
// EVERY ONE OF THESE SUBMITS NOTHING. A judge refuses rather than fakes: the
// session reaches its deadline with no eligible consensus and publishes
// `no_consensus` (system-scheduler-spec.md §4.4). The code is what the operator
// reads to learn why.
import type { JudgeAnswer } from "./judge-runner.ts";

/** A vendor-side or configuration refusal, by the D-A7 name. */
export type JudgeRefusalReason =
  | "credit_exhausted"
  | "credential_rejected"
  | "model_not_supported"
  | "model_unconfigured"
  | "credential_unconfigured"
  | "model_disallowed"
  | "model_timeout"
  | `model_unavailable:${number}`;

/** The runner's own fault. Deliberately not a `JudgeRefusalReason`. */
export const RUNNER_FAULT = "runner" as const;

export type JudgeFailureCode = JudgeRefusalReason | typeof RUNNER_FAULT;

/** Credit/quota wording, from any status. An exhausted workspace, not an outage. */
const CREDIT_BODY = /insufficient|credit|balance|quota|billing|payment_required|payment required/i;
/** "this endpoint does not serve that model id" — the `opencode/` prefix case. */
const UNSUPPORTED_MODEL_BODY = /not supported|modelerror|unknown model|model_not_found|no such model/i;

/**
 * Classify a vendor's non-success answer.
 *
 * The body is read FIRST for the two cases a status cannot tell apart: Zen
 * answers an unfunded workspace with a credit message under more than one
 * status, and an unsupported model id with 401. Ambiguity resolves toward the
 * account, not the model: a 429 whose body mentions quota is exhausted credit,
 * because topping up is the fix an operator would otherwise not look for.
 */
export function classifyModelStatus(status: number, body: string): JudgeRefusalReason {
  if (status === 402 || CREDIT_BODY.test(body)) return "credit_exhausted";
  if (UNSUPPORTED_MODEL_BODY.test(body)) return "model_not_supported";
  if (status === 401 || status === 403) return "credential_rejected";
  return `model_unavailable:${status}`;
}

/** The failure code a runner answer carries, or null for an `ok` answer. */
export function failureCodeForAnswer(answer: JudgeAnswer): JudgeFailureCode | null {
  switch (answer.kind) {
    case "ok":
      return null;
    case "model_status":
      return classifyModelStatus(answer.status, answer.body);
    case "timeout":
      return "model_timeout";
    case "runner":
      return RUNNER_FAULT;
  }
}
