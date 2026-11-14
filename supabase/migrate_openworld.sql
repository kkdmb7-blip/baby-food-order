-- 오픈월드(나라 후원사업) 아이들 — 손님이 돈을 보내지 않고 나중에 한꺼번에 정산받는다.
-- 엑셀 시절엔 월·목 이유식 표 아래쪽에 따로 떨어뜨려 적었다. 입금 대조에서 빼야 한다.
-- 손님 카드에 표시해 두면 새 주문에 자동으로 '오픈월드' 가 붙는다 (orders.paid_note).
alter table baby_food_customers add column if not exists openworld boolean not null default false;
