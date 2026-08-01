-- ────────────────────────────────────────────────────────────────
-- 마케팅 개선: 유입경로 추적 + 리퍼럴 링크화
-- ────────────────────────────────────────────────────────────────

-- 유입경로 (첫 주문에만 기록, 통계용) — 예: "insta", "danggeun", "momcafe"
ALTER TABLE baby_food_orders
  ADD COLUMN IF NOT EXISTS acquisition_source text;

-- 리퍼럴 링크용 코드 — 전화번호를 텍스트에 그대로 노출하지 않기 위함
ALTER TABLE baby_food_customers
  ADD COLUMN IF NOT EXISTS referral_code text UNIQUE;
