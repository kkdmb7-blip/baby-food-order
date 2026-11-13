import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';
import { parseBankFile } from '@/lib/bankParse';
import { rematchDeposits } from '@/lib/deposits';

export const dynamic = 'force-dynamic';
const ORDER_COLS = 'id, baby_name, delivery_date, customer_phone, total_price, shipping_fee, total_qty, stage, volume, delivery_method, paid, paid_note, status, source';

// GET — 입금 목록(최근 600줄) + 거기 걸린 주문 요약
export async function GET() {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const sb = supabaseService();
  const { data: deps, error } = await sb.from('baby_food_deposits').select('*')
    .order('deposited_at', { ascending: false }).limit(600);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const ids = [...new Set((deps || []).flatMap(d => [...(d.order_ids || []), ...(d.suggested_ids || [])]))];
  const orders: any[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error: e2 } = await sb.from('baby_food_orders').select(ORDER_COLS).in('id', ids.slice(i, i + 150));
    if (e2) return NextResponse.json({ ok: false, error: e2.message }, { status: 500 });
    orders.push(...(data || []));
  }
  // 입금 대조 기간 안인데 아직 입금 확인 안 된 주문 — "돈이 안 들어온 것 같은 주문"
  let unpaid: any[] = [];
  if (deps && deps.length) {
    const kst = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10);
    const first = kst(deps[deps.length - 1].deposited_at), last = kst(deps[0].deposited_at);
    const { data } = await sb.from('baby_food_orders').select(ORDER_COLS)
      .gte('delivery_date', first).lte('delivery_date', last)
      .eq('paid', false).neq('status', '취소').neq('order_type', '선결제').order('delivery_date');
    unpaid = (data || []).filter(o => !o.paid_note);
  }
  return NextResponse.json({ ok: true, deposits: deps || [], orders, unpaid });
}

// POST — 은행 거래내역 파일 올리기 (multipart 'file'). 이미 있는 입금은 건너뛴다(같은 시각·이름·금액·잔액).
export async function POST(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const sb = supabaseService();
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (form?.get('rematch') === '1' && !file) {
    try { return NextResponse.json({ ok: true, ...(await rematchDeposits(sb)) }); }
    catch (e: any) { return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 }); }
  }
  if (!file || typeof file === 'string') return NextResponse.json({ ok: false, error: '파일이 없어요' }, { status: 400 });
  if (file.size > 5 * 1024 * 1024) return NextResponse.json({ ok: false, error: '파일이 너무 커요' }, { status: 400 });

  const { rows, error } = parseBankFile(Buffer.from(await file.arrayBuffer()));
  if (error) return NextResponse.json({ ok: false, error }, { status: 400 });
  if (rows.length === 0) return NextResponse.json({ ok: false, error: '입금 줄이 없어요' }, { status: 400 });

  const { data: ins, error: e1 } = await sb.from('baby_food_deposits')
    .upsert(rows.map(r => ({ ...r, source: file.name })), { onConflict: 'deposited_at,depositor,amount,balance_after', ignoreDuplicates: true })
    .select('id');
  if (e1) return NextResponse.json({ ok: false, error: e1.message }, { status: 500 });
  try {
    const m = await rematchDeposits(sb);
    return NextResponse.json({ ok: true, inFile: rows.length, added: ins?.length ?? 0, ...m });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: `올리기는 됐는데 맞춰보다 멈췄어요: ${e?.message || e}` }, { status: 500 });
  }
}
