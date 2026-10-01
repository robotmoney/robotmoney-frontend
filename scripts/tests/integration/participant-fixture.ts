// A participant roster and its RENDERED compose overlay, for the integration
// tests that assert over real participant services (smoke-compose-config,
// no-docker-socket-compose-config, no-db-credential-outside-api-compose-config,
// no-model-key-outside-participants).
//
// The roster is shaped exactly like a `credential.json` (spec §6.1, D52): each
// entry a real Ed25519 identity, its own member id, its own bearer and its own
// model key, all distinct. The overlay is written by the SAME renderer the
// boot's `participants` phase uses (scripts/lib/participant-compose.ts), into
// a temporary directory outside the checkout, so every assertion reads the
// services a boot would actually start.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialEntry, CredentialFile, RosterEntry } from "../../lib/swarm/credential-file.ts";
import { renderParticipantServices, writeParticipantFiles, type RenderedParticipants } from "../../lib/participant-compose.ts";
import { ZEN_API_BASE_URL } from "../../lib/opencode-key.ts";

export const repoRoot = join(import.meta.dir, "..", "..", "..");

/** One credential-file entry with a fresh identity and secrets nobody else holds. */
export function credentialEntry(name: string): CredentialEntry {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" }) as { x?: string };
  const tag = randomBytes(6).toString("hex");
  return {
    memberId: `m-${name}-${tag}`,
    publicKeyB64: Buffer.from(publicJwk.x ?? "", "base64url").toString("base64"),
    privateJwk: privateKey.export({ format: "jwk" }) as Record<string, unknown>,
    bearer: `tok_m-${name}-${tag}_${randomBytes(12).toString("hex")}`,
    modelKey: `sk-model-${name}-${randomBytes(12).toString("hex")}`,
  };
}

/** A credential file with the named agents and judges. */
export function credentialFile(agents: readonly string[], judges: readonly string[]): CredentialFile {
  return {
    agents: Object.fromEntries(agents.map((n) => [n, credentialEntry(n)])),
    judges: Object.fromEntries(judges.map((n) => [n, credentialEntry(n)])),
  };
}

/** The roster entries of a file, agents then judges, each namespace in name order. */
export function entriesOf(file: CredentialFile): RosterEntry[] {
  return [
    ...Object.keys(file.agents).sort().map((name) => ({ name, kind: "agent" as const, credential: file.agents[name]! })),
    ...Object.keys(file.judges).sort().map((name) => ({ name, kind: "judge" as const, credential: file.judges[name]! })),
  ];
}

/** Every secret one entry holds, as the strings that must never reach another container. */
export function secretsOf(entry: CredentialEntry): string[] {
  return [entry.bearer, entry.modelKey, String(entry.privateJwk.d ?? ""), JSON.stringify(entry.privateJwk)].filter((s) => s.length > 8);
}

export interface WrittenOverlay {
  readonly overlay: string;
  readonly envDir: string;
  readonly rendered: RenderedParticipants;
}

/**
 * Render `entries` as the boot does and write the overlay and env files — to
 * `dir` when given (a boot writes to the same instance directory every time,
 * which is what lets compose keep an unchanged container), else a fresh temp
 * directory.
 */
export function writeParticipantOverlay(
  entries: readonly RosterEntry[],
  instance = "rm_it_participants",
  dir: string = mkdtempSync(join(tmpdir(), "rm-participants-")),
  /** The image the services run; a render-only test never pulls it. */
  image = "rm-it-participant:render-only",
): WrittenOverlay {
  const envDir = join(dir, "participants");
  const overlay = join(dir, "participants.json");
  const rendered = renderParticipantServices(entries, {
    instance,
    envDir,
    apiUrl: "http://api:8787",
    rmEnv: "stage",
    inference: { wireId: "deepseek-v4-flash", baseUrl: ZEN_API_BASE_URL },
    image,
  });
  writeParticipantFiles(rendered, envDir, overlay);
  return { overlay, envDir, rendered };
}
