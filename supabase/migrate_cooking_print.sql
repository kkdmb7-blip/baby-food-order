-- 조리표를 언제 뽑았는지 적어두는 표
--
-- 왜 필요한가
--   사장님은 오전 7시에 조리표를 프린트하신다. 그 뒤에 들어오는 주문은 종이에 손으로
--   적으신다. 앱이 "언제 뽑았는지" 를 모르면 어느 줄이 프린트 뒤에 들어온 것인지
--   구분할 수 없고, 그러면 추가분만 다시 뽑아드릴 수가 없다.
--
-- 왜 브라우저가 아니라 DB 인가
--   프린트는 가게 PC에서 하시고 확인은 폰으로도 하신다. 브라우저에 적어두면
--   기기가 바뀌거나 기록을 지우면 "뽑은 적 없음" 으로 조용히 돌아간다.
--
-- 날짜 하나에 한 줄. 다시 뽑으면 그 시각으로 덮어쓴다 — 기준은 항상 마지막 전체 프린트다.
CREATE TABLE IF NOT EXISTS baby_food_cooking_prints (
  delivery_date   date         PRIMARY KEY,
  printed_at      timestamptz  NOT NULL DEFAULT now(),
  -- 그때 몇 명 / 몇 팩이었는지. 나중에 "7시엔 24명이었는데 지금 27명" 처럼 보여주려고 남긴다.
  printed_orders  int          NOT NULL DEFAULT 0,
  printed_packs   int          NOT NULL DEFAULT 0
);

-- 관리자(서비스 롤)만 쓴다. 정책을 만들지 않으므로 anon 키로는 읽지도 쓰지도 못한다.
ALTER TABLE baby_food_cooking_prints ENABLE ROW LEVEL SECURITY;
