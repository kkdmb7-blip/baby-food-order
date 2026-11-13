-- 연락처 없는 손님도 고객 카드를 갖게 (2026-11-13)
--
-- 사장님: "연락처가 없는 아가들은 택배 또는 당일배송 아가들이라서 주소를 따로 관리해 … 또는 아주 가끔씩 픽업만 오는 애들도 있어"
--
-- 고객 카드는 번호로 묶어 왔다(phone NOT NULL UNIQUE). 번호가 없는 손님은 카드가 없어서
-- 선결제(석하린 310,000원)를 넣을 자리가 없었다. 번호 없이도 카드를 만들 수 있게 한다.
-- UNIQUE 는 그대로 — NULL 은 여러 개여도 겹치지 않는다. 그런 손님의 주문은 customer_id 로 잇는다.
alter table public.baby_food_customers alter column phone drop not null;
