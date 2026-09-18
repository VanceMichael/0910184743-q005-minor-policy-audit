-- 未成年人策略判定服务：初始结构
-- 设计要点：
--   1. account_events 为事件事实流，event_id 全局幂等，(tenant,account,source_seq) 单调唯一。
--   2. account_projection 为每个账号唯一的“当前投影”，revision 只进不退。
--   3. content_decisions / appeal_outcomes 为不可变审计：快照当时年龄段、监护关系、
--      策略版本与签名 key_id；触发器拒绝任何 UPDATE/DELETE（密钥轮换不影响历史行）。

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 签名密钥：每个租户多把 key，轮换后旧 key 置 retired 仍可用于验签（历史决定展示原 key_id）
CREATE TABLE IF NOT EXISTS signing_keys (
  tenant_id  TEXT NOT NULL,
  key_id     TEXT NOT NULL,
  secret     TEXT NOT NULL,
  roles      JSONB NOT NULL DEFAULT '["guardian","reviewer","auditor"]'::jsonb,
  subject    TEXT,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, key_id)
);

-- 事实事件流（只追加）
CREATE TABLE IF NOT EXISTS account_events (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  account_id     TEXT NOT NULL,
  event_id       TEXT NOT NULL,
  source_seq     BIGINT NOT NULL CHECK (source_seq > 0),
  event_kind     TEXT NOT NULL CHECK (event_kind IN ('age_evidence', 'guardian_authorization', 'content_risk', 'appeal')),
  payload        JSONB NOT NULL,
  signing_key_id TEXT NOT NULL,
  -- 受理结果（落库时即固定）：乱序迟到事件 applied=false 但事实保留、可查询
  applied        BOOLEAN NOT NULL DEFAULT FALSE,
  note           TEXT,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 幂等：同一事件全局只落一次；同一账号序号不得被两个事件占用
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_events_event_id_key') THEN
    ALTER TABLE account_events ADD CONSTRAINT account_events_event_id_key UNIQUE (event_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_events_seq_key') THEN
    ALTER TABLE account_events ADD CONSTRAINT account_events_seq_key
      UNIQUE (tenant_id, account_id, source_seq);
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS account_events_timeline_idx
  ON account_events (tenant_id, account_id, source_seq);

-- 每个账号唯一的当前投影（revision = 已应用的最大 source_seq，只增不减）
CREATE TABLE IF NOT EXISTS account_projection (
  tenant_id               TEXT NOT NULL,
  account_id              TEXT NOT NULL,
  revision                BIGINT NOT NULL DEFAULT 0,
  age_band                TEXT CHECK (age_band IS NULL OR age_band IN ('under_13', '13_to_15', '16_to_17')),
  age_known               BOOLEAN NOT NULL DEFAULT FALSE,
  age_band_seq            BIGINT,
  guardian_state          JSONB NOT NULL DEFAULT '{"guardians":{}}'::jsonb,
  latest_content_event_id TEXT,
  latest_decision         TEXT CHECK (latest_decision IS NULL OR latest_decision IN ('allow', 'limit', 'block', 'review')),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id)
);

-- 不可变决定审计：每次内容动作一行，快照“当时”使用的全部判定输入
CREATE TABLE IF NOT EXISTS content_decisions (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  account_id         TEXT NOT NULL,
  content_event_id   TEXT NOT NULL,
  source_seq         BIGINT NOT NULL,
  decision           TEXT NOT NULL CHECK (decision IN ('allow', 'limit', 'block', 'review')),
  policy_version     TEXT NOT NULL,
  age_band           TEXT,
  age_band_known     BOOLEAN NOT NULL,
  guardian_snapshot  JSONB NOT NULL,
  risk_snapshot      JSONB NOT NULL,
  rationale          TEXT NOT NULL,
  signing_key_id     TEXT NOT NULL,
  applied            BOOLEAN NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_decisions_event_key UNIQUE (content_event_id),
  CONSTRAINT content_decisions_seq_key UNIQUE (tenant_id, account_id, source_seq)
);

CREATE INDEX IF NOT EXISTS content_decisions_account_idx
  ON content_decisions (tenant_id, account_id, source_seq);

-- 申诉结果：必须引用其实际推翻/维持的那条决定
CREATE TABLE IF NOT EXISTS appeal_outcomes (
  id                     BIGSERIAL PRIMARY KEY,
  tenant_id              TEXT NOT NULL,
  account_id             TEXT NOT NULL,
  appeal_event_id        TEXT NOT NULL,
  source_seq             BIGINT NOT NULL,
  target_decision_id     BIGINT NOT NULL REFERENCES content_decisions(id),
  target_content_event_id TEXT NOT NULL,
  result                 TEXT NOT NULL CHECK (result IN ('overturned', 'maintained')),
  original_decision      TEXT NOT NULL CHECK (original_decision IN ('allow', 'limit', 'block', 'review')),
  reviewed_decision      TEXT NOT NULL CHECK (reviewed_decision IN ('allow', 'limit', 'block', 'review')),
  policy_version         TEXT NOT NULL,
  reason                 TEXT NOT NULL,
  signing_key_id         TEXT NOT NULL,
  applied                BOOLEAN NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT appeal_outcomes_event_key UNIQUE (appeal_event_id),
  CONSTRAINT appeal_outcomes_seq_key UNIQUE (tenant_id, account_id, source_seq)
);

CREATE INDEX IF NOT EXISTS appeal_outcomes_target_idx
  ON appeal_outcomes (tenant_id, account_id, target_decision_id, source_seq);

-- 事件与其在同一事务内产生的决定/申诉互相挂接（前向表在上方已建好，此处补外键）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'account_events'::regclass AND attname = 'decision_id') THEN
    ALTER TABLE account_events ADD COLUMN decision_id BIGINT REFERENCES content_decisions(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'account_events'::regclass AND attname = 'appeal_id') THEN
    ALTER TABLE account_events ADD COLUMN appeal_id BIGINT REFERENCES appeal_outcomes(id);
  END IF;
END$$;

-- 投影 revision 只进不退，由应用在同一事务内加行级咨询锁后更新；
-- 再加一道数据库防线：禁止 revision 下降。
CREATE OR REPLACE FUNCTION projection_monotonic() RETURNS trigger AS $fn$
BEGIN
  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'projection revision cannot go backwards: % -> %', OLD.revision, NEW.revision
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'projection_monotonic') THEN
    CREATE TRIGGER projection_monotonic BEFORE UPDATE ON account_projection
      FOR EACH ROW EXECUTE FUNCTION projection_monotonic();
  END IF;
END$$;

-- 不可变审计保护：事实事件、决定、申诉一律拒绝更新与删除
CREATE OR REPLACE FUNCTION policy_reject_mutation() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'immutable table % may not be %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation';
END;
$fn$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'account_events_immutable') THEN
    CREATE TRIGGER account_events_immutable BEFORE UPDATE OR DELETE ON account_events
      FOR EACH ROW EXECUTE FUNCTION policy_reject_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'content_decisions_immutable') THEN
    CREATE TRIGGER content_decisions_immutable BEFORE UPDATE OR DELETE ON content_decisions
      FOR EACH ROW EXECUTE FUNCTION policy_reject_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'appeal_outcomes_immutable') THEN
    CREATE TRIGGER appeal_outcomes_immutable BEFORE UPDATE OR DELETE ON appeal_outcomes
      FOR EACH ROW EXECUTE FUNCTION policy_reject_mutation();
  END IF;
END$$;

INSERT INTO schema_migrations(version) VALUES ('001_initial')
  ON CONFLICT (version) DO NOTHING;
