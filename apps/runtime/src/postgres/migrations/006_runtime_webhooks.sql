-- Add delivery tables after the existing Run outbox migration.
CREATE TABLE runtime_webhook_subscriptions (
  space_id TEXT NOT NULL REFERENCES account_spaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  event_types TEXT[] NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, id)
);

-- Payloads are small immutable facts, independent of Run history retention.
CREATE TABLE runtime_webhook_deliveries (
  space_id TEXT NOT NULL,
  id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivering', 'delivered', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  replay_count INTEGER NOT NULL DEFAULT 0,
  available_at BIGINT NOT NULL,
  lease_token TEXT,
  lease_until BIGINT,
  last_http_status INTEGER,
  last_failure_code TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, id),
  UNIQUE (space_id, subscription_id, event_id),
  FOREIGN KEY (space_id, subscription_id)
    REFERENCES runtime_webhook_subscriptions(space_id, id) ON DELETE CASCADE
);
CREATE INDEX runtime_webhook_due ON runtime_webhook_deliveries
  (space_id, available_at, created_at) WHERE status IN ('pending', 'delivering');

CREATE TABLE runtime_webhook_replays (
  space_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, delivery_id, ordinal),
  FOREIGN KEY (space_id, delivery_id)
    REFERENCES runtime_webhook_deliveries(space_id, id) ON DELETE CASCADE
);
