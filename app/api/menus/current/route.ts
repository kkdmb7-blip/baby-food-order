import { NextResponse } from 'next/server';
import { supabaseAnon } from '@/lib/supabase';
import { thisWeekMonday } from '@/lib/dates';

// GET — 이번 주 메뉴 (anon, 고객 주문폼용)
export async function GET() {
  const sb = supabaseAnon();
  const weekStart = thisWeekMonday();

  const { data, error } = await sb
    .from('baby_food_weekly_menus')
    .select('menu_type, vegetables')
    .eq('week_start', weekStart);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // 등록 안 됐으면 빈 배열 (폼에서 야채 설명 없이 표시)
  return NextResponse.json({ menus: data || [], week_start: weekStart });
}
