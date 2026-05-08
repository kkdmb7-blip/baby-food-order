import { NextResponse } from 'next/server';
import { supabaseAnon, supabaseService } from '@/lib/supabase';
import { thisWeekMonday } from '@/lib/dates';

// GET — 이번 주 메뉴 (anon, 고객 주문폼용)
// 우선순위: baby_food_weekly_menus 등록분 → kkakung_history 자동 매핑
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
    return NextResponse.json({ menus: manualMenus, week_start: requestedWeek, source: 'manual' });
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

    // type별 첫 번째 항목의 야채 정보 추출
    const seen = new Set<string>();
    const menus: { menu_type: string; vegetables: string }[] = [];
    const TYPE_MAP: Record<string, string> = { hanwoo: '한우', chicken: '닭', p3: '기타단백질' };

    for (const day of schedule) {
      const dayMenus: any[] = day.menus || [];
      for (const m of dayMenus) {
        const rawType: string = m.type || '';
        const korType = TYPE_MAP[rawType];
        if (!korType || seen.has(korType)) continue;
        seen.add(korType);
        // ingredients에서 주재료 빼고 야채만 표시
        const ingr: string = m.ingredients || '';
        const main = rawType === 'hanwoo' ? '한우' : rawType === 'chicken' ? '닭가슴살' : '';
        const veg = ingr
          .split(',')
          .map((s: string) => s.trim())
          .filter((s: string) => s && s !== main && s !== '닭가슴살' && s !== '한우' && s !== '한우육수' && s !== '닭육수' && s !== '채소상탕' && s !== '양파')
          .join(', ');
        menus.push({ menu_type: korType, vegetables: veg });
      }
      if (seen.size >= 3) break;
    }

    return NextResponse.json({ menus, week_start: requestedWeek, source: 'kkakung' });
  } catch (e) {
    return NextResponse.json({ menus: [], week_start: requestedWeek, source: 'error' });
  }
}
