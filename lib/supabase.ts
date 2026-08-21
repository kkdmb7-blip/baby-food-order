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
export type OrderStatus = '접수' | '준비중' | '배송중' | '배송완료' | '취소';
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
  paid?: boolean;                  // 입금 확인 여부 (엑셀+파이썬으로 수동 대조하던 것을 앱에서)
  paid_at?: string | null;
  customer_request?: string | null; // 손님이 남긴 배송 요청 ("저녁배송" 등)
};

export type Customer = {
  id: string;
  created_at: string;
  baby_name: string;
  phone: string;
  prepaid_balance: number;
  is_regular: boolean;
  // ⚠️ 실제 저장 형태는 배열이 아니라 객체 { stage, volume, slots:[{day,qty}] } 임
  // (api/my/regular이 그렇게 씀). 타입만 RegularSlot[]로 돼 있어서 관리자 화면이
  // regular_schedule.length / .map()을 쓰다가 아무것도 표시하지 못했음.
  regular_schedule: RegularSchedule | null;
  memo: string | null;
};

export type RegularSchedule = {
  stage?: StageType;
  volume?: number;
  slots?: RegularSlot[];
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

// ⚠️ 저장 키는 '기타단백질'이지만 실제 구성은 단백질이 아님 —
// 17주치를 보면 생선(가자미·대구살·연어), 곡물(오트밀·퀴노아·찰기장), 콩(연두부·병아리콩),
// 씨앗(햄프시드·흑임자), 야채(당근·쥬키니호박), 달걀노른자, 아기치즈, 블루베리까지 섞여 있음.
// "기타단백질"도 "야채"도 정확하지 않아서 화면 표시만 '기타'로 통일한다.
// (기존 주문 데이터의 키를 바꾸면 과거 기록이 깨지므로 키는 그대로 둠)
export const MENU_LABEL: Record<MenuType, string> = {
  '한우': '한우', '닭': '닭', '기타단백질': '기타',
};
export const menuLabel = (m: string): string => (MENU_LABEL as any)[m] ?? m;

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

// ── 수령 방법 ─────────────────────────────────────────────────
// 배송은 1회 3팩부터(택배·직배송 모두 동일). 1~2팩도 주문은 받지만 픽업(방문수령)만 가능.
export const MIN_ORDER_QTY = 3;        // 배송 최소 팩수
export const MIN_PICKUP_QTY = 1;       // 픽업은 1팩부터
export type ReceiveMethod = '배송' | '픽업';

// ── 한우 비율 제한 ────────────────────────────────────────────
// 한우 원가가 비싸서 한우만 담는 주문은 받지 않는다. 사장님이 준 판정 기준:
//   한우3               → 불가      한우2+닭1           → 가능
//   한우3+기타1         → 가능      한우4+닭1           → 불가
//   한우4+닭1+기타1     → 가능
// 위 5가지가 모두 "한우 ≤ 나머지 × 3"(= 한우가 전체의 3/4 초과 금지) 하나로 맞는다.
// 배수를 바꿀 일이 생기면 이 상수만 고치면 됨.
export const HANWOO_MAX_RATIO = 3;
export function hanwooAllowed(hanwoo: number, others: number): boolean {
  if (hanwoo <= 0) return true;
  return hanwoo <= others * HANWOO_MAX_RATIO;
}
// 한우를 그대로 두고 통과하려면 나머지가 몇 팩 더 필요한지 (안내문에 쓰는 값)
export function othersNeededForHanwoo(hanwoo: number, others: number): number {
  if (hanwooAllowed(hanwoo, others)) return 0;
  return Math.ceil(hanwoo / HANWOO_MAX_RATIO) - others;
}

// 반찬5개+국1개 세트 — tier별 별도 금액 (이유식 +500과 무관한 별도 상수)
export const BANCHAN_PRICE_BY_TIER: Record<PriceTier, number> = { '직배송': 35000, '기타': 38000 };
export function getBanchanPrice(tier: PriceTier = '직배송'): number {
  return BANCHAN_PRICE_BY_TIER[tier];
}

// 조리 요일 (일요일=0 ... 토요일=6)
// 월=1, 화=2, 목=4, 금=5 (수=3 제외)
export const COOKING_DAYS = [1, 2, 4, 5] as const;
// 반찬 세트는 수요일에만 만든다 (lib/dates.ts allWeekDays의 isBanchan과 같은 기준)
export const BANCHAN_DOW = 3;
export const COOKING_DAY_KOR: Record<number, string> = { 1: '월', 2: '화', 4: '목', 5: '금' };

// 선결제 단위
export const PREPAID_UNITS = [20, 30, 50] as const;
