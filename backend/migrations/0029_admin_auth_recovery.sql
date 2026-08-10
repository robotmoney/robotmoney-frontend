-- Existing claimed credentials deliberately remain NULL: a migration cannot
-- manufacture a recovery code and disclose it safely. The authenticated
-- password-change route initializes a one-time recovery code for those rows.
ALTER TABLE admin_credential ADD COLUMN recovery_hash text;
