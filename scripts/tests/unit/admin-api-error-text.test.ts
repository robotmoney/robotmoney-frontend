// apiErrorText() returns the API's `{ error }` TOKEN, bare (issue #968).
//
// Two admin branches compare its return value — `message === "stale_version"`
// in swarm-member.js, twice — to decide whether an operator is told "reload and
// try again" or handed the raw conflict. Both are silent when they break: the
// else arm still renders something, so the page looks fine and only the advice
// is gone. admin-view.spec.ts covers them, but only in the ~40-minute e2e tier
// behind a live stack, and it caught this exact regression AFTER everything
// cheap had gone green.
//
// The regression it caught: apiErrorText() used to recover the token by
// stripping `API <status>: ` off the message and JSON.parsing what was left.
// Once lib/api.js unwrapped the envelope itself, the remainder was the bare
// token — which is not JSON — so the parse threw and the function returned the
// PREFIXED message, and `=== "stale_version"` stopped matching.
import { describe, expect, test } from "bun:test";

const realWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window?: unknown }).window = { RM_CONFIG: { API_BASE_URL: "" } };

// api.js carries @ts-nocheck (browser-facing plain JS), so its constructor's
// options type does not survive the import — named here rather than cast at
// each call site.
type ApiErrorOptions = { code?: string; url?: string; detail?: string; reason?: string };
type ApiErrorCtor = new (status: number, message: string, options?: ApiErrorOptions) => Error;
const { ApiError } = (await import("../../../frontend/public/assets/js/app/lib/api.js")) as {
  ApiError: ApiErrorCtor;
};
const { apiErrorText } = await import(
  "../../../frontend/public/assets/js/app/alpine/views/admin/shared.js"
);

(globalThis as { window?: unknown }).window = realWindow;

// Exactly what request() builds for `409 {"ok":false,"status":409,"error":"stale_version"}`
// — the answer admin-view.spec.ts stubs, and updateMemberAdmin's real one.
function conflict(reason: string) {
  return new ApiError(409, `API 409: ${reason}`, {
    code: "http",
    url: "/api/swarm/admin/members/athena",
    detail: JSON.stringify({ ok: false, status: 409, error: reason }),
    reason,
  });
}

describe("apiErrorText", () => {
  test("returns the envelope token bare, so the stale_version branches can compare it", () => {
    expect(apiErrorText(conflict("stale_version"))).toBe("stale_version");
  });

  test("any other conflict token comes back bare too, and is NOT the stale_version token", () => {
    // The uniqueness conflict a reload cannot clear (issue #593) — it must keep
    // reaching the else arm rather than inheriting the reload advice.
    expect(apiErrorText(conflict("handle already taken"))).toBe("handle already taken");
  });

  test("an error with no envelope falls back to its message", () => {
    const noEnvelope = new ApiError(502, "The API is unavailable — it answered 502 Bad Gateway.", {
      code: "http",
      detail: "<html>…</html>",
    });
    expect(apiErrorText(noEnvelope)).toBe("The API is unavailable — it answered 502 Bad Gateway.");
  });

  test("the pre-#968 shape (envelope embedded in the message) still resolves", () => {
    // Nothing throws this today, but the fallback is cheap and its removal
    // would be silent in the same way the bug above was.
    expect(apiErrorText(new Error('API 409: {"error":"stale_version"}'))).toBe("stale_version");
  });

  test("a plain error, or no error at all, never throws", () => {
    expect(apiErrorText(new Error("boom"))).toBe("boom");
    expect(apiErrorText(undefined)).toBe("");
    expect(apiErrorText(null)).toBe("");
  });
});
