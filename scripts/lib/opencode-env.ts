import { resolveOpenCodeTimeoutMs } from "../agent/opencode-run.ts";

/**
 * OPENCODE_TIMEOUT_MS as the explicit environment passed to an OpenCode
 * subprocess or member-agent container.
 *
 * This is runtime plumbing shared by every session mode, not a smoke-mode
 * decision. A set value is propagated verbatim after trimming. An unset or
 * blank value omits the key entirely: `Number("")` is zero, so serializing an
 * absent value as `OPENCODE_TIMEOUT_MS=` would create an instant timeout rather
 * than preserving the inference layer's committed default.
 */
export function opencodeTimeoutEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const raw = env.OPENCODE_TIMEOUT_MS?.trim();
  if (!raw) return {};
  // Validate through the same parser used by inference and by the outer
  // member-container ceiling. Preserve the operator's trimmed spelling when
  // forwarding it; only its semantics are centralized.
  resolveOpenCodeTimeoutMs(env);
  return { OPENCODE_TIMEOUT_MS: raw };
}
