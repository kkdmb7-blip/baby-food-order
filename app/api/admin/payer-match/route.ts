import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';
import { rematchDeposits, paidNoteFor } from '@/lib/deposits';
import { nameKey } from '@/lib/depositMatch';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f-]{36}$/i;

/*
  POST /api/admin/payer-match — 입금 탭 ▸ 판에서 엄마·아빠 이름 넣고 그 이름 입금 찾기
  2026-11-14 사장님: "김유건 화살표 누르면 엄마 이름도 추가 가능하게, 입금내역에 있으면 빼 줘"

  { order_id, name }               → 손님 카드 입금자 이름에 넣고, 입금 다시 맞추기(금액 맞으면 자동 입금확인).
                                     그래도 안 맞으면 그 이름으로 온 아직 정리 안 된 입금을 후보로 돌려준다.
  { order_id, deposit_id }         → 그 입금으로 이 주문 입금확인 (입금 줄은 '수동확인' 으로 정리)
*/
export async function POST(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const oid = String(b.order_id || '');
  if (!UUID.test(oid)) return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  const sb = supabaseService();
  const cols = 'id, baby_name, customer_id, customer_phone, total_price, shipping_fee, paid, paid_note, status, delivery_date';
  const { data: o } = await sb.from('baby_food_orders').select(cols).eq('id', oid).single();
  if (!o) return NextResponse.json({ ok: false, error: '주문 없음' }, { status: 404 });

  // ── 그 입금으로 확인
  if (b.deposit_id) {
    if (!UUID.test(String(b.deposit_id))) return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
    if (o.paid) return NextResponse.json({ ok: false, error: `이미 입금확인된 주문이에요 (${o.paid_note || ''})` }, { status: 409 });
    const { data: d } = await sb.from('baby_food_deposits').select('*').eq('id', b.deposit_id).single();
    if (!d) return NextResponse.json({ ok: false, error: '입금 없음' }, { status: 404 });
    if (!['모름', '확인필요'].includes(d.status)) return NextResponse.json({ ok: false, error: `이미 정리된 입금이에요 (${d.status})` }, { status: 409 });
    const paid_note = paidNoteFor(d, '사장님 확인');
    const { data: row, error } = await sb.from('baby_food_orders').update({ paid: true, paid_at: d.deposited_at, paid_note })
      .eq('id', oid).eq('paid', false).select('*').single();
    if (error || !row) return NextResponse.json({ ok: false, error: error?.message || '주문을 못 바꿨어요' }, { status: 500 });
    await sb.from('baby_food_deposits').update({
      status: '수동확인', order_ids: [oid], suggested_ids: [], customer_phone: o.customer_phone || null,
      confirmed_at: new Date().toISOString(), note: `사장님 확인 (입금 탭 ▸ 판)${d.note ? ` (처음 판단: ${d.status} — ${d.note})` : ''}`,
    }).eq('id', d.id);
    return NextResponse.json({ ok: true, row });
  }

  // ── 이름 넣기 + 다시 맞추기
  const name = String(b.name || '').replace(/[^가-힣A-Za-z]/g, '').slice(0, 10);
  if (name.length < 2) return NextResponse.json({ ok: false, error: '이름을 두 글자 넘게 적어 주세요' }, { status: 400 });
  const cq = sb.from('baby_food_customers').select('id, phone, payer_names');
  const { data: c } = o.customer_id ? await cq.eq('id', o.customer_id).maybeSingle()
    : o.customer_phone ? await cq.eq('phone', o.customer_phone).maybeSingle() : { data: null };
  if (!c) return NextResponse.json({ ok: false, error: '손님 카드가 없어요 — 먼저 카드를 이어 주세요' }, { status: 404 });
  const list: string[] = c.payer_names || [];
  const names = list.includes(name) ? list : [...list, name].slice(0, 10);
  if (names !== list) {
    const { error } = await sb.from('baby_food_customers').update({ payer_names: names }).eq('id', c.id);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  let auto = 0;
  try { auto = (await rematchDeposits(sb)).auto; } catch { /* 맞추기 실패해도 이름은 저장됐다 — 아래 후보로 */ }
  const { data: now } = await sb.from('baby_food_orders').select('*').eq('id', oid).single();
  const since = new Date(Date.now() - 60 * 864e5).toISOString();
  const { data: deps } = await sb.from('baby_food_deposits').select('id, deposited_at, depositor, amount, status')
    .in('status', ['모름', '확인필요']).gte('deposited_at', since).order('deposited_at', { ascending: false }).limit(600);
  const k = nameKey(name);
  const want = (Number(o.total_price) || 0) + (Number(o.shipping_fee) || 0);
  const candidates = (deps || []).filter(d => nameKey(d.depositor).includes(k))
    .map(d => ({ ...d, same: Number(d.amount) === want })).slice(0, 10);
  return NextResponse.json({ ok: true, payer_names: names, customer_id: c.id, auto, row: now, candidates, want, phoneless: !c.phone });
}
