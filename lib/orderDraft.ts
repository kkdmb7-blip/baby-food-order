import {
  MENU_TYPES, getPrice, banchanLineTotal,
  type StageType, type MenuType, type PriceTier,
} from './supabase';

/*
  손님이 담는 주문 한 건의 모양과, 거기서 수량·금액을 뽑는 계산.

  왜 따로 뒀나
    app/order/page.tsx 가 3,650줄이라 고치다 엉뚱한 데를 건드리기 쉬웠다.
    이 함수들은 화면 상태(useState)를 안 쓰고 값만 다루므로, 떼어내도 동작이 그대로다.
    값 계산이 한 군데 모여 있으면 "돈은 받았는데 조리표엔 없는" 류의 어긋남을 찾기도 쉽다.
*/

export type MenuSel = Record<MenuType, number>;

export type OrderSet = {
  id: string;
  stage: StageType | null;
  volume: number | null;
  menus: MenuSel;
  _simpleQty?: number; // 간단주문: 팩수만 저장, 메뉴 미선택
};

export type DateOrder = {
  id: string;
  delivery_date: string;
  sets: OrderSet[];
};

let _uid = 0;
export function uid() { return String(++_uid); }
export function emptyMenus(): MenuSel { return { 한우: 0, 닭: 0, 기타단백질: 0 }; }
export function newSet(): OrderSet { return { id: uid(), stage: null, volume: null, menus: emptyMenus() }; }
export function newDate(): DateOrder { return { id: uid(), delivery_date: '', sets: [newSet()] }; }

export function setQty(s: OrderSet, menu: MenuType, val: number): OrderSet {
  // _simpleQty(간단주문 팩수)가 남아있으면 상세 메뉴를 골라도 제출 시 무시되고 메뉴가 빈 채로
  // 나가버림 — 상세 메뉴를 직접 조작하는 순간 간단주문 흔적은 지운다.
  return { ...s, _simpleQty: undefined, menus: { ...s.menus, [menu]: Math.max(0, Math.min(10, val)) } };
}

export function setQtyTotal(s: OrderSet): number {
  // ⚠️ Object.values(s.menus)로 전부 합치면 안 됨.
  // 제출 payload는 MENU_TYPES에 있는 키만 담는데(submit의 menus), 합계만 모든 키를 더하면
  // 주방이 안 쓰는 타입 키(예: 'other')가 섞였을 때 "돈은 3팩인데 조리표엔 2팩"이 된다.
  // 실제로 8/16 주문 2건이 그렇게 들어왔음(한우1+닭1인데 3팩·3팩값). 합계와 payload의
  // 기준을 MENU_TYPES 하나로 통일해서, 기록되지 않는 팩에는 절대 값을 매기지 않는다.
  return s._simpleQty ?? MENU_TYPES.reduce((a, m) => a + (s.menus[m] || 0), 0);
}

// ⚠️ 반찬 세트는 용량 개념이 없어서 volume=0으로 담기는데, 0은 falsy라 `s.volume` 체크에
// 전부 걸러져서 가격 합계·제출 데이터에서 통째로 빠져버렸음(반찬만 주문하면 합계 0원 →
// 서버가 "가격 계산 오류"로 거부). 아래 헬퍼로 반찬을 명시적으로 구분해서 처리한다.
export function isBanchanSet(s: OrderSet): boolean {
  return (s.stage as any) === '반찬세트';
}

/** 주문에 담긴 유효한 세트인지 — 이유식은 단계+용량이, 반찬은 단계만 있으면 됨 */
export function isFilledSet(s: OrderSet): boolean {
  if (setQtyTotal(s) <= 0) return false;
  return isBanchanSet(s) ? true : !!(s.stage && s.volume);
}

export function setPrice(s: OrderSet, tier: PriceTier): number {
  // 손님 화면에서는 반찬을 세트 단위로만 판다(종류별로 골라 담거나 낱개로 받는 건
  // 주문접수 쪽이다 — 낱개는 픽업만이라 손님 화면에 아직 안 붙였다).
  // 값 매기는 함수는 한 군데로 모아 둔다 — 나중에 붙여도 어긋나지 않게.
  if (isBanchanSet(s)) return banchanLineTotal(tier, s.stage, setQtyTotal(s));
  if (!s.stage || !s.volume) return 0;
  return getPrice(s.stage, s.volume, tier) * setQtyTotal(s);
}

export function dateQty(d: DateOrder): number {
  return d.sets.reduce((sum, s) => sum + setQtyTotal(s), 0);
}

export function datePrice(d: DateOrder, tier: PriceTier): number {
  return d.sets.reduce((sum, s) => sum + setPrice(s, tier), 0);
}
