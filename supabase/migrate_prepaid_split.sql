-- 여러 단계 선결제 (2026-11-14 사장님: "후기230 이랑 완료기230 두 개 해두고 같이 주문하는 아이들도 있어")
-- [{ "kind": "중기·후기 230g", "balance": 12 }, { "kind": "완료기 230g", "balance": 20 }]
-- 비어 있으면(null) 예전처럼 한 묶음 — prepaid_balance + prepaid_label.
-- 있으면 prepaid_balance = 묶음 잔액의 합 (목록·정렬·마이너스 찾기가 그대로 돈다). 규칙은 lib/prepaidSplit.ts
alter table public.baby_food_customers add column if not exists prepaid_split jsonb;
