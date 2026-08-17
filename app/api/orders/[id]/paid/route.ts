import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';

// PATCH /api/orders/[id]/paid — 입금 확인 토글 (admin)
// 지금까지는 주문내역·입금내역 엑셀을 파이썬 스크립트로 대조하고 계셨는데,
// 주문마다 확인 여부를 앱에 남겨두면 그 과정을 없앨 수 있다.
export async function PATCH(req: NextRequest, ctx: { params: { id: string } }) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const id = ctx.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

  const { paid } = await req.json().catch(() => ({}));
  if (typeof paid !== 'boolean') return NextResponse.json({ error: 'invalid' }, { status: 400 });

  const sb = supabaseService();
  const { error } = await sb.from('baby_food_orders')
    .update({ paid, paid_at: paid ? new Date().toISOString() : null })
    .eq('id', id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, paid });
}
