-- ────────────────────────────────────────────────────────────────
-- 이유식 주문 시스템 — Supabase 스키마 v2
-- 같은 프로젝트(ymghmfkqctckxxysxkvy)의 silk PDF orders 충돌 방지: baby_ 접두어
-- ────────────────────────────────────────────────────────────────

-- ── 1. 고객 (선결제·정기배송) — orders가 FK 참조하므로 먼저 생성 ──
CREATE TABLE IF NOT EXISTS baby_food_customers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  baby_name        text NOT NULL,
  phone            text NOT NULL UNIQUE,
  prepaid_balance  int  NOT NULL DEFAULT 0 CHECK (prepaid_balance >= 0),
  is_regular       boolean NOT NULL DEFAULT false,
  regular_schedule jsonb NOT NULL DEFAULT '[]',  -- [{day:'월',qty:3}, ...]
  memo             text
);

-- ── 2. 주문 ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS baby_food_orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  baby_name        text NOT NULL,
  months           int  NOT NULL CHECK (months > 0),
  customer_phone   text NOT NULL,
  address          text NOT NULL,
  address_detail   text,
  door_password    text,
  stage            text NOT NULL CHECK (stage IN ('중기1단계','중기2단계','후기','완료기')),
  volume           int  NOT NULL CHECK (volume IN (230,240,300,310)),
  items            jsonb NOT NULL DEFAULT '[]',  -- [{menu:'한우',qty:2}, ...]
  total_qty        int  NOT NULL CHECK (total_qty >= 3),
  total_price      int  NOT NULL CHECK (total_price > 0),
  delivery_date    date NOT NULL,
  order_type       text NOT NULL DEFAULT '일반' CHECK (order_type IN ('일반','정기','선결제')),
  status           text NOT NULL DEFAULT '접수' CHECK (status IN ('접수','준비중','배송완료','취소')),
  memo             text,
  customer_id      uuid REFERENCES baby_food_customers(id) ON DELETE SET NULL
);

-- ── 3. 주차별 메뉴 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS baby_food_weekly_menus (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  week_start  date NOT NULL,  -- 해당 주 월요일
  menu_type   text NOT NULL CHECK (menu_type IN ('한우','닭','기타단백질')),
  vegetables  text NOT NULL DEFAULT '',  -- '당근, 시금치, 브로콜리'
  UNIQUE (week_start, menu_type)
);

-- ── 인덱스 ──────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_bfo_delivery_date  ON baby_food_orders(delivery_date);
CREATE INDEX IF NOT EXISTS idx_bfo_status         ON baby_food_orders(status);
CREATE INDEX IF NOT EXISTS idx_bfo_created_at     ON baby_food_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bfc_phone          ON baby_food_customers(phone);
CREATE INDEX IF NOT EXISTS idx_bfwm_week_start    ON baby_food_weekly_menus(week_start DESC);

-- ── RLS ─────────────────────────────────────────────────────────
ALTER TABLE baby_food_orders       ENABLE ROW LEVEL SECURITY;
ALTER TABLE baby_food_customers    ENABLE ROW LEVEL SECURITY;
ALTER TABLE baby_food_weekly_menus ENABLE ROW LEVEL SECURITY;

-- weekly_menus: 고객 주문폼이 이번 주 메뉴를 anon으로 읽어야 함
CREATE POLICY "anon read menus"
  ON baby_food_weekly_menus FOR SELECT TO anon USING (true);

-- orders·customers: anon 정책 없음 → 서버 라우트(service_role)만 접근
