import { NextRequest, NextResponse } from 'next/server';
import { supabaseService, MENU_TYPES, type MenuType } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';

// GET /api/menus?week_start=YYYY-MM-DD  (admin)
export async function GET(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const week_start = new URL(req.url).searchParams.get('week_start');
  if (!week_start) return NextResponse.json({ error: 'week_start required' }, { status: 400 });

  const sb = supabaseService();
  const { data } = await sb.from('baby_food_weekly_menus').select('*').eq('week_start', week_start);
  return NextResponse.json({ menus: data || [] });
}

// POST /api/menus — 메뉴 등록/수정 (admin)
export async function POST(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const { week_start, menu_type, vegetables } = await req.json().catch(() => ({}));
  if (!week_start || !MENU_TYPES.includes(menu_type as MenuType)) {
    return NextResponse.json({ error: 'invalid params' }, { status: 400 });
  }
  const sb = supabaseService();
  const { error } = await sb.from('baby_food_weekly_menus').upsert(
    { week_start, menu_type, vegetables: String(vegetables || '') },
    { onConflict: 'week_start,menu_type' }
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
