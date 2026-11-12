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

  // 사장님이 잔여를 직접 고치는 경우 — { set: 새 잔여, memo: 사유 }
  // 카톡으로 받은 선결제를 처음 옮기거나, 손님과 맞춰보다 틀린 걸 고칠 때. 장부에 '수정' 으로 남긴다.
  if (body.set !== undefined) {
    const target = Number(body.set);
    if (!Number.isInteger(target) || target < 0 || target > 999) {
      return NextResponse.json({ error: '0~999 사이 숫자로 적어주세요' }, { status: 400 });
    }
    const memo = String(body.memo || '').trim().slice(0, 100);
    const sb = supabaseService();
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data: c } = await sb.from('baby_food_customers')
        .select('prepaid_balance, phone, baby_name').eq('id', ctx.params.id).single();
      if (!c) return NextResponse.json({ error: '고객 없음' }, { status: 404 });
      const base = Number(c.prepaid_balance) || 0;
      if (base === target) return NextResponse.json({ ok: true, new_balance: base, unchanged: true });
      const { data: upd, error } = await sb.from('baby_food_customers')
        .update({ prepaid_balance: target }).eq('id', ctx.params.id).eq('prepaid_balance', base).select('id');
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (upd && upd.length) {
        await recordPrepaid(sb, {
          customerId: ctx.params.id, phone: c.phone, babyName: c.baby_name,
          kind: '수정', packs: target - base, balanceAfter: target,
          memo: `사장님이 직접 고침 ${base}→${target}${memo ? ` · ${memo}` : ''}`,
        });
        return NextResponse.json({ ok: true, new_balance: target });
      }
    }
    return NextResponse.json({ error: '잔액이 계속 바뀌어 고치지 못했어요 — 다시 눌러주세요' }, { status: 409 });
  }

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

// GET /api/customers/[id]/prepaid — 그 손님의 선결제 장부(최근 100줄) + 주문 내역(최근 200건)
// 주문은 지우지 않고 취소도 상태만 바뀌므로, 여기서 그 손님이 언제 무엇을 주문했는지 전부 보인다.
export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const sb = supabaseService();
  const { data: c } = await sb.from('baby_food_customers').select('phone').eq('id', ctx.params.id).maybeSingle();
  const [led, ord] = await Promise.all([
    sb.from('baby_food_prepaid_ledger')
      .select('created_at, kind, packs, balance_after, amount_won, order_id, memo')
      .eq('customer_id', ctx.params.id).order('created_at', { ascending: false }).limit(100),
    c?.phone
      ? sb.from('baby_food_orders')
          .select('id, created_at, delivery_date, stage, volume, total_qty, total_price, status, order_type, receive_method')
          .eq('customer_phone', c.phone).order('delivery_date', { ascending: false }).limit(200)
      : Promise.resolve({ data: [], error: null } as any),
  ]);
  if (led.error) return NextResponse.json({ error: led.error.message }, { status: 500 });
  if (ord.error) return NextResponse.json({ error: ord.error.message }, { status: 500 });
  return NextResponse.json({ ok: true, rows: led.data || [], orders: ord.data || [] });
}
