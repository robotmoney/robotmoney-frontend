// The plan's `configuration` field (smoke-production-spec.md §1.2): every
// non-secret value that changes what a boot does, keyed by environment-variable
// name. Built here, as a pure function, so a test can compose it with the
// redaction guard (`assertPlanRedacted`) — the two were written together in the
// deployment refactor and never run together in a test, which let a field named
// `SPOOF_KEYS` ship; the guard refuses any key named like a secret, and that
// one was the first `--spoof-keys` rehearsal's refusal (2026-10-02).
//
// Not the compose project (derived from the instance, and random-looking
// enough that the redaction check would rightly refuse it), not a URL (a Base
// RPC URL can carry an API key in its path), and no key whose name reads as a
// secret: the value `--spoof-keys` carries is a member list, so its key says
// MEMBERS, never KEYS.
import type { RmEnv } from "../../backend/src/acceptance-path.ts";
import type { SmokeCadenceProfile } from "./smoke-cadence.ts";

export interface PlanConfigurationInputs {
  readonly stackRmEnv: RmEnv;
  readonly cadenceProfile: SmokeCadenceProfile;
  readonly staticPortMode: boolean;
  readonly shippedImages: boolean;
  readonly analyticsSource: string;
  readonly analyticsFloorSeed: string;
  /** `--spoof-keys` as parsed from argv: explicit on argv, with the names it lists. */
  readonly spoofRequest: { readonly explicit: boolean; readonly names: readonly string[] };
}

/** The in-house selector a bare `--spoof-keys` means (spec §6.4). */
export const SPOOF_EVERY_IN_HOUSE_MEMBER = "operator=robotmoney";

export function planConfiguration(inputs: PlanConfigurationInputs): Record<string, string> {
  return {
    RM_ENV: inputs.stackRmEnv,
    SMOKE_CADENCE: inputs.cadenceProfile,
    STATIC_PORT: String(inputs.staticPortMode),
    SHIPPED_IMAGES: String(inputs.shippedImages),
    ANALYTICS_SOURCE: inputs.analyticsSource,
    ANALYTICS_FLOOR_SEED: inputs.analyticsFloorSeed,
    // Which members `--spoof-keys` names; every in-house one when bare.
    ...(inputs.spoofRequest.explicit
      ? { SPOOF_MEMBERS: inputs.spoofRequest.names.join(",") || SPOOF_EVERY_IN_HOUSE_MEMBER }
      : {}),
  };
}
