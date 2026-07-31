-- ────────────────────────────────────────────────────────────────
-- 성장 기능: 후기 + 추천인 트래킹
-- ────────────────────────────────────────────────────────────────

-- 추천인 전화번호 기록 (첫 주문에만 적용, 감사·통계용)
ALTER TABLE baby_food_orders
  ADD COLUMN IF NOT EXISTS referred_by_phone text;

-- 이 주문으로 적립된 포인트(3%+웰컴/추천보너스) — 주문 취소 시 정확히 회수하기 위해 저장
ALTER TABLE baby_food_orders
  ADD COLUMN IF NOT EXISTS points_earned int NOT NULL DEFAULT 0;

-- 후기
CREATE TABLE IF NOT EXISTS baby_food_reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  customer_phone text NOT NULL,
  baby_name    text NOT NULL,
  rating       int  NOT NULL CHECK (rating BETWEEN 1 AND 5),
  content      text NOT NULL,
  is_approved  boolean NOT NULL DEFAULT true,
  points_awarded boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_bfr_created_at ON baby_food_reviews(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bfr_phone      ON baby_food_reviews(customer_phone);

ALTER TABLE baby_food_reviews ENABLE ROW LEVEL SECURITY;
-- 공개 후기 목록: 승인된 것만 anon이 읽을 수 있음 (전화번호는 응답 필드에서 SELECT 시 API 라우트가 제외)
CREATE POLICY "anon read approved reviews"
  ON baby_food_reviews FOR SELECT TO anon USING (is_approved = true);
-- 작성·조회 외 나머지(등록·수정)는 서버 라우트(service_role)만 접근
