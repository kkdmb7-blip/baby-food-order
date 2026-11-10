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

/**
 * 그 날짜 몫의 메뉴·팩수를 바꿔치운다 — 조리표에서 팩수를 고칠 때 쓴다.
 *
 * 신형(중첩)은 그 날짜 칸의 sets 안쪽 menus·qty 와 date_qty 를 고친다.
 * 구형(평면)은 items 자체가 메뉴 목록이라 통째로 갈아끼운다.
 *
 * ⚠️ 윗칸(total_qty)만 고치고 여기를 안 고치면 조리표·라벨·엑셀은 옛 팩수를 계속 보여준다.
 *    그 둘이 다르면 만드는 양과 청구한 양이 어긋난다.
 */
export function rewriteMenusOn(
  items: any, date: string, menus: { menu: string; qty: number }[], qty: number,
): any {
  const arr = Array.isArray(items) ? items : [];
  const nested = arr.length > 0 && arr[0] && typeof arr[0] === 'object' && 'delivery_date' in arr[0];
  if (!nested) return menus;
  return arr.map(it => {
    if (!it || typeof it !== 'object' || it.delivery_date !== date) return it;
    const sets = Array.isArray(it.sets) ? it.sets : [];
    return { ...it, sets: sets.map((s: any) => ({ ...s, qty, menus })), date_qty: qty };
  });
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

/**
 * 조리표·주소록에 보일 이름 — 저장된 이름을 그대로 쓴다. 아무것도 붙이지 않는다.
 *
 * 왜 붙이면 안 되는가
 *   이 이름은 카카오 채널에 저장해 둔 이름과 같아야 한다. 주문이 카톡으로 오니까,
 *   종이에 적힌 이름이 카톡 이름과 다르면 누구 주문인지 맞춰볼 수가 없다.
 *   구분은 이미 끝나 있다 — 사장님이 카톡에 '찬희', '찬희2', '찬희3' 으로
 *   저장해 두셨고, 같은 아기가 주소가 둘일 때도 거기서 번호를 매기신다.
 *
 *   전에는 같은 이름이 두 줄이면 앱이 연락처 뒷 4자리를 붙였다. 그러면
 *   '찬희2(7788)' 이 되어 카톡 이름과 어긋나고, 뒷자리는 사장님이 외우는 숫자도
 *   아니라서 주문 내용에서 번호를 찾아봐야 했다. 붙이는 쪽이 일을 늘렸다.
 *
 *   한 번 저장한 이름은 사장님이 직접 고치기 전까지 그대로 간다.
 *
 * 대신 같은 이름이 서로 다른 집에서 들어오면 collidingNames 로 알려준다.
 * 고치는 건 사장님이 — 카톡에 적힌 대로.
 */
export function disambiguateNames<T extends { baby_name: string }>(
  orders: T[]
): Map<string, string> {
  const out = new Map<string, string>();
  for (const o of orders) out.set((o as any).id, o.baby_name);
  return out;
}

/**
 * 이름은 같은데 집이 다른 줄들 — 카톡 이름대로 고쳐야 할 것들.
 * 앱이 멋대로 고치지 않고 "여기 겹칩니다" 만 알린다.
 *
 * 같은 집(연락처가 같음)이 여러 줄인 건 겹친 게 아니다 — 중기와 완료기를
 * 같이 시키거나, 한 집이 두 군데로 받는 경우다. 그건 알릴 일이 아니다.
 */
export function collidingNames<T extends {
  baby_name: string;
  customer_phone: string;
  address?: string | null;
}>(orders: T[]): { name: string; homes: { phone: string; address: string }[] }[] {
  const byName = new Map<string, Map<string, string>>();   // 이름 → (연락처 → 주소)
  for (const o of orders) {
    const name = o.baby_name;
    const phone = String(o.customer_phone || '').replace(/\D/g, '');
    if (!byName.has(name)) byName.set(name, new Map());
    if (!byName.get(name)!.has(phone)) byName.get(name)!.set(phone, String(o.address || ''));
  }
  const out: { name: string; homes: { phone: string; address: string }[] }[] = [];
  for (const [name, homes] of byName) {
    if (homes.size > 1) {
      out.push({ name, homes: [...homes].map(([phone, address]) => ({ phone, address })) });
    }
  }
  return out;
}

/** 날짜 문자열(YYYY-MM-DD)에 일수를 더한 값 — 조리표 조회 범위 계산용 */
export function shiftDate(date: string, days: number): string {
  const t = new Date(date + 'T00:00:00Z').getTime() + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
