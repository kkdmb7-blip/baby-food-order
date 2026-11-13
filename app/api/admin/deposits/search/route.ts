import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// GET ?q=이름&date=YYYY-MM-DD — 입금에 붙일 주문 찾기. 이름(일부) 또는 입금자 이름(손님 카드), 그 날 앞뒤 3주.
export async function GET(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const q = (req.nextUrl.searchParams.get('q') || '').replace(/[%_,()]/g, '').trim().slice(0, 20);
  const date = req.nextUrl.searchParams.get('date') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ ok: false, error: 'date' }, { status: 400 });
  const add = (n: number) => new Date(Date.parse(date + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const sb = supabaseService();
  let query = sb.from('baby_food_orders')
    .select('id, baby_name, delivery_date, customer_phone, total_price, shipping_fee, total_qty, stage, volume, delivery_method, paid, paid_note, status')
    .gte('delivery_date', add(-21)).lte('delivery_date', add(21)).neq('status', '취소')
    .order('delivery_date').limit(120);
  if (q) {
    const { data: cs } = await sb.from('baby_food_customers').select('phone').contains('payer_names', [q]);
    const phones = (cs || []).map(c => c.phone).filter(Boolean); // 번호 없는 손님 카드는 건너뛴다
    query = phones.length
      ? query.or(`baby_name.ilike.%${q}%,customer_phone.in.(${phones.join(',')})`)
      : query.ilike('baby_name', `%${q}%`);
  }
  const { data, error } = await query;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, orders: data || [] });
}
