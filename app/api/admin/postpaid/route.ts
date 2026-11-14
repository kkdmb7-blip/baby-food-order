import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/*
  후불 손님 — 먹고 나중에 한꺼번에 내는 집 (2026-11-14 사장님: 고우리)
  GET  → 후불 손님마다 아직 안 받은 주문(날짜·금액)과 합계
  POST { customer_id, order_ids } → 그 주문들을 입금확인('후불 정산 …')
  오픈월드·선결제로 뺀 주문은 받을 돈이 아니라 빼고, 엑셀 시절('대조안함') 주문은 넣되 표시한다.
*/
const due = (o: any) => (Number(o.total_price) || 0) + (Number(o.shipping_fee) || 0);

async function ordersOf(sb: any, c: { id: string; phone: string | null }) {
  let q = sb.from('baby_food_orders')
    .select('id, delivery_date, stage, volume, total_qty, total_price, shipping_fee, paid, paid_note, status, order_type')
    .eq('paid', false).neq('status', '취소').neq('order_type', '선결제').order('delivery_date').limit(300);
  q = c.phone ? q.or(`customer_id.eq.${c.id},customer_phone.eq.${c.phone}`) : q.eq('customer_id', c.id);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).filter((o: any) => !o.paid_note || String(o.paid_note).startsWith('대조안함'));
}

export async function GET() {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const sb = supabaseService();
  const { data: cs, error } = await sb.from('baby_food_customers').select('id, baby_name, phone').eq('postpaid', true).order('baby_name');
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  try {
    const list = [];
    for (const c of cs || []) {
      const os = await ordersOf(sb, c);
      list.push({ id: c.id, baby_name: c.baby_name, orders: os.map((o: any) => ({ id: o.id, date: o.delivery_date, qty: o.total_qty, won: due(o), excel: String(o.paid_note || '').startsWith('대조안함') })), total: os.reduce((s: number, o: any) => s + due(o), 0) });
    }
    return NextResponse.json({ ok: true, list });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const cid = String(b.customer_id || '');
  const ids: string[] = Array.isArray(b.order_ids) ? b.order_ids.map(String).filter((x: string) => /^[0-9a-f-]{36}$/i.test(x)) : [];
  if (!/^[0-9a-f-]{36}$/i.test(cid) || !ids.length) return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  const sb = supabaseService();
  const { data: c } = await sb.from('baby_food_customers').select('id, phone, postpaid').eq('id', cid).maybeSingle();
  if (!c?.postpaid) return NextResponse.json({ ok: false, error: '후불 손님이 아니에요' }, { status: 400 });
  // 이 손님의 받을 주문 중에서만 — 다른 집 주문이 섞여 들어오지 않게
  const mine = new Map((await ordersOf(sb, c)).map((o: any) => [o.id, o]));
  const pick = ids.filter(id => mine.has(id));
  if (!pick.length) return NextResponse.json({ ok: false, error: '정산할 주문이 없어요' }, { status: 400 });
  const total = pick.reduce((s, id) => s + due(mine.get(id)), 0);
  const k = new Date(Date.now() + 9 * 3600e3).toISOString();
  const paid_note = `후불 정산 ${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))} (${pick.length}건 ${total.toLocaleString('ko-KR')}원, 사장님 확인)`;
  const { data: up, error } = await sb.from('baby_food_orders').update({ paid: true, paid_at: new Date().toISOString(), paid_note })
    .in('id', pick).eq('paid', false).select('id');
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, ids: (up || []).map((x: any) => x.id), paid_note, total });
}
