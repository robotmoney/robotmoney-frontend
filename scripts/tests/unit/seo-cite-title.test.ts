// A swarm text that cites a page by its path reads as the page's own name
// (seo.js citeTitle), from the same table that titles the page's tab. The
// aggregator's rationale cited "/blog/regime-conservative-aggressive"; the
// reader saw the raw path, and the blog post's own tab read "Regime
// Conservative Aggressive" because blog posts fell back to a slug-made title.
import { test, expect } from "bun:test";
import { citeTitle, metaFor } from "../../../frontend/public/assets/js/app/seo.js";

test("a blog post cites, and titles its tab, by its own name", () => {
  // The name is the post's h1 cut to fit a 60-character title (RM-134); the
  // full h1 rides in the post's structured data as its headline.
  expect(citeTitle("/blog/regime-conservative-aggressive")).toBe("Conservative vs aggressive regime signals");
  expect(metaFor("/blog/regime-conservative-aggressive").title).toBe("Conservative vs aggressive regime signals | Robot Money");
});

test("a legacy path cites as the page it renders", () => {
  expect(citeTitle("/articles/treasury-allocation")).toBe("Treasury Allocation for On-Chain Businesses");
});

test("a page cites by the name before its qualifier", () => {
  expect(citeTitle("/smart-contract-risks")).toBe("Smart Contract Risks");
  expect(citeTitle("/regime-detection")).toBe("Regime Detection");
  // A swarm brief's research links read these two (session-brief.js).
  expect(citeTitle("/research/channel-divergence")).toBe("Channel Divergence");
  expect(citeTitle("/research/late-cycle-signals")).toBe("Late-Cycle Signals");
});

test("a title qualified after a pipe cites by its name too", () => {
  expect(citeTitle("/deposit")).toBe("Deposit USDC with Your Agent");
  expect(citeTitle("/skills")).toBe("Agent Skills");
  expect(citeTitle("/allocation")).toBe("Allocation: Target Sleeves and Vaults");
});

test("a path the site has no page for cites as nothing, so the text keeps it", () => {
  expect(citeTitle("/not/a/page/on/this/site")).toBe("");
});
