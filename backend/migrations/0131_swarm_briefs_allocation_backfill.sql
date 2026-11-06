-- compat: additive
-- metadata_version: 1
--
-- Fill swarm_briefs.allocation for the briefs written before 0130 (issue
-- 1584).
--
-- WHY A FILE OF ITS OWN. Each migration file runs in one transaction. 0130's
-- ADD COLUMN takes ACCESS EXCLUSIVE on swarm_briefs, which blocks every read
-- of the table until the transaction commits. Filling the rows means reading
-- every body (~240 KB each on production), so done in 0130 it would block the
-- sessions pages for as long as that read takes. Here it holds only ROW
-- EXCLUSIVE: reads never wait on it, and a write waits only when it updates a
-- brief this statement is updating. Measured on a copy of stage-2's
-- swarm_briefs (431 rows, 88 MB): 0.38 s.
--
-- WHAT IT WRITES. allocation = body -> 'allocation', the value 0130's trigger
-- would have stored had it existed when the row was written (the trigger
-- fires on this UPDATE too and sets the same value). The body is unchanged, so
-- its TOAST is not copied.
--
-- ADDITIVE AND IDEMPOTENT. Only the new column changes, and only where it
-- differs from the body, so a second run updates no row.
SET LOCAL lock_timeout = '2s';

UPDATE swarm_briefs
   SET allocation = body -> 'allocation'
 WHERE allocation IS DISTINCT FROM body -> 'allocation';
