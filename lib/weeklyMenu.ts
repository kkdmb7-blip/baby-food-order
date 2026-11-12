import { supabaseService } from './supabase';
import { weekMonday, kstToday } from './dates';

/*
  상세페이지(자사몰)에 쓰는 '이번 주 식단' 읽기.

  왜 필요한가
    식단표가 HTML에 박혀 있었다. 11/2~11/13 두 주를 손으로 적어 두었는데,
    그 주가 지나면 손님이 보는 표가 통째로 지난 날짜가 된다. 11/12에 보니
    '재료 투명성' 섹션은 11/2 메뉴에서 열흘째 멈춰 있었다.
    사장님이 월초마다 HTML을 고치는 수밖에 없는 구조였다.

  어디서 읽나 (실제 구조 — 추측 아님, 2026-11-12 확인)
    kkakung_history 는 '그 주 월요일' 날짜를 id 로 쓰는 주간 행이다.

      id            '2026-11-09'
      yusik.menus[] 그 주 반찬 5종 (수요일 items 와 같은 내용)
      yusik.schedule[]  월~금 다섯 칸
        { date, type, soup, items, menus }

    type 이름이 헷갈리게 되어 있다. 고치지 말고 그대로 읽는다.
      type:'yushik' = 이유식 날 → menus[] 세 가지, items·soup 는 null
      type:'yusik'  = 유아식 반찬 날(수요일) → items[] 다섯 가지 + soup, menus 는 null

    이유식 menus[] 한 칸:
      { name:'한우 브로콜리', type:'hanwoo'|'chicken'|'other',
        mainVeggie, subVeggie, ingredients:'한우, 송고버섯, 한우육수, …' }

  주 선택
    이번 주와 다음 주를 읽고, 식단이 들어 있는 주만 보여준다.
    둘 다 비면 빈 표를 그리지 않고 '문의해 주세요' 로 떨어진다 —
    지난 날짜를 보여주는 것보다 낫다.
*/

export type DayMenu = {
  date: string;       // YYYY-MM-DD
  dow: number;        // 1=월 … 5=금
  dayNum: number;     // 달력 칸에 적는 날짜 숫자
  isBanchan: boolean; // 수요일 유아식 반찬 날
  isToday: boolean;
  /** 달력 칸에 적는 줄 (반찬 날은 '국 · 소고기 무국' 까지) */
  lines: string[];
  /** 이유식 날의 세 메뉴 — 재료 투명성 탭에 쓴다 */
  menus: { name: string; type: string; ingredients: string }[];
};

export type WeekMenu = { monday: string; days: DayMenu[] };

function dayNumOf(iso: string) { return Number(iso.slice(8, 10)); }
function dowOf(iso: string) {
  const d = new Date(iso + 'T00:00:00Z').getUTCDay();
  return d === 0 ? 7 : d;
}

function normalizeWeek(monday: string, yusik: any, today: string): WeekMenu | null {
  const schedule: any[] = Array.isArray(yusik?.schedule) ? yusik.schedule : [];
  const days: DayMenu[] = [];

  for (const d of schedule) {
    const date = String(d?.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    const rawMenus: any[] = Array.isArray(d?.menus) ? d.menus : [];
    const rawItems: any[] = Array.isArray(d?.items) ? d.items : [];
    const soupName = String(d?.soup?.name || '').trim();
    const isBanchan = rawItems.length > 0 || !!soupName;

    const lines: string[] = isBanchan
      ? [
          ...rawItems.map(x => String(x?.name || '').trim()).filter(Boolean),
          ...(soupName ? [`국 · ${soupName}`] : []),
        ]
      : rawMenus.map(x => String(x?.name || '').trim()).filter(Boolean);

    if (!lines.length) continue; // 아직 안 짜인 날은 칸을 비워 둔다

    days.push({
      date,
      dow: dowOf(date),
      dayNum: dayNumOf(date),
      isBanchan,
      isToday: date === today,
      lines,
      menus: rawMenus
        .map(x => ({
          name: String(x?.name || '').trim(),
          type: String(x?.type || '').trim(),
          ingredients: String(x?.ingredients || '').trim(),
        }))
        .filter(x => x.name),
    });
  }

  if (!days.length) return null;
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { monday, days };
}

/** 이번 주 + 다음 주 중 식단이 들어 있는 주만 */
export async function getMenuWeeks(): Promise<WeekMenu[]> {
  const today = kstToday();
  const mondays = [weekMonday(0), weekMonday(1)];
  try {
    const sb = supabaseService();
    const { data, error } = await sb
      .from('kkakung_history')
      .select('id, yusik')
      .in('id', mondays);
    if (error) throw error;

    const byId = new Map<string, any>((data || []).map((r: any) => [r.id, r.yusik]));
    const out: WeekMenu[] = [];
    for (const mon of mondays) {
      const w = normalizeWeek(mon, byId.get(mon), today);
      if (w) out.push(w);
    }
    return out;
  } catch (e: any) {
    // 식단을 못 읽어도 페이지 나머지는 떠야 한다. 빈 배열이면 '문의해 주세요' 로 떨어진다.
    console.error('[weeklyMenu] 식단 조회 실패:', e?.message || e);
    return [];
  }
}

/**
 * 재료 투명성 탭에 쓸 하루.
 * 오늘이 이유식 날이면 오늘, 아니면 오늘에 가장 가까운 이유식 날.
 * (손님이 "실제로 나간 이유식" 으로 읽는 자리라 아무 날이나 쓰면 안 된다)
 */
export function pickIngredientDay(weeks: WeekMenu[]): DayMenu | null {
  const all = weeks.flatMap(w => w.days).filter(d => !d.isBanchan && d.menus.length > 0);
  if (!all.length) return null;
  const today = kstToday();
  const todays = all.find(d => d.date === today);
  if (todays) return todays;
  // 지난 날 중 가장 최근 → 없으면 앞으로 올 날 중 가장 이른 날
  const past = all.filter(d => d.date < today);
  if (past.length) return past[past.length - 1];
  return all[0];
}
