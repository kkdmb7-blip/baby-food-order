import { NextRequest, NextResponse } from 'next/server';
import { supabaseService, PREPAID_UNITS } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';

// GET /api/customers — 선결제+정기 목록 (admin)
export async function GET(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const sb = supabaseService();
  const { data, error } = await sb
    .from('baby_food_customers')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ customers: data });
}

// POST /api/customers — 고객 등록/수정 (admin)
export async function POST(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const { id, baby_name, phone, is_regular, regular_schedule, memo } = b;
  if (!baby_name || !phone) return NextResponse.json({ error: '이름·연락처 필수' }, { status: 400 });

  const sb = supabaseService();
  const row = { baby_name, phone: String(phone).replace(/\D/g,''), is_regular: !!is_regular, regular_schedule: regular_schedule || [], memo: memo || null };
  const { data, error } = id
    ? await sb.from('baby_food_customers').update(row).eq('id', id).select('id').single()
    : await sb.from('baby_food_customers').insert(row).select('id').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data?.id });
}
