-- 반찬 정기배송 손님 (2026-11-14 사장님: "1회 주문은 왼쪽이고 정기배송은 오른쪽 위, 그 아래는 오픈월드, 뒷장은 메뉴변경 아가들")
-- 엑셀 '수반찬 주문내역' 주문 시트의 V~X '정기배송' 명단을 옮긴 표시. 조리표·입금 표·이름표가 이걸로 반찬을 나눈다(lib/cookingSheet).
alter table public.baby_food_customers add column if not exists banchan_regular boolean not null default false;
