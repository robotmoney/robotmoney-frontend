// The D78 value-by-value comparison moved into the SDK (issue 1765): the replay
// comparison names the fields that differ beyond rounding with it
// (src/replay/numeric-diff.ts). Tests and backend scripts keep importing it here.
export { DISCRETE_TOL, numericDiff, expectSameUpToRounding, type Difference, type NumericDiff } from "../../src/replay/numeric-diff.ts";
