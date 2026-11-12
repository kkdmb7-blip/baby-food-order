import { NextRequest, NextResponse } from 'next/server';
import { supabaseService, PREPAID_UNITS } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';
import { recordPrepaid } from '@/lib/prepaidLedger';

// POST /api/customers/[id]/prepaid — 선결제 충전 (admin)
// body { units: 20|30|50, amount_won?: 받은 돈 }
//
// ⚠️ 전에는 "읽은 잔액 + 팩" 을 그냥 덮어써서, 충전 단추를 두 번 빨리 누르거나 그 사이 주문이
//    들어오면 한쪽이 지워질 수 있었다. 다른 곳(주문 차감·취소)처럼 "읽은 값 그대로일 때만" 쓴다.
// ⚠️ 충전 기록이 아무 데도 안 남았다. 이제 장부(baby_food_prepaid_ledger)에 남긴다.
export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const units = body.units;
  if (!PREPAID_UNITS.includes(units)) {
    return NextResponse.json({ error: `유효 단위: ${PREPAID_UNITS.join('/')}팩` }, { status: 400 });
  }
  const amountWon = Number(body.amount_won) > 0 ? Math.floor(Number(body.amount_won)) : null;
  const id = ctx.params.id;
  const sb = supabaseService();

  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: c } = await sb.from('baby_food_customers')
      .select('prepaid_balance, phone, baby_name').eq('id', id).single();
    if (!c) return NextResponse.json({ error: '고객 없음' }, { status: 404 });
    const base = Number(c.prepaid_balance) || 0;
    const next = base + units;
    const { data: upd, error } = await sb.from('baby_food_customers')
      .update({ prepaid_balance: next }).eq('id', id).eq('prepaid_balance', base).select('id');
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (upd && upd.length) {
      await recordPrepaid(sb, {
        customerId: id, phone: c.phone, babyName: c.baby_name,
        kind: '충전', packs: units, balanceAfter: next, amountWon, memo: `${units}팩 충전`,
      });
      return NextResponse.json({ ok: true, new_balance: next });
    }
    // 그 사이 잔액이 바뀌었다 — 새 값으로 다시
  }
  return NextResponse.json({ error: '잔액이 계속 바뀌어 충전하지 못했어요 — 다시 눌러주세요' }, { status: 409 });
}

// GET /api/customers/[id]/prepaid — 그 손님의 선결제 장부 (최근 100줄)
export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const sb = supabaseService();
  const { data, error } = await sb.from('baby_food_prepaid_ledger')
    .select('created_at, kind, packs, balance_after, amount_won, order_id, memo')
    .eq('customer_id', ctx.params.id).order('created_at', { ascending: false }).limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, rows: data || [] });
}
