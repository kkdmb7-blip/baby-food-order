import { NextResponse } from 'next/server';
import { supabaseAnon } from '@/lib/supabase';
import { thisWeekMonday } from '@/lib/dates';

// ── 재료 정렬 정규화 ────────────────────────────────────────────────
// 표시 순서: [주단백질] → [야채들] → [고정 suffix]
// 주방에서 뒤에 추가 입력한 재료도 무조건 이 순서로 재배치

const FIXED_SUFFIX: Record<string, string[]> = {
  hanwoo: ['한우육수', '양파', '채소상탕'],
  chicken: ['닭육수', '양파', '채소상탕'],
  p3: ['양파', '채소상탕']
};

const MAIN_PROTEIN: Record<string, string[]> = {
  hanwoo: ['한우'],
  chicken: ['닭가슴살', '닭']
  // p3: 첫 번째로 나오는 비-suffix 재료가 주단백질
};

function normalizeIngredients(raw: string, type: 'hanwoo' | 'chicken' | 'p3'): string {
  const all = raw.split(',').map(s => s.trim()).filter(Boolean);
  const suffix = FIXED_SUFFIX[type] ?? [];
  const mainList = MAIN_PROTEIN[type] ?? [];

  // suffix 제거 (위치 무관)
  const withoutSuffix = all.filter(s => !suffix.includes(s));

  // 주단백질 분리
  let mainItem = '';
  const middle: string[] = [];
  for (const s of withoutSuffix) {
    if (!mainItem && (mainList.includes(s) || (type === 'p3' && mainItem === ''))) {
      mainItem = s;
    } else {
      middle.push(s);
    }
  }

  // [주단백질, ...야채, ...고정suffix]
  return [mainItem, ...middle, ...suffix].filter(Boolean).join(', ');
}

// GET — 이번 주 메뉴 (anon, 고객 주문폼용)
// 우선순위: baby_food_weekly_menus → kkakung_history 자동 매핑
export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestedWeek = url.searchParams.get('week') || thisWeekMonday();

  // 1) baby_food_weekly_menus 먼저 조회
  const sbAnon = supabaseAnon();
  const { data: manualMenus } = await sbAnon
    .from('baby_food_weekly_menus')
    .select('menu_type, vegetables')
    .eq('week_start', requestedWeek);

  if (manualMenus && manualMenus.length > 0) {
    // manual 데이터도 정규화해서 반환
    const normalized = manualMenus.map((m: any) => {
      const typeKey = m.menu_type === '한우' ? 'hanwoo' : m.menu_type === '닭' ? 'chicken' : 'p3';
      return { menu_type: m.menu_type, vegetables: normalizeIngredients(m.vegetables || '', typeKey) };
    });
    return NextResponse.json({ menus: normalized, week_start: requestedWeek, source: 'manual' });
  }

  // 2) kkakung_history 에서 자동 매핑
  try {
    const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const SB_URL = 'https://ymghmfkqctckxxysxkvy.supabase.co';
    const r = await fetch(
      `${SB_URL}/rest/v1/kkakung_history?id=eq.${encodeURIComponent(requestedWeek)}&select=id,yusik`,
      { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } }
    );
    const rows = await r.json();
    if (!rows || !rows[0]?.yusik?.schedule) {
      return NextResponse.json({ menus: [], week_start: requestedWeek, source: 'none' });
    }

    const schedule: any[] = rows[0].yusik.schedule || [];

    // 주방 데이터의 세 번째 메뉴 타입은 실제로 'other' — 'p3'만 매핑돼 있어서
    // 기타단백질 메뉴가 통째로 누락됐음(주문폼에 재료가 안 뜨고 메뉴명도 안 보임)
    const TYPE_MAP: Record<string, { kor: string; key: 'hanwoo' | 'chicken' | 'p3' }> = {
      hanwoo:  { kor: '한우',       key: 'hanwoo' },
      chicken: { kor: '닭',         key: 'chicken' },
      p3:      { kor: '기타단백질', key: 'p3' },
      other:   { kor: '기타단백질', key: 'p3' }
    };

    const seen = new Set<string>();
    const menus: { menu_type: string; vegetables: string }[] = [];

    for (const day of schedule) {
      for (const m of (day.menus || []) as any[]) {
        const mapped = TYPE_MAP[m.type || ''];
        if (!mapped || seen.has(mapped.kor)) continue;
        seen.add(mapped.kor);
        // 정규화된 재료 순서로 반환
        const normalized = normalizeIngredients(m.ingredients || '', mapped.key);
        menus.push({ menu_type: mapped.kor, vegetables: normalized });
      }
      if (seen.size >= 3) break;
    }

    return NextResponse.json({ menus, week_start: requestedWeek, source: 'kkakung' });
  } catch (e) {
    return NextResponse.json({ menus: [], week_start: requestedWeek, source: 'error' });
  }
}
