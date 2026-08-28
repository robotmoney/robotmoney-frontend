// Who runs an agent, named the same way on every surface.
//
// `operator` is free text each member and each portfolio sets for itself, so the
// API serves several spellings of one outfit: "robotmoney" on some rows, "RM
// Protocol Labs" on others. Rendered verbatim, the swarm index put a slug and a
// company name in the same column — both marked house — reading as two
// different operators, and a member profile showed the slug where the index
// showed the name.
//
// This lived inside alpine/views/swarm.js, so only that page got it right.
// The records want the same normalization; that is an admin write, not this
// file's job.

export const HOUSE_OPERATOR = "RM Protocol Labs";

const HOUSE_ALIASES = new Set([
  "robotmoney",
  "robot money",
  "rm protocol labs",
  "rm protocol",
]);

export function isHouseOperator(op) {
  return HOUSE_ALIASES.has(String(op || "").trim().toLowerCase());
}

/** The display name, or null when nothing is set — callers omit rather than invent. */
export function operatorName(op) {
  const s = String(op || "").trim();
  if (!s) return null;
  return isHouseOperator(s) ? HOUSE_OPERATOR : s;
}
