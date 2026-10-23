// The input manifest and the provenance envelope (issue 1404; analyst SDK
// requirements sections 4 and 6). Pure: the command line reads the input file
// and its sidecar, hashes the bytes and hands both here. The computation never
// reads a manifest: provenance travels beside the report, never into it.
//
// The sidecar of `<name>.csv` (or `.json`) is `<name>.manifest.json`, so the
// generated `inputs.csv` gets `inputs.manifest.json`. It records where the
// input came from: the backup id of the local copy, the run key, the run's
// as-of date, the acquisition source of that backup (`api` or `db`), the row
// count and SHA-256 of the input file, the run's methodology and the exact code
// revision (build identity) the run recorded.
//
// The envelope is opt-in (`--provenance`). The default output stays the bare
// report, byte for byte. With a valid sidecar the envelope is
// `{pinned: true, manifest, report}`; with none it is `{pinned: false, report}`.
// A sidecar that does not match its input is an error, never `pinned: false`.

export const MANIFEST_FORMAT = 1;

export interface InputManifest {
  format: 1;
  // Basename of the input file this sidecar describes.
  input: string;
  // Format 1 backup id (`YYYY-MM-DDTHHMMSSZ`) the input was generated from.
  backup_id: string;
  run_key: string;
  asof: string;
  // Acquisition source of that backup: the public API or the database replica.
  source: "api" | "db";
  row_count: number;
  sha256: string;
  methodology: { id: string; label: string | null; config_digest: string | null };
  // The build identity the run recorded: the exact code revision.
  code_revision: string;
}

export class ManifestError extends Error {
  override readonly name = "ManifestError";
}

const BACKUP_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{6}Z$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const KEYS = ["format", "input", "backup_id", "run_key", "asof", "source", "row_count", "sha256", "methodology", "code_revision"];

function isDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
}

// The sidecar path for an input path: its extension replaced by `.manifest.json`.
export function manifestPathFor(inputPath: string): string {
  const slash = Math.max(inputPath.lastIndexOf("/"), inputPath.lastIndexOf("\\"));
  const dot = inputPath.lastIndexOf(".");
  const stem = dot > slash + 1 ? inputPath.slice(0, dot) : inputPath;
  return `${stem}.manifest.json`;
}

// Check a sidecar's shape and that it describes exactly this input: its name,
// its SHA-256 and its row count. Throws ManifestError naming the first problem.
export function validateManifest(
  text: string,
  input: { name: string; sha256: string; rows: number },
): InputManifest {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(text);
  } catch (e) {
    throw new ManifestError(`manifest is not JSON: ${(e as Error).message}`);
  }
  if (m === null || typeof m !== "object" || Array.isArray(m)) throw new ManifestError("manifest must be a JSON object");
  const got = Object.keys(m);
  const missing = KEYS.filter((k) => !(k in m));
  const extra = got.filter((k) => !KEYS.includes(k));
  if (missing.length || extra.length) throw new ManifestError(`manifest keys: missing [${missing.join(", ")}], unknown [${extra.join(", ")}]`);
  if (m.format !== MANIFEST_FORMAT) throw new ManifestError(`manifest format must be ${MANIFEST_FORMAT}, got ${JSON.stringify(m.format)}`);
  if (typeof m.backup_id !== "string" || !BACKUP_ID_RE.test(m.backup_id)) throw new ManifestError(`backup_id must be a format 1 backup id (YYYY-MM-DDTHHMMSSZ), got ${JSON.stringify(m.backup_id)}`);
  if (typeof m.run_key !== "string" || m.run_key === "") throw new ManifestError("run_key must be a non-empty string");
  if (!isDate(m.asof)) throw new ManifestError(`asof must be a real YYYY-MM-DD date, got ${JSON.stringify(m.asof)}`);
  if (m.source !== "api" && m.source !== "db") throw new ManifestError(`source must be "api" or "db", got ${JSON.stringify(m.source)}`);
  if (typeof m.code_revision !== "string" || m.code_revision === "") throw new ManifestError("code_revision must be a non-empty string");
  const meth = m.methodology as Record<string, unknown> | null;
  if (
    meth === null || typeof meth !== "object" || typeof meth.id !== "string" || meth.id === "" ||
    !(meth.label === null || typeof meth.label === "string") ||
    !(meth.config_digest === null || (typeof meth.config_digest === "string" && SHA256_RE.test(meth.config_digest))) ||
    Object.keys(meth).length !== 3
  ) {
    throw new ManifestError("methodology must be {id, label, config_digest} (id a non-empty string, label a string or null, config_digest a sha256 or null)");
  }
  if (typeof m.sha256 !== "string" || !SHA256_RE.test(m.sha256)) throw new ManifestError("sha256 must be 64 lowercase hex characters");
  if (typeof m.row_count !== "number" || !Number.isInteger(m.row_count) || m.row_count < 0) throw new ManifestError("row_count must be a nonnegative integer");
  if (m.input !== input.name) throw new ManifestError(`manifest describes ${JSON.stringify(m.input)}, not ${JSON.stringify(input.name)}`);
  if (m.sha256 !== input.sha256) throw new ManifestError(`input sha256 ${input.sha256} does not match the manifest's ${m.sha256}`);
  if (m.row_count !== input.rows) throw new ManifestError(`input has ${input.rows} rows, the manifest says ${m.row_count}`);
  return m as unknown as InputManifest;
}

// The manifest as written by the input generator: fixed key order, two-space
// JSON, trailing newline.
export function serializeManifest(m: InputManifest): string {
  const ordered: InputManifest = {
    format: 1,
    input: m.input,
    backup_id: m.backup_id,
    run_key: m.run_key,
    asof: m.asof,
    source: m.source,
    row_count: m.row_count,
    sha256: m.sha256,
    methodology: { id: m.methodology.id, label: m.methodology.label, config_digest: m.methodology.config_digest },
    code_revision: m.code_revision,
  };
  return JSON.stringify(ordered, null, 2) + "\n";
}

export type ProvenanceEnvelope<R> =
  | { pinned: true; manifest: InputManifest; report: R }
  | { pinned: false; report: R };

// Wrap a report, unchanged, with its provenance.
export function provenanceEnvelope<R>(report: R, manifest: InputManifest | null): ProvenanceEnvelope<R> {
  return manifest ? { pinned: true, manifest, report } : { pinned: false, report };
}
