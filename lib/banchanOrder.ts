/*
  반찬 번호 — 어디서 보든 같은 순서·같은 번호 (2026-11-13)

  사장님: "윤은채가 앱을 통해 메뉴를 작성하면 그 메뉴가 여기저기 사용되는데 그때 프린트할 수 있는
          페이지 누르면 자동으로 정리가 되잖아 순서가 특히 반찬 순서 이게 전부 어디서든 통일 되게 해줘야 돼
          … 고객이 주문할 때 1번 2번 3번 두 개 4번 빼고 5번 6번 이런 식으로 주문하고 있어"

  기준은 메뉴 프로그램(kkakung-menu)의 '메뉴표 인쇄' — 손님이 받아 보는 종이가 그것이다.
  그 인쇄는 적은 순서와 상관없이 반찬을 이렇게 다시 세운다(yusikCard):

      소고기·한우 → 한돈·돼지 → 닭 → 그 밖 → 잔멸치      (같은 무리끼리는 적은 순서 그대로)
      그리고 국은 늘 6번

  ⚠️ kkakung-menu/index.html 의 sortBanchanItems 와 반드시 같은 규칙이어야 한다.
     한쪽만 고치면 손님 종이의 3번과 주문 화면의 3번이 다른 반찬이 된다.
*/

export function banchanPriority(name: string): number {
  const n = String(name || '');
  if (n.includes('소고기') || n.includes('한우')) return 0;
  if (n.includes('한돈') || n.includes('돼지')) return 1;
  if (n.includes('닭')) return 2;
  if (n.includes('잔멸치')) return 4;
  return 3;
}

/** 반찬 목록(국 제외)을 인쇄 순서로. 같은 무리는 원래 순서를 지킨다(안정 정렬). */
export function sortBanchanItems<T extends { name?: string }>(items: T[]): T[] {
  return (items || [])
    .map((it, i) => ({ it, i, p: banchanPriority(String(it?.name || '')) }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map(x => x.it);
}

export type NumberedBanchan = { no: number; name: string; ingredients: string; isSoup: boolean };

/** 그날 메뉴(items + soup) → 번호 붙은 여섯 칸. 반찬 1~5(또는 그 이상), 국은 맨 끝 번호. */
export function numberBanchanDay(day: { items?: any[] | null; soup?: any } | null | undefined): NumberedBanchan[] {
  const items = sortBanchanItems((day?.items || []).filter((x: any) => String(x?.name || '').trim()));
  const out: NumberedBanchan[] = items.map((x: any, i) => ({
    no: i + 1, name: String(x.name).trim(), ingredients: String(x.ingredients || '').trim(), isSoup: false,
  }));
  const soupName = String(day?.soup?.name || '').trim();
  if (soupName) out.push({ no: out.length + 1, name: soupName, ingredients: String(day?.soup?.ingredients || '').trim(), isSoup: true });
  return out;
}

/**
 * 주문에 담긴 반찬 [{menu, qty}] 을 그날 번호 순서로 세우고 번호를 붙인다.
 * 그날 메뉴를 모르면(옛 주문·메뉴 삭제) 담긴 순서 그대로 두고 번호는 붙이지 않는다.
 */
export function orderBanchanMenus<T extends { menu: string }>(menus: T[], dayList?: NumberedBanchan[] | null): (T & { no: number | null })[] {
  const list = Array.isArray(menus) ? menus : [];
  if (!dayList || dayList.length === 0) return list.map(m => ({ ...m, no: null }));
  const norm = (s: string) => String(s || '').replace(/\s+/g, '');
  const idx = new Map(dayList.map(d => [norm(d.name), d.no]));
  return list
    .map((m, i) => ({ m, i, no: idx.get(norm(m.menu)) ?? null }))
    .sort((a, b) => (a.no ?? 99) - (b.no ?? 99) || a.i - b.i)
    .map(x => ({ ...x.m, no: x.no }));
}

/** 국인가 — 그날 메뉴를 모를 때(조리표 합계 등) 이름으로 가린다 */
export const looksSoup = (name: string) => /(국|탕|찌개|스프)$/.test(String(name || '').trim());

/**
 * 그날 메뉴 없이 이름만 있을 때 번호 순서로 세운다 — 반찬은 인쇄 규칙대로, 국은 맨 뒤.
 * 같은 무리끼리는 들어온 순서를 지킨다.
 */
export function sortBanchanNames<T extends { name: string }>(rows: T[]): T[] {
  return (rows || [])
    .map((r, i) => ({ r, i, p: looksSoup(r.name) ? 9 : banchanPriority(r.name) }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map(x => x.r);
}
