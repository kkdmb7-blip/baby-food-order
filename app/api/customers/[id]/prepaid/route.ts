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

  // 어떤 단계·용량으로 산 선결제인지 — { label: '완료기 300g' } (빈 값이면 지움)
  if (body.label !== undefined && body.set === undefined && body.times === undefined) {
    const label = String(body.label || '').trim().slice(0, 30) || null;
    const sb = supabaseService();
    const { error } = await sb.from('baby_food_customers').update({ prepaid_label: label }).eq('id', ctx.params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, label });
  }

  // 이유식은 팩(prepaid_balance), 반찬은 회(prepaid_banchan) — 서로 섞이지 않게 칸이 따로다
  const isBanchan = body.item === '반찬';
  const col = isBanchan ? 'prepaid_banchan' : 'prepaid_balance';
  const unit = isBanchan ? '회' : '팩';
  const item = isBanchan ? '반찬' as const : '이유식' as const;

  // 사장님이 잔여를 직접 고치는 경우 — { set: 새 잔여, memo: 사유, item? }
  // 카톡으로 받은 선결제를 처음 옮기거나, 손님과 맞춰보다 틀린 걸 고칠 때. 장부에 '수정' 으로 남긴다.
  // 반찬 회수 충전 — { item:'반찬', times: 4, amount_won } 도 같은 길로 (더하기만 다르다)
  if (body.set !== undefined || (isBanchan && body.times !== undefined)) {
    const adding = body.set === undefined;
    const delta = Number(body.times);
    const target0 = Number(body.set);
    if (adding ? (!Number.isInteger(delta) || delta < 1 || delta > 50)
               : (!Number.isInteger(target0) || target0 < 0 || target0 > 999)) {
      return NextResponse.json({ error: adding ? '1~50회로 적어주세요' : '0~999 사이 숫자로 적어주세요' }, { status: 400 });
    }
    const memo = String(body.memo || '').trim().slice(0, 100);
    const amountWon = Number(body.amount_won) > 0 ? Math.floor(Number(body.amount_won)) : null;
    const sb = supabaseService();
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data: c } = await sb.from('baby_food_customers')
        .select(`${col}, phone, baby_name`).eq('id', ctx.params.id).single();
      if (!c) return NextResponse.json({ error: '고객 없음' }, { status: 404 });
      const base = Number((c as any)[col]) || 0;
      const target = adding ? base + delta : target0;
      if (base === target) return NextResponse.json({ ok: true, new_balance: base, unchanged: true });
      const { data: upd, error } = await sb.from('baby_food_customers')
        .update({ [col]: target }).eq('id', ctx.params.id).eq(col, base).select('id');
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (upd && upd.length) {
        await recordPrepaid(sb, {
          customerId: ctx.params.id, phone: (c as any).phone, babyName: (c as any).baby_name,
          kind: adding ? '충전' : '수정', packs: target - base, balanceAfter: target, amountWon, item,
          memo: adding ? `반찬 ${delta}회 충전${memo ? ` · ${memo}` : ''}`
                       : `사장님이 직접 고침 ${base}→${target}${unit}${memo ? ` · ${memo}` : ''}`,
        });
        return NextResponse.json({ ok: true, new_balance: target, item });
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
  const { data: c } = await sb.from('baby_food_customers').select('phone, payer_names, memo, prepaid_label, prepaid_banchan').eq('id', ctx.params.id).maybeSingle();
  const [led, ord] = await Promise.all([
    sb.from('baby_food_prepaid_ledger')
      .select('created_at, kind, packs, balance_after, amount_won, order_id, memo, item')
      .eq('customer_id', ctx.params.id).order('created_at', { ascending: false }).limit(100),
    // 번호 없는 손님(택배·당일·픽업)은 주문을 customer_id 로 잇는다
    sb.from('baby_food_orders')
      .select('id, created_at, delivery_date, stage, volume, total_qty, total_price, shipping_fee, status, order_type, receive_method, paid, paid_note, source')
      .or(c?.phone ? `customer_phone.eq.${String(c.phone).replace(/\D/g, '')},customer_id.eq.${ctx.params.id}` : `customer_id.eq.${ctx.params.id}`)
      .order('delivery_date', { ascending: false }).limit(200),
  ]);
  if (led.error) return NextResponse.json({ error: led.error.message }, { status: 500 });
  if (ord.error) return NextResponse.json({ error: ord.error.message }, { status: 500 });
  return NextResponse.json({ ok: true, rows: led.data || [], orders: ord.data || [], payer_names: c?.payer_names || [], memo: c?.memo || null,
    label: c?.prepaid_label || null, banchan: Number(c?.prepaid_banchan) || 0 });
}
