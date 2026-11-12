-- 2026-11-13 배송 도착 메시지 — 사장님이 배송 후 남기는 한마디. 손님 앱 '내 주문'에 보인다.
alter table public.baby_food_orders
  add column if not exists arrival_note text,
  add column if not exists arrived_at timestamptz;
