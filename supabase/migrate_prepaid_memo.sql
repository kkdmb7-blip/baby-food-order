-- 카톡 메모장 선결제 정리를 붙여넣어 저장 (2026-11-13)
--
-- 사장님 메모장 예:  9/7 17-3-6-6-6=-4   ← 먼저 가져가고 다음 입금에서 메운다
-- 잔여가 마이너스인 것이 실제로 있다(받을 팩). 0 아래를 막아 두면 메모장 그대로 옮길 수 없다.
-- 손님 주문 쪽은 /api/orders 가 '잔여 < 주문 팩' 이면 막으므로 손님이 스스로 마이너스를 만들지는 못한다.
alter table public.baby_food_customers drop constraint if exists baby_food_customers_prepaid_balance_check;

alter table public.baby_food_customers add column if not exists prepaid_memo text;          -- 붙여넣은 메모 원문(마지막 것)
alter table public.baby_food_customers add column if not exists prepaid_memo_at timestamptz;
alter table public.baby_food_customers add column if not exists prepaid_tracks jsonb;      -- 묶음별 [{label, balance, charged, used}]
