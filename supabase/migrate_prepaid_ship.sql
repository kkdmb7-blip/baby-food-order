-- 택배비 선결제 (2026-11-14 사장님: "택배로 선결제한 아이들은 택배비 차감도 있어. 보통 30000원 10회, 5팩까지는 1회 차감")
-- null = 택배비 선결제를 안 하는 손님(차감 안 함). 숫자면(0·마이너스 포함) 택배 주문이 선결제로 빠질 때 회수도 같이 뺀다.
-- 규칙은 lib/prepaidShip.ts
alter table public.baby_food_customers add column if not exists prepaid_ship integer;
