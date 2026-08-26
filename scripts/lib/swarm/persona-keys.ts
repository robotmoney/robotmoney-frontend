// Committed identities for the standing smoke's named personas.
//
// THE PROBLEM THESE SOLVE. A persona's signing key used to be generated fresh
// inside a per-boot Docker volume (`<project>_member_home_<id>`), and a
// real-onboarded persona's rmpc passphrase lived only in the smoke process's
// memory. Both are per-boot: the volume name carries the compose project hash,
// and the passphrase is a crypto.randomUUID() that is never written down. So
// against a PERSISTENT database — the whole point of `--external-pg` — an
// already-onboarded persona could be listed on the roster and could never sign
// again. The smoke's two visible symptoms were a roster that grew a duplicate
// Helios per restart, and sessions that ran with three members while the roster
// claimed six.
//
// The fix is to stop treating a smoke persona's identity as ephemeral. Each named
// persona has ONE keypair, committed in ./fixtures/persona-keys.json, and any
// boot can adopt it: the harness re-registers the known public key against the
// member id the database already has (registerMember is idempotent by id — it
// rebinds the key and mints a fresh token), and the member container signs with
// the matching private key.
//
// THESE ARE NOT SECRETS, and the fixture file says so at length. They are smoke
// characters; anyone with the repository can sign as them. Nothing outside the
// smoke/eval paths may use this module.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PersonaIdentity {
  /** Raw Ed25519 public key, base64 — the form /api/swarm/register takes. */
  publicKeyB64: string;
  /** Private key as a JWK, seeded into the member container's client keystore. */
  privateJwk: Record<string, unknown>;
}

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "persona-keys.json");

let cache: Record<string, PersonaIdentity> | undefined;

/** Every committed persona identity, keyed by lower-cased persona name. */
export function personaIdentities(): Record<string, PersonaIdentity> {
  if (cache) return cache;
  const raw = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
  const out: Record<string, PersonaIdentity> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_")) continue; // the file's own README block
    const entry = v as PersonaIdentity;
    if (!entry?.publicKeyB64 || !entry?.privateJwk) {
      throw new Error(`persona-keys.json: entry "${k}" is missing publicKeyB64 or privateJwk`);
    }
    out[k.toLowerCase()] = entry;
  }
  cache = out;
  return out;
}

/**
 * The committed identity for a persona, by NAME (the stable handle — a member's
 * id is minted by the server for anyone admitted through onboarding, so it
 * cannot be the key here). Returns undefined for anyone not in the fixture,
 * which callers must treat as "generate as before" rather than as an error:
 * a stack may legitimately carry members this smoke never invented.
 */
export function personaIdentity(name: string): PersonaIdentity | undefined {
  return personaIdentities()[name.trim().toLowerCase()];
}

/**
 * The exact env pair a member container needs to adopt a committed identity.
 * Kept here (rather than spelled out at each call site) so the variable names
 * cannot drift between the harness that sets them and the client that reads them.
 */
export function personaIdentityEnv(name: string): Record<string, string> | undefined {
  const id = personaIdentity(name);
  return id ? { RM_MEMBER_IDENTITY: JSON.stringify(id) } : undefined;
}
