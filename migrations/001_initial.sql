CREATE TABLE IF NOT EXISTS account_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  source_seq BIGINT NOT NULL,
  event_kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, account_id, source_seq)
);

CREATE TABLE IF NOT EXISTS account_projection (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  decision TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, account_id)
);
