-- 선결제에 단계·용량 표시 + 반찬 선결제(회) (2026-11-13)
--
-- 사장님: "선결제가 있는경우는 … 중기인지 후기인지 완료기인지봐서 용량과 단계를 표기해줘야해"
--         "반찬 4회기준 선결제 하면 130000원으로 할인되"
--
-- 이유식 선결제는 팩으로 세고(prepaid_balance), 어떤 단계·용량으로 산 것인지 prepaid_label 에 적는다.
-- 반찬 선결제는 팩이 아니라 '회'(세트 한 번)로 세므로 칸을 따로 둔다 — 한 칸에 섞으면 팩과 회가 더해진다.
alter table public.baby_food_customers add column if not exists prepaid_label text;
alter table public.baby_food_customers add column if not exists prepaid_banchan integer not null default 0;

-- 장부 한 줄이 이유식(팩)인지 반찬(회)인지
alter table public.baby_food_prepaid_ledger add column if not exists item text not null default '이유식';
