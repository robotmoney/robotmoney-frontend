/**
 * Prompt boundary for the contribution-governance reviewer planned in issue
 * #197. The trusted judgment rules come from CONTRIBUTING.md, especially
 * "Where changes go (and who can add files)"; this module only marks a PR's
 * unified diff as untrusted data.
 *
 * Every diff line is quoted before it is placed between the boundary markers.
 * A patch can therefore contain these marker strings, Markdown fences, or
 * model instructions without creating an unquoted boundary line. The future
 * OpenCode adapter must pass this wrapper's output unchanged to its prompt and
 * must not interpolate raw diff text elsewhere.
 *
 * This is deliberately only a seam: it does not invoke OpenCode, choose PRs,
 * or post findings. Those runtime behaviors remain in issue #197.
 */

export const UNTRUSTED_DIFF_BEGIN = "<<<ROBOTMONEY_UNTRUSTED_DIFF_BEGIN>>>";
export const UNTRUSTED_DIFF_END = "<<<ROBOTMONEY_UNTRUSTED_DIFF_END>>>";
export const UNTRUSTED_DIFF_LINE_PREFIX = "| ";

export interface DelimitedContributionDiff {
  /** The complete prompt-safe block. Never append the raw diff separately. */
  block: string;
  /** Number of quoted unified-diff lines in `block`. */
  lineCount: number;
}

/**
 * Quote a unified diff inside an unambiguous, line-oriented prompt boundary.
 * CRLF and bare CR are normalized so every source line receives the prefix.
 */
export function delimitContributionDiff(diff: string): DelimitedContributionDiff {
  const normalized = diff.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.split("\n");
  const quoted = lines.map((line) => `${UNTRUSTED_DIFF_LINE_PREFIX}${line}`);

  return {
    block: [
      UNTRUSTED_DIFF_BEGIN,
      ...quoted,
      UNTRUSTED_DIFF_END,
    ].join("\n"),
    lineCount: lines.length,
  };
}
