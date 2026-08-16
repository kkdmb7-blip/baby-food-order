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
  // ⚠️ regular_schedule을 무조건 덮어쓰면(예전엔 `|| []`), 이름·메모만 고치려고 호출해도
  // 그 고객의 정기배송 스케줄이 통째로 날아가고 cron이 조용히 그 고객을 건너뛰게 됨.
  // 값을 명시적으로 보냈을 때만 갱신한다. 형식도 배열이 아니라 객체({stage,volume,slots})가 맞음.
  const row: Record<string, any> = {
    baby_name, phone: String(phone).replace(/\D/g, ''), is_regular: !!is_regular, memo: memo || null,
  };
  if (regular_schedule !== undefined) row.regular_schedule = regular_schedule || {};
  const { data, error } = id
    ? await sb.from('baby_food_customers').update(row).eq('id', id).select('id').single()
    : await sb.from('baby_food_customers').insert(row).select('id').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data?.id });
}
