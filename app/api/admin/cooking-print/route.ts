import { NextRequest, NextResponse } from 'next/server';
import { supabaseService, type Order } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';
import { orderDates, slicesOn, shiftDate } from '@/lib/orderItems';

/*
  조리표를 언제 뽑았는지 적고, 그 뒤에 들어온 주문이 몇 건인지 센다.

  왜
    오전 7시에 조리표를 뽑으시고, 그 뒤에 오는 주문은 종이에 손으로 적으셨다.
    앱이 뽑은 시각을 알면 "그 뒤에 들어온 줄" 만 따로 뽑아드릴 수 있다.
    그러면 손으로 적는 일이 없어지고, 그 주문도 배송·주소록·입금 대조에 같이 올라탄다.

  GET  ?date=YYYY-MM-DD  — 뽑은 시각과 그 뒤 들어온 주문 수
  POST { date }          — 지금 뽑았다고 적는다 (그 시점의 명수·팩수도 같이 남김)

  다시 뽑으면 그 시각으로 덮어쓴다. 기준은 항상 마지막 전체 프린트다.
*/

export const dynamic = 'force-dynamic';

/** 그날 조리할 주문만 골라온다 (복합주문은 delivery_date 가 아니라 items 안에 날짜가 있다). */
async function ordersOn(sb: ReturnType<typeof supabaseService>, date: string): Promise<Order[]> {
  const { data } = await sb.from('baby_food_orders').select('*')
    .gte('delivery_date', shiftDate(date, -21))
    .lte('delivery_date', shiftDate(date, 21))
    .neq('status', '취소').order('created_at').limit(500);
  return (data || []).filter(o => orderDates(o as any).includes(date)) as Order[];
}

function packsOn(orders: Order[], date: string): number {
  let n = 0;
  for (const o of orders) for (const s of slicesOn(o as any, date)) n += Number(s.qty) || 0;
  return n;
}

export async function GET(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const date = req.nextUrl.searchParams.get('date') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ ok: false, error: '날짜 형식 오류' }, { status: 400 });

  const sb = supabaseService();
  try {
    const { data: mark, error } = await sb
      .from('baby_food_cooking_prints')
      .select('printed_at, printed_orders, printed_packs')
      .eq('delivery_date', date).maybeSingle();
    // 조회 자체가 실패한 것과 "아직 안 뽑음" 은 다르다. 삼키면 매번 안 뽑은 걸로 보인다.
    if (error) throw new Error(error.message);

    if (!mark) {
      return NextResponse.json({ ok: true, printed: false, date });
    }

    const orders = await ordersOn(sb, date);
    const after = orders.filter(o => o.created_at > mark.printed_at);

    return NextResponse.json({
      ok: true,
      printed: true,
      date,
      printedAt: mark.printed_at,
      printedOrders: mark.printed_orders,
      printedPacks: mark.printed_packs,
      // 프린트 뒤에 들어온 것 — 지금까지 종이에 손으로 적으시던 줄
      newOrders: after.length,
      newPacks: packsOn(after, date),
      nowOrders: orders.length,
      nowPacks: packsOn(orders, date),
    });
  } catch (e: any) {
    console.error('[admin/cooking-print GET]', e);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const date = String(b.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ ok: false, error: '날짜 형식 오류' }, { status: 400 });

  const sb = supabaseService();
  try {
    const orders = await ordersOn(sb, date);
    const printedAt = new Date().toISOString();
    const { error } = await sb.from('baby_food_cooking_prints').upsert({
      delivery_date: date,
      printed_at: printedAt,
      printed_orders: orders.length,
      printed_packs: packsOn(orders, date),
    }, { onConflict: 'delivery_date' });
    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true, date, printedAt, printedOrders: orders.length });
  } catch (e: any) {
    console.error('[admin/cooking-print POST]', e);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
