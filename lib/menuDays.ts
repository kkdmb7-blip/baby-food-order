import { COOKING_DAYS, BANCHAN_DOW } from '@/lib/supabase';

// 그 날짜에 무엇을 만드는지 — 요일이 아니라 "실제 올려둔 메뉴"를 기준으로 판단한다.
//
// ⚠️ 요일로 고정하면 안 되는 이유: 공휴일이 끼면 반찬을 화요일이나 목요일에 하기도 하고,
//    쉬는 날은 아예 조리를 안 한다. 사장님이 메뉴를 올릴 때 그 조정을 이미 하고 있으므로
//    (kkakung_history의 schedule), 주문도 그 데이터를 그대로 따라가는 게 맞다.
//
// kkakung_history.yusik.schedule[] 한 칸의 모양:
//   { date, menus: [...이유식 3종], items: [...반찬], soup: {...}, removed?: true }
//   - menus 가 있으면 그날 이유식을 만든다
//   - items(또는 soup)가 있으면 그날 반찬 세트를 만든다
//   - removed 이거나 둘 다 비어 있으면 그날은 조리를 안 한다 (휴무)
export type DayKind = {
  yusik: boolean;    // 이유식 주문 가능
  banchan: boolean;  // 반찬 세트 주문 가능
  fromMenu: boolean; // 실제 메뉴표를 보고 판단했는지 (false면 아직 안 올라온 주 → 요일 기본값)
};

// 그 날짜가 속한 주의 월요일 (KST 기준 날짜 문자열 연산)
function weekMondayOf(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  const dow = d.getUTCDay();
  const back = (dow + 6) % 7; // 월=0
  return new Date(d.getTime() - back * 86400000).toISOString().slice(0, 10);
}

// 요일 기본값 — 메뉴가 아직 안 올라온 주에만 쓴다.
// 여기서 막아버리면 다음 주 메뉴가 올라오기 전엔 미리 주문을 못 넣게 되므로 기본값을 둔다.
function byWeekday(date: string): DayKind {
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  return {
    yusik: (COOKING_DAYS as readonly number[]).includes(dow),
    banchan: dow === BANCHAN_DOW,
    fromMenu: false,
  };
}

export async function menuKindsFor(sb: any, dates: string[]): Promise<Map<string, DayKind>> {
  const out = new Map<string, DayKind>();
  const weeks = [...new Set(dates.map(weekMondayOf))];
  if (weeks.length === 0) return out;

  let rows: any[] = [];
  try {
    const { data } = await sb.from('kkakung_history').select('id, yusik').in('id', weeks);
    rows = data || [];
  } catch {
    // 메뉴표 조회가 실패했다고 주문을 막아버리면 장사가 멈춘다 — 요일 기본값으로 넘어간다
    rows = [];
  }

  const byDate = new Map<string, any>();
  const knownWeeks = new Set<string>();
  for (const w of rows) {
    knownWeeks.add(String(w.id));
    for (const d of (w?.yusik?.schedule || [])) {
      if (d?.date) byDate.set(String(d.date), d);
    }
  }

  for (const date of dates) {
    if (!knownWeeks.has(weekMondayOf(date))) { out.set(date, byWeekday(date)); continue; }
    const d = byDate.get(date);
    if (!d || d.removed) { out.set(date, { yusik: false, banchan: false, fromMenu: true }); continue; }
    out.set(date, {
      yusik: Array.isArray(d.menus) && d.menus.length > 0,
      banchan: (Array.isArray(d.items) && d.items.length > 0) || !!d.soup,
      fromMenu: true,
    });
  }
  return out;
}
