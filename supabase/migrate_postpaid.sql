-- 후불 손님 (2026-11-14 사장님: "고우리는 특이하게 후불로 하고 있어")
-- 켜 두면 입금 안 된 주문이 빨간 미입금이 아니라 주황 '후불'로 보이고, 입금 탭 맨 위 '후불 — 받을 돈'에 모인다.
-- 돈을 받으면 [정산] 으로 그동안 주문을 한꺼번에 입금확인. app/api/admin/postpaid
alter table public.baby_food_customers add column if not exists postpaid boolean not null default false;
update public.baby_food_customers set postpaid = true where id = '1af5c54a-76cd-43f7-a281-229eb9451d49'; -- 고우리
