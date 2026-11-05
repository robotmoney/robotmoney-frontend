// Q34b-archive-records/C22a-archive-records, carried into v0.7.3 (added: v0.7.3): the same check
// as v0.7.1's, which guards the archive 503 failure that broke v0.7.0's cutover (issue 1508).
// It is not a template step yet, so each release that wants it adds it. Logic and docs:
// ../v0.7.1/archive-records.ts.
export * from "../v0.7.1/archive-records.ts";
