// Pure, dependency-free memo templating for the demo committee member. Kept in
// its own module (no MCP SDK import) so the deterministic 3-section memo builder
// is unit-testable without the transport dependencies agent.ts pulls in.

// ── Deterministic, reference-shaped memo templating (NO LLM) ─────────────────
// The demo committee member writes a full 3-section memo that mirrors the shape
// of the committed archive fixtures (frontend/public/data/committee/sessions/*):
// **REGIME** / **ALLOCATION** / **SUBJECT** headers, `- ` bullets, ~900–1400
// chars, wording varied by the member's `lens` so members read distinctly. It
// weaves in whatever panel percentiles / regime labels the get_regime response
// carried, falling back to composite-derived values when a panel is absent. When
// real inference is wired this whole function is the seam that gets replaced.

// Panel/percentile inputs the memo can weave in. All optional — the builder
// degrades gracefully to composite-derived approximations when a field is absent.
export interface RegimeContext {
  composite: number;
  compositePercentile?: number | null;
  regime?: string | null;
  macroRegime?: string | null;
  onchainRegime?: string | null;
  factorRegime?: string | null;
  macroPercentile?: number | null;
  onchainPercentile?: number | null;
  factorPercentile?: number | null;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// English ordinal for a 0..1 fraction as a percentile ("0.56" → "56th").
function pctOrd(fraction: number): string {
  const n = Math.round(clamp01(fraction) * 100);
  const s = n % 100;
  const suffix = s >= 11 && s <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}

function regimeLabel(regime?: string | null, composite = 0.5): string {
  if (regime) return regime.replace(/_/g, "-");
  return composite >= 0.55 ? "risk-on" : composite >= 0.45 ? "neutral" : "risk-off";
}

// Map an arbitrary lens string onto one of a fixed set of voice profiles so the
// three sections read distinctly per member. New lenses fall back to "default".
export function lensKey(lens: string): "macro" | "onchain" | "momentum" | "contrarian" | "liquidity" | "default" {
  const l = (lens ?? "").toLowerCase();
  if (l.includes("macro")) return "macro";
  if (l.includes("chain") || l.includes("flow")) return "onchain";
  if (l.includes("moment") || l.includes("trend")) return "momentum";
  if (l.includes("contrar")) return "contrarian";
  if (l.includes("liquid")) return "liquidity";
  return "default";
}

interface LensVoice {
  regime: (c: { comp: string; pctOrd: string; label: string }) => string;
  allocation: string;
  trigger: string;
  subject: (subjectId: string) => string;
  firstMove: string;
}

const LENS_VOICES: Record<ReturnType<typeof lensKey>, LensVoice> = {
  macro: {
    regime: (c) => `Macro lens: composite ${c.comp} at the ${c.pctOrd} percentile reads ${c.label}, but the rate/liquidity backdrop is doing the heavy lifting — I discount the label and weight the panel that leads forward returns.`,
    allocation: "Inside the 5% Agent Tokens sleeve I want the receipt layer funded before any peaq-correlated name — concentration inside a bucket is the risk, not the bucket.",
    trigger: "a composite print below 0.40 forces a re-rate to 100% Conservative; nothing above 0.90 is in frame to license the opposite",
    subject: (s) => `${s} carries most of its book on a single revenue stream — that is a macro-fragility, not a diversified position.`,
    firstMove: "route the next stable tranche into rmUSDC to clear the 5% Agent Tokens floor before any structural trim",
  },
  onchain: {
    regime: (c) => `On-chain lens: composite ${c.comp} (${c.pctOrd} percentile) prints ${c.label}, yet the on-chain panel is the one dissenting hardest — flows, not price, set my conviction.`,
    allocation: "The on-chain panel is downstream of agents earning and deploying; funding the Agent Tokens sleeve is funding the very signal the compositor waits on.",
    trigger: "on-chain panel above the 50th percentile for five consecutive sessions licenses a tilt-up off the 95/5/0/0 base",
    subject: (s) => `${s} wallet activity is the tell — I read the on-chain footprint before I read the thesis deck.`,
    firstMove: "clear the 5% Agent Tokens floor via rmUSDC this tranche; the on-chain receipt IS the exposure",
  },
  momentum: {
    regime: (c) => `Momentum lens: composite ${c.comp} at the ${c.pctOrd} percentile is ${c.label}, but the slope matters more than the level — I trade the derivative of the composite, not its snapshot.`,
    allocation: "I hold the 95/5/0/0 mandate but tilt the 5% sleeve toward whatever panel has positive slope; today that discipline keeps the receipt layer first.",
    trigger: "five sessions of a rising on-chain panel, or a composite reclaiming 0.60, would license leaning into the Agent Tokens sleeve",
    subject: (s) => `${s} trend is what I underwrite — a decaying engagement curve settles the position faster than any valuation debate.`,
    firstMove: "top up rmUSDC to the 5% floor now while the mandate is unambiguous, then let the slope decide the next add",
  },
  contrarian: {
    regime: (c) => `Contrarian lens: the room reads composite ${c.comp} (${c.pctOrd} percentile) as ${c.label}; I ask what is priced in and lean against the consensus panel, not with it.`,
    allocation: "When every panel agrees I trim risk; the 82-point spread here is exactly the disagreement I want, so I hold 95/5/0/0 rather than chase.",
    trigger: "a composite extreme — below 0.33 or above 0.80 — is where I flip; the mushy middle keeps me at the mandate",
    subject: (s) => `${s} is a crowded thesis inside the committee — I keep the position honest by pricing the bear case first.`,
    firstMove: "fund the neglected Agent Tokens sleeve to 5% precisely because it is the least-loved allocation in the room",
  },
  liquidity: {
    regime: (c) => `Liquidity lens: composite ${c.comp} at the ${c.pctOrd} percentile is ${c.label}, but I underwrite exit depth — a favourable composite on thin books is a trap I refuse to fund.`,
    allocation: "The 5% Agent Tokens sleeve routes through rmUSDC because vault receipts are the redeemable, liquid leg of the mandate — that is where sizing is safe.",
    trigger: "a two-standard-deviation widening in stable-pair depth, or composite below 0.40, pulls me to 100% Conservative",
    subject: (s) => `${s} concentration only matters if I can't get out — I size the position to the book I can actually clear.`,
    firstMove: "move the stable tranche into rmUSDC to clear the 5% floor with the most redeemable instrument available",
  },
  default: {
    regime: (c) => `Composite ${c.comp} sits at the ${c.pctOrd} percentile, classified ${c.label} — I read it as nominal risk-on, effective neutral until the panels realign.`,
    allocation: "The mandate is 95/5/0/0 across Conservative DeFi Yield / Agent Tokens / Protocol / RWA and the protocol holds it; the receipt layer fills the 5% sleeve first.",
    trigger: "on-chain above the 50th for five sessions licenses a tilt; a composite below 0.40 forces 100% Conservative",
    subject: (s) => `${s} is contested on concentration versus conviction — the position stays pending the vault floor.`,
    firstMove: "route the next stable tranche into rmUSDC to clear the 5% Agent Tokens floor before any trim",
  },
};

// Build the full 3-section memo body. Deterministic given its inputs.
export function buildMemo(o: {
  name: string; lens: string; subjectId: string; stance: string; confidence: number;
}, regime: RegimeContext, provenanceText = ""): string {
  const comp = regime.composite;
  const compStr = comp.toFixed(3);
  const compPct = pctOrd(regime.compositePercentile ?? clamp01(comp));
  const label = regimeLabel(regime.regime, comp);
  const macroPct = pctOrd(regime.macroPercentile ?? clamp01(comp + 0.08));
  const onchainPct = pctOrd(regime.onchainPercentile ?? clamp01(comp - 0.2));
  const factorPct = pctOrd(regime.factorPercentile ?? clamp01(comp + 0.15));
  const voice = LENS_VOICES[lensKey(o.lens)];

  // Panel spread note — the divergence between the strongest and weakest panel is
  // the load-bearing observation across the reference memos.
  const macroLbl = regimeLabel(regime.macroRegime, comp);
  const onchainLbl = regimeLabel(regime.onchainRegime, comp);
  const factorLbl = regimeLabel(regime.factorRegime, comp);

  const regimeSection = [
    "**REGIME**",
    `- ${voice.regime({ comp: compStr, pctOrd: compPct, label })}`,
    `- Three-panel read: macro ${macroPct} (${macroLbl}), on-chain ${onchainPct} (${onchainLbl}), factor ${factorPct} (${factorLbl}) — the spread, not the composite, is where the signal lives.`,
    `- Trajectory reads ${label} by label; I treat the divergence as a reason to hold the mandate, not to tilt off it.`,
  ].join("\n");

  const allocationSection = [
    "**ALLOCATION**",
    `- Targets stay 95/5/0/0 across Conservative DeFi Yield / Agent Tokens / Protocol Tokens / Real-World Assets — composite at the ${compPct} does not authorize deviation.`,
    `- ${voice.allocation}`,
    `- Flip trigger: ${voice.trigger}.`,
  ].join("\n");

  const subjectSection = [
    "**SUBJECT**",
    `- ${o.subjectId} through a ${o.lens} lens: ${o.stance} at ${o.confidence.toFixed(2)} confidence.`,
    `- ${voice.subject(o.subjectId)}`,
    `- First move: ${voice.firstMove}.${provenanceText}`,
  ].join("\n");

  return [regimeSection, allocationSection, subjectSection].join("\n\n");
}
