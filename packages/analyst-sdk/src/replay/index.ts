// The replay module (issue 1765, phase 1): one row builder, one comparison and
// one replay of a published run over an opened archive. Pure.
export { publishedRows, type PublishedRowsOptions } from "./rows.ts";
export {
  COMPARED_FIELDS, LABEL_FIELDS, MISSING_ROW, projectRow, compareRows, labelMismatches,
  type ComparedField, type ComparedRow, type RowComparison,
} from "./compare.ts";
export { DISCRETE_TOL, numericDiff, type Difference, type NumericDiff } from "./numeric-diff.ts";
export {
  replayRun, publicationCandidates, historyOfInputs, UnknownRunError,
  type ReplayOptions, type ReplayResult, type ReplayedRun, type ReplayKept, type PublishedRunCandidate,
} from "./replay.ts";
