-- Issue #597: make the database enforce the invariant 0030 only CLAIMED.
--
-- WHAT 0030 SAID vs WHAT IT DID. 0030 ends with the comment "a handle is a
-- public URL segment: it must address exactly one member" and then installs
-- `CREATE UNIQUE INDEX swarm_members_handle_key ON swarm_members (handle)`.
-- That index constrains handle against handle. It says nothing about the OTHER
-- half of the same sentence: `id` is a public URL segment too (getMember and
-- getMemberTakes both resolve `handle = $ref OR id = $ref`, which is what keeps
-- every pre-rename link alive), so a reference is ambiguous the moment one
-- member's handle equals a DIFFERENT member's id. Nothing in the schema
-- forbade that. The only thing that did was an application probe in
-- swarm/admin.ts, reading other rows unlocked at READ COMMITTED.
--
-- WHAT IT COSTS WHEN IT HAPPENS. With A(id='a1', handle='woon') and
-- B(id='woon', handle='b1'), /swarm/members/woon renders A's identity, name and
-- lens over takes that include B's — signed content attributed to the wrong
-- signer, on a page whose whole premise is verifiable attribution.
--
-- WHAT THIS DOES. A BEFORE INSERT OR UPDATE row trigger that refuses any row
-- which would make a public reference address two members, in EITHER direction:
--
--   * this row's handle equals another member's id  (the case 0030's index misses)
--   * this row's id     equals another member's handle
--
-- Both directions are needed. With only the first, the collision is still
-- creatable by writing A(handle='woon') first and B(id='woon') second: the
-- insert of B never looks at anyone else's handle. The check is symmetric so
-- that whichever row arrives second is the one refused.
--
-- SOURCE-ONLY, LIKE 0030. No row's `id`, no child table's `member_id`, and no
-- signed payload or signature byte is read or written here. The only DDL is a
-- function and a trigger on swarm_members.
--
-- WHAT THIS IS NOT. It is not atomic against a concurrent writer. The trigger
-- body is a plain SELECT at READ COMMITTED, so two transactions can each pass
-- their check against a snapshot that does not yet contain the other's
-- uncommitted row and both commit, producing exactly the pair this forbids.
-- Closing that window needs a lock ordered over the whole namespace (an
-- advisory lock keyed on the reference, or a single unique index over a union
-- of both names, which would mean writing a second table or a generated
-- column). What this trigger buys is that the invariant no longer depends on
-- one call site in swarm/admin.ts remembering to probe: EVERY writer — a
-- migration, an operator's manual UPDATE, a restore, a future writer that names
-- `handle` explicitly — is now refused by the database. See issue #597.

-- ── Existing data ───────────────────────────────────────────────────────────
-- A trigger only inspects rows that are written after it exists, so a database
-- that ALREADY holds a colliding pair would deploy clean and then start
-- refusing unrelated edits to those rows, weeks later and far from the cause.
-- Fail here instead, loudly and with the offending pair named, so an operator
-- fixes it at deploy time. Repairing it automatically is NOT an option: the fix
-- is to change one of the two public names, and picking which one — and what to
-- change it to — silently repoints a published URL.
DO $$
DECLARE conflicts text;
BEGIN
  SELECT string_agg(
           format('member %L has handle %L, which is member %L''s id', a.id, a.handle, b.id),
           '; ' ORDER BY a.id)
    INTO conflicts
    FROM swarm_members a
    JOIN swarm_members b ON b.id = a.handle AND b.id <> a.id;
  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION
      'swarm_members already violates the handle/id namespace invariant, so migration 0031 cannot install it: %. Change one of the two public names (UPDATE swarm_members SET handle = ... ) and re-run.',
      conflicts;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION swarm_members_assert_handle_namespace() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- An UPDATE that moves neither public name cannot create a collision, and
  -- must not be refused because of one that already exists on the row (see the
  -- deploy note above): status flips, version bumps and profile edits stay
  -- writable either way.
  IF TG_OP = 'UPDATE'
     AND NEW.handle IS NOT DISTINCT FROM OLD.handle
     AND NEW.id IS NOT DISTINCT FROM OLD.id THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM swarm_members m
    WHERE m.id <> NEW.id AND (m.id = NEW.handle OR m.handle = NEW.id)
  ) THEN
    -- 23505 with a constraint name, i.e. the same shape swarm_members_handle_key
    -- raises, so swarm/domain.ts isHandleUniqueViolation recognises it and the
    -- API answers 409 "handle already taken" rather than 500. A distinct name
    -- because this is a distinct rule, and an operator reading a log should be
    -- able to tell which one refused the write.
    RAISE EXCEPTION
      'handle % / id % would address more than one swarm member', NEW.handle, NEW.id
      USING ERRCODE = '23505', CONSTRAINT = 'swarm_members_handle_namespace';
  END IF;
  RETURN NEW;
END;
$$;

-- NAME ORDER IS LOAD-BEARING. Postgres fires BEFORE row triggers in alphabetical
-- order by trigger name, and 0030's swarm_members_default_handle_trigger is the
-- one that fills in `NEW.handle := NEW.id` for the six writers that insert no
-- handle. 'swarm_members_d...' < 'swarm_members_h...', so the default runs first
-- and this check always sees the FINAL handle rather than a NULL. Asserted from
-- pg_trigger in tests/swarm-member-handle-namespace-migration.test.ts rather
-- than assumed.
DROP TRIGGER IF EXISTS swarm_members_handle_namespace_trigger ON swarm_members;
CREATE TRIGGER swarm_members_handle_namespace_trigger
BEFORE INSERT OR UPDATE ON swarm_members
FOR EACH ROW EXECUTE FUNCTION swarm_members_assert_handle_namespace();
