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
// 요일마다 단계·용량이 다를 수 있다 (월 중기 300 3팩 / 목 후기 230 4팩 …).
// stage·volume 이 없는 칸은 일정 전체의 stage·volume 을 쓴다 (예전 신청은 전부 그 모양).
export type RegularSlot = {
  day: '월' | '화' | '수' | '목' | '금'; qty: number;
  stage?: StageType; volume?: number;
  menus?: { menu: string; qty: number }[];
};

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
  paid_note?: string | null;      // 입금 근거 ("입금 김예원 11/12 10:56 21,500원 (자동)") 또는 '대조안함 — …'
  source?: string | null;         // '엑셀 …' 이면 엑셀에서 옮긴 주문
  arrival_note?: string | null;   // 배송 후 사장님이 남긴 도착 메시지 (손님 앱에 보임)
  arrived_at?: string | null;
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
  prepaid_label?: string | null;  // 어떤 단계·용량으로 산 선결제인지 ('완료기 300g')
  prepaid_banchan?: number;       // 반찬 선결제 남은 회수 (이유식 팩과 따로 센다)
  payer_names?: string[];         // 보호자(입금자) 이름 — 엄마·아빠 이름으로 입금할 때 입금 대조가 이 이름으로도 찾는다
  last_order?: string | null;    // 화면용 — /api/customers?all=1 이 계산해 준 마지막 주문일(취소 빼고). DB 열 아님
  openworld?: boolean;           // 오픈월드(나라 후원사업) — 돈을 손님이 안 보내고 나중에 한꺼번에 정산 (lib/openworld)
  prepaid_tracks?: { label: string | null; balance: number; charged: number; used: number }[] | null; // 카톡 메모의 묶음별 잔여
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

/*
  ── 배송비 ────────────────────────────────────────────────────
  사장님 확인 (2026-11-12): "3팩 이상 무료배송이고 그건 직배송일 경우야"

    직배송(강서·양천 자체배송)  3팩부터 무료.
                                배송 자체가 3팩부터라(MIN_ORDER_QTY) 직배송으로
                                나가는 주문은 사실상 늘 무료다. 픽업도 이 갈래로
                                들어오는데(부르는 쪽에서 tier를 '직배송'으로 넘긴다)
                                배송을 안 나가니 역시 0원이다.

    기타(두발 당일·택배)        아래 기준.

  ⚠️ 기타 지역 무료 기준(6팩/30,000원)은 사장님이 정하신 값이 아니다.
     경쟁사(베베쿡·엘빈즈·루솔·아이배냇) 네 곳이 모두 "3만원 이상 무료 / 미달 3,000원"
     이라 거기 맞춰 둔 것이다. 간판의 무료배송은 직배송 얘기라, 기타 지역도 무료로
     둘지는 사장님 결정이 필요하다 (할일.md). 바꾸면 손님이 내는 값이 달라지므로
     여기서 임의로 건드리지 않는다.
     기타지역 팩당 +500원(PACK_SURCHARGE)은 그대로 둔다 — 그걸 빼고 배송비만 받으면
     6팩 이상 구간(단골·정기배송이 대부분 여기)에서 세트당 2,800~5,600원이 날아간다.
*/
export const SHIPPING_FEE = 3000;           // 택배·당일배송 1건 배송비
export const FREE_SHIPPING_QTY_DIRECT = 3;  // 직배송 — 간판 기준(= MIN_ORDER_QTY)
export const FREE_SHIPPING_QTY = 6;         // 기타 — 이 팩수부터 무료
export const FREE_SHIPPING_AMOUNT = 30000;  // 기타 — 또는 이 금액부터 무료

// 수량·금액 중 하나만 넘겨도 무료: 반찬세트는 1세트(=1팩)지만 38,000원이라 금액으로 걸린다.
export function shippingFeeFor(tier: PriceTier, totalQty: number, packSubtotal: number): number {
  // 직배송은 3팩부터 무료인데, 배송은 3팩부터만 받으므로 늘 0이다.
  // 픽업(1~2팩도 가능)도 여기로 들어오고 배송을 안 나가니 역시 0이다.
  if (tier === '직배송') return 0;
  if (totalQty >= FREE_SHIPPING_QTY || packSubtotal >= FREE_SHIPPING_AMOUNT) return 0;
  return SHIPPING_FEE;
}
// 무료까지 몇 팩 남았는지 (안내문에 쓰는 값). 0이면 이미 무료.
export function packsToFreeShipping(tier: PriceTier, totalQty: number, packSubtotal: number): number {
  if (shippingFeeFor(tier, totalQty, packSubtotal) === 0) return 0;
  return Math.max(1, FREE_SHIPPING_QTY - totalQty);
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

/*
  ── 반찬 단가 ────────────────────────────────────────────────
  사장님 확인 (2026-11-12):
    "반찬은 6개 이상 배송 가능하고 그 이상 추가할 때는 개당 5000원으로 가능해"
    "반찬은 세트(6개) 이상만 배송이 가능해 1-5개까지는 픽업가능하고 개당 6000원"

  정리하면 반찬은 두 가지로 팔린다.

    세트  여섯 칸(반찬 5종 + 국 1) = 35,000원(직배송) / 38,000원(기타)
          일곱째부터 개당 5,000원. 배송 가능.
    낱개  1~5개. 개당 6,000원. 픽업만.

  낱개가 개당 6,000원이라 5개면 30,000원인데 세트(6개)는 35,000원이다 —
  개당으로 보면 세트가 싸다(5,833원). 세트 쪽이 묶음 할인인 셈이라 맞는 방향이다.

  사장님 엑셀('수반찬 주문내역')에 7개를 담은 분이 있었는데, 지금까지는 세트 수로만
  값을 매겨서 그 추가분을 못 받고 있었다.
*/
export const BANCHAN_STAGE = '반찬세트';
export const BANCHAN_SINGLE_STAGE = '반찬낱개';
export const BANCHAN_SET_SIZE = 6;      // 세트 한 개에 들어가는 칸 수
export const BANCHAN_EXTRA_PRICE = 5000; // 세트를 넘는 칸 — 개당
export const BANCHAN_SINGLE_PRICE = 6000; // 낱개 — 개당 (픽업만)
export const BANCHAN_SINGLE_MAX = 5;     // 낱개는 여기까지. 6개부터는 세트다

/** 반찬 줄인가 — 세트든 낱개든 */
export function isBanchanStage(stage: any): boolean {
  return stage === BANCHAN_STAGE || stage === BANCHAN_SINGLE_STAGE;
}

/** 낱개 줄인가 (픽업만 가능한 줄) */
export function isBanchanSingle(stage: any): boolean {
  return stage === BANCHAN_SINGLE_STAGE;
}

/** 반찬 줄의 종류별 개수 합 — sets[].menus 가 [{menu, qty}] 모양이다 */
export function banchanItemCount(menus: any): number {
  if (!Array.isArray(menus)) return 0;
  return menus.reduce((a: number, m: any) => a + (Number(m?.qty) || 0), 0);
}

/**
 * 반찬 줄 하나의 값.
 *
 *   낱개  qty = 개수       → 개수 × 6,000
 *   세트  qty = 세트 수    → 세트값 × 세트수 + (종류별 합 − 6×세트수) × 5,000
 *
 * 세트에서 itemCount 가 없거나 0이면 '세트 수 × 6' 으로 본다 — 종류별 개수를 안 적던
 * 옛 주문(카톡주문·간단주문·손님 화면)에 추가금이 붙어 과다청구되는 것을 막는다.
 */
export function banchanLineTotal(
  tier: PriceTier, stage: any, qty: number, itemCount?: number | null,
): number {
  const n = Math.max(0, Math.floor(Number(qty) || 0));
  if (!n) return 0;
  if (isBanchanSingle(stage)) return n * BANCHAN_SINGLE_PRICE;
  const included = BANCHAN_SET_SIZE * n;
  const items = Number(itemCount) > 0 ? Number(itemCount) : included;
  return getBanchanPrice(tier) * n
    + Math.max(0, items - included) * BANCHAN_EXTRA_PRICE;
}

// 조리 요일 (일요일=0 ... 토요일=6)
// 월=1, 화=2, 목=4, 금=5 (수=3 제외)
export const COOKING_DAYS = [1, 2, 4, 5] as const;
// 반찬 세트는 수요일에만 만든다 (lib/dates.ts allWeekDays의 isBanchan과 같은 기준)
export const BANCHAN_DOW = 3;
export const COOKING_DAY_KOR: Record<number, string> = { 1: '월', 2: '화', 4: '목', 5: '금' };

// 선결제 단위
export const PREPAID_UNITS = [20, 30, 50] as const;

/*
  차감식 선결제 할인표 (주방 간판, 2024.11.1 · 현금만) — 2026-11-12 사진으로 읽음
  규칙은 하나다: 묶음 크기별로 팩당 깎는 값이 같다.
      20팩 −200원 · 30팩 −250원 · 50팩 −300원
  중기·후기 230g 5,000 / 300g 6,000, 완료기 230g 5,500 / 300g 6,500 에서 뺀다.
  (중기1의 240g·310g 은 230g·300g 과 같은 값)
  lib/depositMatch.ts 의 PREPAID_PRICES(입금 금액 → 묶음) 열두 칸이 이 계산과 똑같다.
*/
export const PREPAID_DISCOUNT: Record<number, number> = { 20: 200, 30: 250, 50: 300 };
export function prepaidPrice(label: string | null | undefined, units: number): number | null {
  const l = String(label || '');
  const vol = /3[01]0/.test(l) ? 300 : /2[34]0/.test(l) ? 230 : null;
  const off = PREPAID_DISCOUNT[units];
  if (!vol || off === undefined) return null;
  const base = l.includes('완료') ? (vol === 300 ? 6500 : 5500) : (vol === 300 ? 6000 : 5000);
  return (base - off) * units;
}
