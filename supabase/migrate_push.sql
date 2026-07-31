-- ────────────────────────────────────────────────────────────────
-- 웹푸시 구독 (배송상태 변경 시 손님 폰에 알림)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS baby_food_push_subscriptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  customer_phone text NOT NULL,
  endpoint       text NOT NULL UNIQUE,
  p256dh         text NOT NULL,
  auth           text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bfps_phone ON baby_food_push_subscriptions(customer_phone);

ALTER TABLE baby_food_push_subscriptions ENABLE ROW LEVEL SECURITY;
-- anon 정책 없음 → 서버 라우트(service_role)만 접근
