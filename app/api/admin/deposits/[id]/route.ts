import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';
import { paidNoteFor, rememberPayer } from '@/lib/deposits';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f-]{36}$/i;

/*
  PATCH — 사장님이 입금 하나를 정리한다.
    { action: 'confirm', order_ids: [...], save_payer?: true }  이 주문들 돈이 맞다 → 입금확인
    { action: 'unlink' }                                         짝 풀기 → 주문은 미입금으로, 입금은 '모름'
    { action: 'status', status: '무관'|'선결제'|'모름'|'확인필요', note? }   손님 돈 아님 / 선결제 / 다시 모름 / 나중에 볼 것
    { action: 'memo', note }                                     메모만 고치기
  입금 줄은 절대 지우지 않는다. 바꾼 사람이 사장님이라는 표시(confirmed_at)를 남긴다.
*/
export async function PATCH(req: NextRequest, ctx: { params: { id: string } }) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const id = ctx.params.id;
  if (!UUID.test(id)) return NextResponse.json({ ok: false, error: 'invalid id' }, { status: 400 });
  const b = await req.json().catch(() => ({}));
  const sb = supabaseService();
  const { data: d } = await sb.from('baby_food_deposits').select('*').eq('id', id).single();
  if (!d) return NextResponse.json({ ok: false, error: '입금 없음' }, { status: 404 });

  // 이 입금으로 입금확인 했던 주문을 되돌린다 (다른 입금으로 확인된 건 건드리지 않는다)
  async function release(ids: string[]) {
    if (!ids.length) return;
    const { data: os } = await sb.from('baby_food_orders').select('id, paid_note, delivery_date').in('id', ids);
    const mine = (os || []).filter(o => String(o.paid_note || '').startsWith(`입금 ${d.depositor} `)).map(o => o.id);
    if (mine.length) await sb.from('baby_food_orders').update({ paid: false, paid_at: null, paid_note: null }).in('id', mine);
  }

  if (b.action === 'confirm') {
    const ids: string[] = Array.isArray(b.order_ids) ? b.order_ids.filter((x: any) => UUID.test(String(x))) : [];
    if (ids.length === 0) return NextResponse.json({ ok: false, error: '주문을 골라주세요' }, { status: 400 });
    const { data: os } = await sb.from('baby_food_orders').select('id, customer_phone, paid, paid_note').in('id', ids);
    const taken = (os || []).filter(o => o.paid && !String(o.paid_note || '').startsWith(`입금 ${d.depositor} `) && !String(o.paid_note || '').startsWith('대조안함'));
    if (taken.length && !b.force) {
      return NextResponse.json({ ok: false, error: `이미 입금확인된 주문이 ${taken.length}건 있어요 — ${taken.map(o => o.paid_note || '직접 체크').join(' / ')}`, need_force: true }, { status: 409 });
    }
    await release((d.order_ids || []).filter((x: string) => !ids.includes(x)));
    const { error } = await sb.from('baby_food_orders')
      .update({ paid: true, paid_at: d.deposited_at, paid_note: paidNoteFor(d, '사장님 확인') }).in('id', ids);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    const phones = [...new Set((os || []).map(o => o.customer_phone).filter(Boolean))];
    let saved: string | null = null;
    if (b.save_payer) saved = await rememberPayer(sb, phones, d.depositor, d.deposited_at);
    await sb.from('baby_food_deposits').update({
      status: '수동확인', order_ids: ids, suggested_ids: [], customer_phone: phones.length === 1 ? phones[0] : null,
      confirmed_at: new Date().toISOString(),
      note: `사장님 확인` + (saved ? ` · 입금자 '${saved}' 손님 카드에 저장` : '') + (d.note ? ` (처음 판단: ${d.status} — ${d.note})` : ''),
    }).eq('id', id);
    return NextResponse.json({ ok: true, saved_payer: saved });
  }

  if (b.action === 'unlink') {
    await release(d.order_ids || []);
    await sb.from('baby_food_deposits').update({
      status: '모름', order_ids: [], confirmed_at: new Date().toISOString(),
      note: `사장님이 짝을 풀었음 (전: ${d.status} — ${d.note || ''})`,
    }).eq('id', id);
    return NextResponse.json({ ok: true });
  }

  // 메모만 고친다 — 상태·짝은 그대로
  if (b.action === 'memo') {
    const memo = String(b.note ?? '').trim().slice(0, 300);
    await sb.from('baby_food_deposits').update({ note: memo || null, confirmed_at: new Date().toISOString() }).eq('id', id);
    return NextResponse.json({ ok: true });
  }

  if (b.action === 'status' && ['무관', '선결제', '모름', '확인필요'].includes(b.status)) {
    await release(d.order_ids || []);
    const memo = String(b.note || '').trim().slice(0, 200);
    await sb.from('baby_food_deposits').update({
      status: b.status, order_ids: [], confirmed_at: new Date().toISOString(),
      note: `사장님: ${b.status}${memo ? ` — ${memo}` : ''} (전: ${d.status})`,
    }).eq('id', id);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 });
}
