// Unit coverage for swarmView's synthesisPreview() (issue #358, test-plan
// item 2). Same no-DOM/no-Alpine-runtime pattern as
// swarm-apply-form-and-status.test.ts: capture the Alpine.data factory
// with a stub Alpine, instantiate the plain data object, and drive the pure
// method directly.
//
// Before #358, GET /api/swarm/sessions never returned a `synthesis`
// field on list rows (backend/src/swarm/projections.ts's
// toSessionListItem dropped it as one of the "big fields" — see #243), so
// `s.synthesis` was always undefined and this method always returned "" —
// the swarm index's <p class="sv__session-copy"> never rendered. #358
// wires the field back onto the light projection (bounded, sourced from
// #323's corrected non-echo synthesis value); these tests assert the
// existing synthesisPreview() logic renders that value once present, rather
// than the field addition landing with no assertion the render path actually
// lights up.
import { describe, expect, test } from "bun:test";
import { registerSwarmView } from "../../../frontend/public/assets/js/app/alpine/views/swarm.js";

// A stub Alpine that captures Alpine.data(name, factory) — mirrors
// swarm-apply-form-and-status.test.ts's captureFactories helper.
function captureSwarmView(): () => Record<string, unknown> {
  let factory: (() => Record<string, unknown>) | null = null;
  const stub = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === "data"
          ? (_name: string, f: () => Record<string, unknown>) => {
              factory = f;
            }
          : () => {},
    },
  );
  registerSwarmView(stub as any);
  if (!factory) throw new Error("registerSwarmView never called Alpine.data — factory not captured");
  return factory;
}

describe("swarmView.synthesisPreview: renders the post-#323/#358 excerpt, still hides the pre-#323 echo shape (issue #358)", () => {
  test("a real deterministic synthesis sentence (issue #323 shape) renders verbatim", () => {
    const v = captureSwarmView()() as any;
    const synthesis =
      "3 of 5 members (60% participation) reviewed Woon Treasury. Stance split: 2 bullish, 1 cautious. " +
      "No material disagreement was recorded among submitted takes.";
    expect(v.synthesisPreview({ synthesis })).toBe(synthesis);
  });

  test("no synthesis field at all (pre-#358 list response) renders empty — the field addition is what unblocks this, not a template change", () => {
    const v = captureSwarmView()() as any;
    expect(v.synthesisPreview({})).toBe("");
    expect(v.synthesisPreview({ synthesis: null })).toBe("");
    expect(v.synthesisPreview({ synthesis: "" })).toBe("");
  });

  test("the pre-#323 echo shape (markdown take-body dump, '**' headers) is still suppressed even if it somehow reappeared", () => {
    const v = captureSwarmView()() as any;
    const echoed = "**REGIME**\n- Composite 0.5 at the 50th percentile.\n\n**ALLOCATION**\n- Targets stay 95/5/0/0.";
    expect(v.synthesisPreview({ synthesis: echoed })).toBe("");
  });

  test("an oversized value (defensive ceiling, issue #358's bound) is still suppressed by the existing >600-char guard", () => {
    const v = captureSwarmView()() as any;
    const huge = "x".repeat(601);
    expect(v.synthesisPreview({ synthesis: huge })).toBe("");
  });
});

describe("harness self-check", () => {
  test("swarmView was registered and is instantiable", () => {
    expect(typeof captureSwarmView()).toBe("function");
  });
});
