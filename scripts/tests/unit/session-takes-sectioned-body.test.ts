// The site renders the takes the participant one-shot now writes (issue 1116).
//
// Production takes are bold-sectioned bullet lists (REGIME, then SUBJECT or
// ALLOCATION). session-takes.js reads the SUBJECT section for each row. This
// pins that the shape author-take.ts publishes (participant-author-take.test.ts
// pins the shape itself) is still the shape the site parses.
import { describe, expect, test } from "bun:test";
import { sessionTakes } from "../../../frontend/public/assets/js/app/lib/session-takes.js";

describe("session-takes.js on a production-shaped take", () => {
  test("a row carries the first claim of the SUBJECT section", () => {
    const body = "**REGIME**\n- composite 0.41, neutral\n\n**SUBJECT**\n- Woon is long beta into a cautious tape.\n- Concentration risk.";
    expect(sessionTakes().takeLine({ stance: "cautious", body })).toBe("Woon is long beta into a cautious tape.");
  });

  test("a take with no SUBJECT section falls back to its first section", () => {
    const body = "**REGIME**\n- composite 0.41, neutral\n\n**ALLOCATION**\n- Tilt to yield.";
    expect(sessionTakes().takeLine({ stance: "cautious", body })).toBe("composite 0.41, neutral");
  });
});
