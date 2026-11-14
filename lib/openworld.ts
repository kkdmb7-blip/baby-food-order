/*
  오픈월드 — 나라에서 하는 후원사업으로 보내는 아이들.
  손님이 돈을 보내지 않고, 나중에 한꺼번에 정산받는다(따로 정리).
  엑셀 시절엔 월·목 이유식 표 아래쪽에 떨어뜨려 적었다.

  표시는 두 군데
    손님 카드  baby_food_customers.openworld = true  → 새 주문에 자동으로 아래 문구가 붙는다
    주문       paid=false, paid_note = OPENWORLD_NOTE → 미입금으로 안 세고, 입금 대조에서 뺀다
*/
export const OPENWORLD_NOTE = '오픈월드 — 나중에 한꺼번에 정산';

// 후원사업은 2026-11-19 배송분까지만. 그 뒤 주문은 손님 카드에 표시가 있어도 일반 주문(입금 대조 대상)으로 받는다.
export const OPENWORLD_LAST_DATE = '2026-11-19';
export const openworldApplies = (deliveryDate?: string | null) => !!deliveryDate && deliveryDate <= OPENWORLD_LAST_DATE;

export const isOpenworld = (note?: string | null) => String(note || '').startsWith('오픈월드');
