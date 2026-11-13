-- 2026-11-13 입금 대조
--   은행 입금내역을 한 줄씩 남기고(지우지 않는다), 어느 주문 돈인지 짝을 지어 둔다.
--   자동으로 짝지은 것도 사장님이 다시 볼 수 있게 상태·근거를 같이 남긴다.

create table if not exists public.baby_food_deposits (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  deposited_at  timestamptz not null,
  depositor     text not null,          -- 통장에 찍힌 보낸 분 그대로
  amount        integer not null,
  balance_after bigint,                 -- 같은 입금을 두 번 올려도 한 줄만 남게 하는 데 쓴다
  bank_memo     text,                   -- 적요 · 처리점
  source        text,                   -- 올린 파일 이름
  status        text not null default '모름'
                check (status in ('자동확인','수동확인','확인필요','모름','선결제','무관')),
  order_ids     uuid[] not null default '{}',   -- 이 입금으로 입금확인한 주문
  suggested_ids uuid[] not null default '{}',   -- 아마 이 주문 같다(확정 전)
  customer_phone text,
  note          text,                   -- 왜 그렇게 봤는지
  confirmed_at  timestamptz,
  unique (deposited_at, depositor, amount, balance_after)
);
create index if not exists baby_food_deposits_at on public.baby_food_deposits (deposited_at desc);
create index if not exists baby_food_deposits_status on public.baby_food_deposits (status);
alter table public.baby_food_deposits enable row level security;

-- 주문: 입금 근거 한 줄 + 어디서 들어온 주문인지
alter table public.baby_food_orders
  add column if not exists paid_note text,
  add column if not exists source text;

-- 손님: 입금자 이름(엄마·아빠 이름 등). 아기 이름 대신 부모 이름으로 보내는 분이 많다.
alter table public.baby_food_customers
  add column if not exists payer_names text[] not null default '{}';
