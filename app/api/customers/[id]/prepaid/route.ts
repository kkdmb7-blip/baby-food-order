import { NextRequest, NextResponse } from 'next/server';
import { supabaseService, PREPAID_UNITS } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';

// POST /api/customers/[id]/prepaid — 선결제 충전 (admin)
export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const { units } = await req.json().catch(() => ({}));
  if (!PREPAID_UNITS.includes(units)) {
    return NextResponse.json({ error: `유효 단위: ${PREPAID_UNITS.join('/')}팩` }, { status: 400 });
  }
  const id = ctx.params.id;
  const sb = supabaseService();
  const { data: c } = await sb.from('baby_food_customers').select('prepaid_balance').eq('id', id).single();
  if (!c) return NextResponse.json({ error: '고객 없음' }, { status: 404 });

  const newBalance = c.prepaid_balance + units;
  const { error } = await sb.from('baby_food_customers').update({ prepaid_balance: newBalance }).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, new_balance: newBalance });
}
