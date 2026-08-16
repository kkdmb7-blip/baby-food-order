import type { MenuType } from './supabase';

// ────────────────────────────────────────────────────────────────
// 주문의 items 저장 구조가 두 가지로 섞여 있음
//   구형(평면): [{ menu:'한우', qty:2 }, ...]                      ← 단일 날짜만 되던 시절
//   신형(중첩): [{ delivery_date, sets:[{ stage, volume, menus:[{menu,qty}], qty }], date_qty, date_price }]
//
// 조리표·라벨·엑셀이 구형 구조만 알고 있어서 신형 주문의 메뉴 수량이 전부 0으로 나왔고,
// 복합주문은 stage='mixed'/volume=null 이라 조리표 그룹에도 안 잡혀 통째로 누락됐음.
// 두 구조를 한곳에서 흡수해서 화면들이 같은 값을 보게 한다.
// ────────────────────────────────────────────────────────────────

export type OrderLike = {
  items?: any;
  delivery_date: string;
  stage?: string | null;
  volume?: number | null;
  total_qty?: number;
};

export type OrderSlice = {
  stage: string | null;
  volume: number | null;
  menus: Record<string, number>;
  qty: number;
};

function itemArray(o: OrderLike): any[] {
  return Array.isArray(o.items) ? o.items : [];
}

export function isMultiItems(o: OrderLike): boolean {
  const items = itemArray(o);
  return items.length > 0 && items[0]?.delivery_date !== undefined;
}

/** 이 주문이 실제로 걸쳐 있는 조리일 전부 (복합주문은 여러 날) */
export function orderDates(o: OrderLike): string[] {
  if (!isMultiItems(o)) return o.delivery_date ? [o.delivery_date] : [];
  const set = new Set<string>();
  for (const d of itemArray(o)) if (d?.delivery_date) set.add(d.delivery_date);
  if (set.size === 0 && o.delivery_date) set.add(o.delivery_date);
  return [...set].sort();
}

function menusToMap(menus: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of Array.isArray(menus) ? menus : []) {
    if (m?.menu) out[m.menu] = (out[m.menu] || 0) + (Number(m.qty) || 0);
  }
  return out;
}

/**
 * 특정 조리일에 해당하는 세트 목록.
 * 복합주문은 그 날짜분만 뽑아내므로, 월+목 주문이 목요일 조리표에도 정상적으로 잡힌다.
 */
export function slicesOn(o: OrderLike, date: string): OrderSlice[] {
  if (!isMultiItems(o)) {
    if (o.delivery_date !== date) return [];
    return [{
      stage: o.stage ?? null,
      volume: o.volume ?? null,
      menus: menusToMap(itemArray(o)),
      qty: Number(o.total_qty) || 0,
    }];
  }
  const out: OrderSlice[] = [];
  for (const d of itemArray(o)) {
    if (d?.delivery_date !== date) continue;
    for (const s of Array.isArray(d.sets) ? d.sets : []) {
      out.push({
        stage: s?.stage ?? null,
        volume: s?.volume ?? null,
        menus: menusToMap(s?.menus),
        qty: Number(s?.qty) || 0,
      });
    }
  }
  return out;
}

/** 특정 조리일의 총 팩수 */
export function qtyOn(o: OrderLike, date: string): number {
  return slicesOn(o, date).reduce((sum, s) => sum + s.qty, 0);
}

/** 특정 조리일의 메뉴별 팩수 */
export function menuQtyOn(o: OrderLike, date: string, menu: MenuType | string): number {
  return slicesOn(o, date).reduce((sum, s) => sum + (s.menus[menu] || 0), 0);
}

/** 주문 전체(모든 날짜)의 메뉴별 팩수 합계 — 엑셀 내보내기처럼 주문 단위로 볼 때 */
export function menuTotal(o: OrderLike, menu: MenuType | string): number {
  if (!isMultiItems(o)) return menusToMap(itemArray(o))[menu] || 0;
  let sum = 0;
  for (const d of itemArray(o)) {
    for (const s of Array.isArray(d.sets) ? d.sets : []) sum += menusToMap(s?.menus)[menu] || 0;
  }
  return sum;
}

/** 날짜 문자열(YYYY-MM-DD)에 일수를 더한 값 — 조리표 조회 범위 계산용 */
export function shiftDate(date: string, days: number): string {
  const t = new Date(date + 'T00:00:00Z').getTime() + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
