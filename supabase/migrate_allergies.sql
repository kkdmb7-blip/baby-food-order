-- ────────────────────────────────────────────────────────────────
-- 알레르기 기능: 주문에 알레르기 정보 저장
-- baby_food_orders.allergies (jsonb 배열, 예: ["달걀(난류)","우유(유제품)"])
-- ────────────────────────────────────────────────────────────────

ALTER TABLE baby_food_orders
  ADD COLUMN IF NOT EXISTS allergies jsonb NOT NULL DEFAULT '[]';

-- (선택) 고객 테이블에도 기본 알레르기를 저장하고 싶을 때 사용
ALTER TABLE baby_food_customers
  ADD COLUMN IF NOT EXISTS allergies jsonb NOT NULL DEFAULT '[]';
