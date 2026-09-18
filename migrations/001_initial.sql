-- 001_initial.sql — 未成年人策略判定服务初始模式
--
-- 设计要点：
--   * account_events   不可变事件日志，(tenant_id, event_id) 幂等键，
--                      (tenant_id, account_id, source_seq) 单调序号唯一约束。
--   * account_projection 每个账号恰好一行“当前投影”，摄入事务内 SELECT ... FOR UPDATE
--                      串行化并发；last_applied_seq 只增不回退。
--   * decisions        不可变审计决定，按账号哈希链（prev_hash/decision_hash），
--                      key_id 记录决定当时使用的签名密钥，轮换后历史行不变。
--   * appeals          申诉记录，target_decision_id 指向被推翻或维持的决定，
--                      resolution_decision_id 指向解决决定。
--   * auth_keys        每租户可轮换 HMAC 密钥，任一时刻仅一个 active。
--   * policies         每租户单调递增的策略版本。

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id  TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_keys (
  tenant_id  TEXT NOT NULL REFERENCES tenants (tenant_id),
  key_id     TEXT NOT NULL,
  secret     TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  CONSTRAINT pk_auth_keys PRIMARY KEY (tenant_id, key_id)
);

-- 每个租户至多一个 active 密钥（轮换时同事务内退旧换新）
CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_keys_one_active
  ON auth_keys (tenant_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS policies (
  tenant_id  TEXT NOT NULL REFERENCES tenants (tenant_id),
  version    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  rules      JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_policies PRIMARY KEY (tenant_id, version),
  CONSTRAINT ck_policies_version_positive CHECK (version >= 1)
);

CREATE TABLE IF NOT EXISTS account_events (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants (tenant_id),
  account_id   TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  source_seq   BIGINT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('age_evidence', 'guardianship', 'content_risk', 'appeal')),
  payload      JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  occurred_at  TIMESTAMPTZ,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- applied = 已并入当前投影；stale = 迟到的旧序号事件，仅记录可查询，不回退状态
  status       TEXT NOT NULL CHECK (status IN ('applied', 'stale')),
  CONSTRAINT uq_events_event_id UNIQUE (tenant_id, event_id),
  CONSTRAINT uq_events_source_seq UNIQUE (tenant_id, account_id, source_seq),
  CONSTRAINT ck_events_source_seq_positive CHECK (source_seq >= 1)
);

CREATE INDEX IF NOT EXISTS idx_events_account
  ON account_events (tenant_id, account_id, source_seq);

CREATE TABLE IF NOT EXISTS decisions (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  event_id            TEXT NOT NULL,
  source_seq          BIGINT NOT NULL,
  decision_seq        BIGINT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('age_evidence', 'guardianship', 'content_risk', 'appeal', 'appeal_resolution')),
  outcome             TEXT NOT NULL,
  applied             BOOLEAN NOT NULL,
  age_band            TEXT,
  guardianship_status TEXT,
  policy_version      INTEGER NOT NULL,
  risk_level          TEXT,
  reason_code         TEXT NOT NULL,
  key_id              TEXT NOT NULL,
  payload_hash        TEXT NOT NULL,
  prev_hash           TEXT NOT NULL,
  decision_hash       TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL,
  CONSTRAINT uq_decisions_event_kind UNIQUE (tenant_id, event_id, kind),
  CONSTRAINT uq_decisions_account_chain UNIQUE (tenant_id, account_id, decision_seq)
);

CREATE INDEX IF NOT EXISTS idx_decisions_account
  ON decisions (tenant_id, account_id, decision_seq);

CREATE TABLE IF NOT EXISTS account_projection (
  tenant_id              TEXT NOT NULL REFERENCES tenants (tenant_id),
  account_id             TEXT NOT NULL,
  last_applied_seq       BIGINT NOT NULL DEFAULT 0,
  projection_revision    BIGINT NOT NULL DEFAULT 0,
  decision_count         BIGINT NOT NULL DEFAULT 0,
  age_band               TEXT,
  age_attestation_id     TEXT,
  guardianship_status    TEXT NOT NULL DEFAULT 'none',
  guardian_id            TEXT,
  policy_version         INTEGER NOT NULL DEFAULT 1,
  restriction_level      INTEGER NOT NULL DEFAULT 0,
  restriction_decision_id BIGINT,
  last_decision_id       BIGINT,
  last_decision_hash     TEXT NOT NULL DEFAULT 'GENESIS',
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_account_projection PRIMARY KEY (tenant_id, account_id),
  CONSTRAINT ck_projection_seq_monotonic CHECK (last_applied_seq >= 0),
  CONSTRAINT ck_projection_version_monotonic CHECK (policy_version >= 1)
);

CREATE TABLE IF NOT EXISTS appeals (
  tenant_id              TEXT NOT NULL REFERENCES tenants (tenant_id),
  appeal_id              TEXT NOT NULL,
  account_id             TEXT NOT NULL,
  event_id               TEXT NOT NULL,
  -- 被本申诉推翻或维持的原决定
  target_decision_id     BIGINT NOT NULL REFERENCES decisions (id),
  status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'overturned', 'upheld')),
  reason                 TEXT,
  opened_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at            TIMESTAMPTZ,
  -- 解决该申诉时新产生的审计决定
  resolution_decision_id BIGINT REFERENCES decisions (id),
  resolver               TEXT,
  resolution_note        TEXT,
  CONSTRAINT pk_appeals PRIMARY KEY (tenant_id, appeal_id),
  CONSTRAINT uq_appeals_event UNIQUE (tenant_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_appeals_account
  ON appeals (tenant_id, account_id);

-- 不可变审计：事件与决定一旦落库禁止更新或删除
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable_table:%', TG_TABLE_NAME USING ERRCODE = 'raise_exception';
END;
$$;

DROP TRIGGER IF EXISTS trg_events_immutable ON account_events;
CREATE TRIGGER trg_events_immutable
  BEFORE UPDATE OR DELETE ON account_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

DROP TRIGGER IF EXISTS trg_decisions_immutable ON decisions;
CREATE TRIGGER trg_decisions_immutable
  BEFORE UPDATE OR DELETE ON decisions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
