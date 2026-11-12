-- 선결제 장부 (2026-11-13)
--
-- 사장님: "기록은 쌓여야 되고 선결제도 전부 잘 정리되어 있어야 돼, 오류 없이"
--
-- 전에는 baby_food_customers.prepaid_balance 숫자 하나뿐이었다. 언제 몇 팩 충전하고
-- 어느 주문에 몇 팩 썼는지 아무 데도 안 남아서, 숫자가 틀어지면 되짚을 길이 없었다.
-- 잔액이 바뀔 때마다 여기 한 줄씩 남긴다. 줄은 지우거나 고치지 않는다(쌓기만 한다).
--
--   kind     충전 · 사용 · 환불 · 수정 · 기초
--   packs    + 늘어남 / − 줄어듦
--   balance_after  그 줄이 반영된 뒤의 잔액 — 마지막 줄이 고객 표의 잔액과 같아야 한다
create table if not exists public.baby_food_prepaid_ledger (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  customer_id   uuid references public.baby_food_customers(id) on delete set null,
  phone         text,
  baby_name     text,
  kind          text not null check (kind in ('충전','사용','환불','수정','기초')),
  packs         integer not null,
  balance_after integer not null,
  amount_won    integer,
  order_id      uuid,
  memo          text
);
create index if not exists baby_food_prepaid_ledger_customer_idx on public.baby_food_prepaid_ledger (customer_id, created_at);
create index if not exists baby_food_prepaid_ledger_order_idx on public.baby_food_prepaid_ledger (order_id);

-- 서버(service_role)만 읽고 쓴다. 정책이 없으면 anon 은 아무것도 못 본다.
alter table public.baby_food_prepaid_ledger enable row level security;

-- 지금 잔액이 있는 손님은 '기초' 한 줄로 시작점을 남긴다 (한 번만)
insert into public.baby_food_prepaid_ledger (customer_id, phone, baby_name, kind, packs, balance_after, memo)
select c.id, c.phone, c.baby_name, '기초', c.prepaid_balance, c.prepaid_balance, '장부를 만들 때 남아 있던 잔액'
from public.baby_food_customers c
where c.prepaid_balance <> 0
  and not exists (select 1 from public.baby_food_prepaid_ledger l where l.customer_id = c.id);
