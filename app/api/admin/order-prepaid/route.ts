import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';
import { recordPrepaid } from '@/lib/prepaidLedger';
import { movePrepaid, kindOf, kindTag } from '@/lib/prepaidSplit';

export const dynamic = 'force-dynamic';

/*
  POST /api/admin/order-prepaid  { id, use: true | false }
  입금 탭(조리표 모양)에서 그 주문을 선결제에서 빼거나(use=true) 되돌린다(use=false).
  2026-11-14 사장님: "선결제 시작한 애들 있으면 거기서 바로 수정 가능하게"

  주문 종류(order_type)는 바꾸지 않는다 —
    정기 주문을 '선결제' 로 바꾸면 정기배송 동기화가 그 날 주문이 없다고 보고 새로 만든다.
    반찬은 '선결제' 로 바꾸면 취소할 때 이유식 팩으로 환불된다(lib/orderCancel).
  그래서 입금확인(paid=true) + 근거 문구 '선결제 차감 …' 으로 표시하고, 잔액을 장부와 함께 뺀다.
  이유식 = 팩(total_qty), 반찬 세트 = 회(total_qty). 반찬 낱개는 선결제 대상이 아니다.
  ⚠️ 이렇게 뺀 주문을 나중에 취소하면 팩이 자동으로 돌아오지 않는다 — 여기서 '되돌리기' 를 먼저.
*/
const PREFIX = '선결제 차감';

export async function POST(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const id = String(b.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id) || typeof b.use !== 'boolean') return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  const sb = supabaseService();

  const { data: o } = await sb.from('baby_food_orders')
    .select('id, baby_name, stage, volume, total_qty, customer_id, customer_phone, paid, paid_note, status, order_type')
    .eq('id', id).single();
  if (!o) return NextResponse.json({ ok: false, error: '주문 없음' }, { status: 404 });
  if (o.status === '취소') return NextResponse.json({ ok: false, error: '취소된 주문이에요' }, { status: 409 });
  if (o.order_type === '선결제') return NextResponse.json({ ok: false, error: '이미 선결제로 들어온 주문이에요(주문할 때 팩을 뺐어요)' }, { status: 409 });

  const stage = String(o.stage || '');
  const banchan = stage.startsWith('반찬');
  if (stage === '반찬낱개') return NextResponse.json({ ok: false, error: '반찬 낱개는 선결제에서 뺄 수 없어요 (선결제는 세트 회수)' }, { status: 400 });
  const field = banchan ? 'prepaid_banchan' : 'prepaid_balance';
  const unit = banchan ? '회' : '팩';
  const qty = Number(o.total_qty) || 0;
  if (qty <= 0) return NextResponse.json({ ok: false, error: '수량이 없어요' }, { status: 400 });

  // 이 화면에서 뺀 것만 되돌린다 — 예전 선결제 메모('선결제 차감 — 입금 …')와 섞이지 않게 모양을 정확히 본다
  const already = /^선결제 차감 \d+(팩|회) \(입금 탭/.test(String(o.paid_note || ''));
  if (b.use && o.paid && !already) return NextResponse.json({ ok: false, error: `이미 입금확인된 주문이에요 (${o.paid_note || ''}) — 먼저 입금확인을 끄세요` }, { status: 409 });
  if (b.use && already) return NextResponse.json({ ok: false, error: '이미 선결제에서 뺐어요' }, { status: 409 });
  if (!b.use && !already) return NextResponse.json({ ok: false, error: '선결제에서 뺀 주문이 아니에요' }, { status: 409 });

  // 손님 카드 — 카드 연결(customer_id)이 먼저, 없으면 연락처
  const q = sb.from('baby_food_customers').select(`id, phone, ${field}`);
  const { data: c0 } = o.customer_id ? await q.eq('id', o.customer_id).maybeSingle()
    : o.customer_phone ? await q.eq('phone', o.customer_phone).maybeSingle() : { data: null };
  let c: any = c0;
  if (!c) return NextResponse.json({ ok: false, error: '손님 카드를 못 찾았어요' }, { status: 404 });

  const delta = b.use ? -qty : qty;
  const kind = banchan ? null : kindOf(o.stage, o.volume);
  // 읽은 값 그대로일 때만 바꾼다(두 번 눌림 방지) — 그 사이 바뀌었으면 다시 읽어 세 번까지
  // 이유식은 여러 단계 선결제면 이 주문 단계·용량의 묶음에서 (lib/prepaidSplit)
  let next = 0, partNext = 0, ok = false, tag = '', split: any = undefined;
  if (banchan) {
    for (let i = 0; i < 3 && c; i++) {
      const base = Number(c[field]) || 0;
      next = base + delta;
      if (next < 0) return NextResponse.json({ ok: false, error: `반찬 선결제가 ${base}회뿐이에요 (${qty}회 필요)` }, { status: 409 });
      const { data: up } = await sb.from('baby_food_customers').update({ [field]: next }).eq('id', c.id).eq(field, base).select('id');
      if (up && up.length) { ok = true; break; }
      c = (await sb.from('baby_food_customers').select(`id, phone, ${field}`).eq('id', c.id).maybeSingle()).data;
    }
    partNext = next;
  } else {
    const r = await movePrepaid(sb, c.id, { delta, kind });
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
    ok = true; next = r.after; partNext = r.partAfter; tag = kindTag(r); split = r.split;
  }
  if (!ok) return NextResponse.json({ ok: false, error: '잔액이 계속 바뀌어요 — 새로고침 후 다시' }, { status: 409 });

  const k = new Date(Date.now() + 9 * 3600e3).toISOString();
  const stamp = `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`;
  const patch = b.use
    ? { paid: true, paid_at: new Date().toISOString(), paid_note: `${PREFIX} ${qty}${unit} (입금 탭 ${stamp}, 남은 ${partNext}${unit})` }
    : { paid: false, paid_at: null, paid_note: null };
  const { error } = await sb.from('baby_food_orders').update(patch).eq('id', id);
  if (error) {
    // 주문 표시를 못 바꿨으면 잔액을 되돌린다 — 잔액만 빠지고 주문은 미입금으로 남으면 안 된다
    if (banchan) await sb.from('baby_food_customers').update({ [field]: next - delta }).eq('id', c.id).eq(field, next);
    else await movePrepaid(sb, c.id, { delta: -delta, kind });
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  await recordPrepaid(sb, {
    customerId: c.id, phone: c.phone, babyName: o.baby_name,
    kind: b.use ? '사용' : '환불', packs: delta, balanceAfter: next, orderId: id,
    memo: `${tag}${b.use ? '입금 탭에서 선결제로 처리' : '입금 탭에서 선결제 처리 되돌림'}`,
    item: banchan ? '반찬' : '이유식',
  });
  return NextResponse.json({ ok: true, customer_id: c.id, field, balance: next, part: partNext, kind, split: split ?? null, paid: patch.paid, paid_note: patch.paid_note });
}
