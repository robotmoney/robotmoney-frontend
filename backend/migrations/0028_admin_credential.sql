CREATE TABLE admin_credential (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pass_hash TEXT NOT NULL
);
