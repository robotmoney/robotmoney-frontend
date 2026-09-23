// The API automation-token store (issue #1026 W4.5).
//
// Governed by docs/technical/smoke-production-spec.md §3 and
// docs/technical/system-scheduler-spec.md §7. Migration 0069 is the table; this
// module is the only thing that writes it and the only thing that reads it.
//
// WHY PROVISIONING LIVES HERE AND NOT IN A SCRIPT. The secret is generated,
// hashed and stored in one place, so no caller ever holds a path by which the
// plaintext reaches the database. `provisionAutomationToken` returns the secret
// exactly once, to whoever asked for it, and the row it wrote cannot reproduce
// it. The delivery half — writing that secret into the instance's state
// directory as a file — is the boot's (smoke spec §3/§5/§9.1), W1's criterion,
// and deliberately not this module's business.
import { randomBytes } from "node:crypto";
import { sql } from "./client.ts";
import { hashKey } from "../lib/keys.ts";

/**
 * The three rights the spec names, and no others.
 *
 * `system-scheduler` holds all three: "an automation token with the rights to
 * read subjects and sessions and to perform lifecycle transitions" (scheduler
 * spec §7). Migration 0069's CHECK holds the same list, so a value that gets
 * past this module is still refused by the database.
 */
export const AUTOMATION_RIGHTS = ["read_subjects", "read_sessions", "lifecycle_transitions"] as const;
export type AutomationRight = (typeof AUTOMATION_RIGHTS)[number];

export interface AutomationGrant {
  instance: string;
  rights: AutomationRight[];
}

/** The token's wire prefix, so an operator reading a file knows what it is holding. */
const TOKEN_PREFIX = "rmat_";

/**
 * Provision (or rotate) one instance's automation token.
 *
 * Rotation and first issue are the same statement on purpose: smoke spec §3
 * says "Rotation is a re-provision and a container restart", and an UPSERT is
 * what makes that true without a second code path that could drift. The old
 * hash is overwritten, so the old token stops validating the moment this
 * commits — there is no grace window, because a grace window is a second valid
 * credential nobody is tracking.
 *
 * Returns the secret ONCE. It is not stored and cannot be recovered.
 */
export async function provisionAutomationToken(
  instance: string,
  rights: readonly AutomationRight[],
): Promise<{ instance: string; token: string; rights: AutomationRight[] }> {
  if (rights.length === 0) {
    throw new Error("provisionAutomationToken: a token with no rights authorizes nothing — name at least one");
  }
  for (const right of rights) {
    if (!(AUTOMATION_RIGHTS as readonly string[]).includes(right)) {
      throw new Error(
        `provisionAutomationToken: unknown right "${right}" — expected ${AUTOMATION_RIGHTS.join(" | ")}`,
      );
    }
  }
  const unique = [...new Set(rights)];
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  await sql`
    INSERT INTO automation_tokens (instance, token_hash, rights)
    VALUES (${instance}, ${hashKey(token)}, ${unique})
    ON CONFLICT (instance) DO UPDATE
      SET token_hash = EXCLUDED.token_hash,
          rights = EXCLUDED.rights,
          created_at = now(),
          created_by = CURRENT_USER`;
  return { instance, token, rights: unique };
}

/**
 * Validate a presented secret against the store.
 *
 * The lookup is BY HASH, which is both the only thing stored and a constant
 * -width equality on a unique index — there is no row to compare against until
 * the hash matches, so there is nothing for a timing comparison to leak beyond
 * "some row exists", which the index answers in constant time anyway.
 *
 * Returns null for an unknown token. That is the whole of "a file on disk
 * establishes nothing by itself": the file is a string, and a string that
 * matches no row is refused exactly like a forged one.
 */
export async function lookupAutomationToken(presented: string | null): Promise<AutomationGrant | null> {
  if (!presented) return null;
  const [row] = await sql<{ instance: string; rights: AutomationRight[] }[]>`
    SELECT instance, rights FROM automation_tokens WHERE token_hash = ${hashKey(presented)}`;
  return row ? { instance: row.instance, rights: row.rights } : null;
}
