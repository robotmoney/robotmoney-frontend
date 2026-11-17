-- compat: additive
-- metadata_version: 1
-- Preserve orphaned blocks and logs so reorg recovery requires no runtime DELETE.
CREATE TABLE IF NOT EXISTS flow_index_blocks (
  chain_id bigint NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  block_time timestamptz NOT NULL,
  canonical boolean NOT NULL DEFAULT true,
  PRIMARY KEY (chain_id, block_number, block_hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS flow_index_blocks_canonical
  ON flow_index_blocks (chain_id, block_number) WHERE canonical;

CREATE TABLE IF NOT EXISTS flow_index_logs (
  chain_id bigint NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  log_index integer NOT NULL,
  transaction_hash text NOT NULL,
  address text NOT NULL,
  topics jsonb NOT NULL,
  data text NOT NULL,
  PRIMARY KEY (chain_id, block_hash, log_index),
  FOREIGN KEY (chain_id, block_number, block_hash)
    REFERENCES flow_index_blocks (chain_id, block_number, block_hash)
);
GRANT SELECT, INSERT, UPDATE ON flow_index_blocks TO rm_app;
GRANT SELECT, INSERT ON flow_index_logs TO rm_app;
