// scripts/release/host-tools.ts — the host's own tools against what the release
// needs (issue 1528). PURE: node built-ins and local modules only, since
// ./host-identity.ts runs it before `bun install`.
//
// Bun reads a bun.lock only when it is new enough for the file's
// `lockfileVersion`. The v0.7.0 production preflight failed P03-install
// because the host's Bun 1.3.14 could not read a lockfileVersion 2 file
// (`error: Unknown lockfile version`). host-identity.ts calls
// hostToolProblems in every identity step (Q07-host-identity,
// Q10-capture-identity, P02-host-identity, P05-capture-identity), each before
// its install step, so a host with too old a Bun fails before any install.

/** The oldest Bun that reads each bun.lock `lockfileVersion`. */
export const MIN_BUN_FOR_LOCKFILE: Readonly<Record<number, string>> = Object.freeze({
  // The 1.3 line production installed v0.6.x with.
  1: "1.3.0",
  // Bun 1.3.14 refused it (`Unknown lockfile version`); oven/bun:1.4.4 in backend/Dockerfile reads it.
  2: "1.4.0",
});

/** PURE. The top-level `lockfileVersion` of a bun.lock text (JSONC with trailing commas, so a regex; it is the file's first key), or undefined. */
export function lockfileVersionOf(text: string): number | undefined {
  const m = /"lockfileVersion"\s*:\s*(\d+)/.exec(text);
  return m ? Number(m[1]) : undefined;
}

/** PURE. major.minor.patch as numbers; missing parts are 0. Undefined when the text holds no version. */
function parseVersion(v: string): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}

/** PURE. Numeric comparison of major.minor.patch: negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a) ?? [0, 0, 0];
  const y = parseVersion(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

export interface Lockfile { path: string; text: string | undefined }

/** PURE. The highest Bun minimum any present lockfile needs, and the lockfile that sets it. */
export function bunRequirement(lockfiles: readonly Lockfile[]): { minimum: string | null; from: string | null } {
  let minimum: string | null = null;
  let from: string | null = null;
  for (const { path, text } of lockfiles) {
    if (text === undefined) continue;
    const version = lockfileVersionOf(text);
    const min = version === undefined ? undefined : MIN_BUN_FOR_LOCKFILE[version];
    if (min !== undefined && (minimum === null || compareVersions(min, minimum) > 0)) { minimum = min; from = path; }
  }
  return { minimum, from };
}

/**
 * PURE. Why this host's Bun cannot install the checkout; empty when it can.
 * `lockfiles` holds every path of lockfile.ts lockfilePaths(), with `text`
 * undefined for a file the checkout lacks (skipped).
 */
export function hostToolProblems(input: { bunVersion: string; lockfiles: readonly Lockfile[] }): string[] {
  const have = input.bunVersion.trim();
  const problems: string[] = [];
  for (const { path, text } of input.lockfiles) {
    if (text === undefined) continue;
    const version = lockfileVersionOf(text);
    const min = version === undefined ? undefined : MIN_BUN_FOR_LOCKFILE[version];
    if (min === undefined) {
      problems.push(`${path} has lockfileVersion ${version ?? "(unreadable)"}, which has no known minimum bun: add its minimum bun to MIN_BUN_FOR_LOCKFILE`);
    } else if (parseVersion(have) === undefined || compareVersions(have, min) < 0) {
      problems.push(`bun ${have || "(unknown)"} cannot read ${path} (lockfileVersion ${version} needs bun >= ${min}); upgrade bun for this user on this host before the install step`);
    }
  }
  return problems;
}
