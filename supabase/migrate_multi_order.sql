-- 복합 주문 지원을 위한 제약 완화
-- Supabase 대시보드 SQL Editor 에서 실행

ALTER TABLE baby_food_orders DROP CONSTRAINT IF EXISTS baby_food_orders_stage_check;
ALTER TABLE baby_food_orders DROP CONSTRAINT IF EXISTS baby_food_orders_volume_check;
ALTER TABLE baby_food_orders DROP CONSTRAINT IF EXISTS baby_food_orders_total_qty_check;

-- stage/volume 을 nullable 허용 (복합 주문 시 'mixed' 또는 NULL)
ALTER TABLE baby_food_orders ALTER COLUMN stage DROP NOT NULL;
ALTER TABLE baby_food_orders ALTER COLUMN volume DROP NOT NULL;

-- total_qty 는 0 초과만 허용 (날짜별 최소 3팩은 API에서 검증)
ALTER TABLE baby_food_orders ADD CONSTRAINT baby_food_orders_total_qty_check CHECK (total_qty > 0);
