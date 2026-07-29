import { createClient } from '@supabase/supabase-js';

// 서버 전용 (service_role) — API 라우트에서만
export function supabaseService() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!url || !key) throw new Error('SUPABASE env missing');
  return createClient(url, key, { auth: { persistSession: false } });
}

// 클라이언트(브라우저) — anon. weekly_menus SELECT 용
export function supabaseAnon() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createClient(url, key);
}

// ── 타입 정의 ──────────────────────────────────────────────────

export type MenuType = '한우' | '닭' | '기타단백질';
export type StageType = '중기1단계' | '중기2단계' | '후기' | '완료기';
export type OrderStatus = '접수' | '준비중' | '배송완료' | '취소';
export type OrderType = '일반' | '정기' | '선결제';

export type OrderItem = { menu: MenuType; qty: number };
export type RegularSlot = { day: '월' | '화' | '수' | '목' | '금'; qty: number };

export type Order = {
  id: string;
  created_at: string;
  baby_name: string;
  months: number;
  customer_phone: string;
  address: string;
  address_detail: string | null;
  door_password: string | null;
  stage: StageType;
  volume: 230 | 240 | 300 | 310;
  items: OrderItem[];
  total_qty: number;
  total_price: number;
  delivery_date: string;
  order_type: OrderType;
  status: OrderStatus;
  memo: string | null;
  customer_id: string | null;
  allergies?: string[];
  postal_code?: string | null;
  zone_group?: string | null;
  delivery_method?: string | null;
};

export type Customer = {
  id: string;
  created_at: string;
  baby_name: string;
  phone: string;
  prepaid_balance: number;
  is_regular: boolean;
  regular_schedule: RegularSlot[];
  memo: string | null;
};

export type WeeklyMenu = {
  id: string;
  created_at: string;
  week_start: string;
  menu_type: MenuType;
  vegetables: string;
};

// ── 비즈니스 상수 ─────────────────────────────────────────────

export const STAGES: StageType[] = ['중기1단계', '중기2단계', '후기', '완료기'];
export const MENU_TYPES: MenuType[] = ['한우', '닭', '기타단백질'];

// 단계 → 용량 옵션 + 가격
export const STAGE_OPTIONS: Record<StageType, { volume: number; price: number }[]> = {
  '중기1단계': [
    { volume: 240, price: 5000 },
    { volume: 310, price: 6000 }
  ],
  '중기2단계': [
    { volume: 230, price: 5000 },
    { volume: 300, price: 6000 }
  ],
  후기: [
    { volume: 230, price: 5000 },
    { volume: 300, price: 6000 }
  ],
  완료기: [
    { volume: 230, price: 5500 },
    { volume: 300, price: 6500 }
  ]
};

// ── 지역별 가격 tier ──────────────────────────────────────────
// '직배송'(강서·양천 자체배송) = 기본가 / '기타'(두발히어로 당일·택배) = 이유식 +500원, 반찬 38,000원
export type PriceTier = '직배송' | '기타';
export const PACK_SURCHARGE = 500; // 이유식 단품 팩당 인상액 (기타 지역)

// deliveryKind → tier 매핑 (클라이언트/서버 공용 · 정책 변경 시 여기만 수정)
export function tierOf(deliveryKind: string | null | undefined): PriceTier {
  return deliveryKind === '직배송' ? '직배송' : '기타';
}

// 기본값 '직배송'(기본가) — tier 누락 시 과다청구 방지
export function getPrice(stage: StageType, volume: number, tier: PriceTier = '직배송'): number {
  const base = STAGE_OPTIONS[stage].find(o => o.volume === volume)?.price ?? 0;
  if (base === 0) return 0;
  return base + (tier === '기타' ? PACK_SURCHARGE : 0);
}

export const MIN_ORDER_QTY = 3;

// 반찬5개+국1개 세트 — tier별 별도 금액 (이유식 +500과 무관한 별도 상수)
export const BANCHAN_PRICE_BY_TIER: Record<PriceTier, number> = { '직배송': 35000, '기타': 38000 };
export function getBanchanPrice(tier: PriceTier = '직배송'): number {
  return BANCHAN_PRICE_BY_TIER[tier];
}

// 조리 요일 (일요일=0 ... 토요일=6)
// 월=1, 화=2, 목=4, 금=5 (수=3 제외)
export const COOKING_DAYS = [1, 2, 4, 5] as const;
export const COOKING_DAY_KOR: Record<number, string> = { 1: '월', 2: '화', 4: '목', 5: '금' };

// 선결제 단위
export const PREPAID_UNITS = [20, 30, 50] as const;
