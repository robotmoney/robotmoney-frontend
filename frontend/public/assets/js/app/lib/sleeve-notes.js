// What each sleeve holds, in one line, keyed on the framework's bucket id.
// One source, so a sleeve is described the same way everywhere it appears:
// the (i) tip wherever a swarm page names a sleeve (the explorer's panel, the
// history's column heads), /allocation's sleeve cards and each vault page's
// lede. No network in it: a vault page states its network beside the note.
// Its own module because session-summary.js and vault-data.js both read
// it, and each already imports the other.
/** @type {Record<string, string>} */
export const BUCKET_NOTES = {
  conservative_defi_yield: "Lending USDC. The lowest-volatility sleeve, aimed at capital preservation.",
  agent_tokens: "Tokens of the agents that hold $ROBOTMONEY.",
  protocol_tokens: "Large-cap crypto and DeFi assets.",
  real_world_assets: "Tokenised traditional instruments: equity index and commodities.",
};
