import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';

// GET /api/my?phone=01012345678&name=아기이름
// 손님 본인 주문 조회 — 전화번호 + 아기 이름 2요소 확인 (배송상태 D + 선결제 ⑦)
const norm = (s: string) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');

export async function GET(req: NextRequest) {
  const p = new URL(req.url).searchParams;
  const phone = String(p.get('phone') || '').replace(/\D/g, '');
  const name = norm(p.get('name') || '');
  if (!/^\d{10,11}$/.test(phone)) {
    return NextResponse.json({ ok: false, error: '연락처를 확인해주세요' }, { status: 400 });
  }
  if (!name) {
    return NextResponse.json({ ok: false, error: '아기 이름을 입력해주세요' }, { status: 400 });
  }

  const sb = supabaseService();

  const { data: orders, error } = await sb
    .from('baby_food_orders')
    .select('id, created_at, delivery_date, stage, volume, items, total_qty, total_price, status, order_type, allergies, baby_name')
    .eq('customer_phone', phone)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('[my GET]', error);
    return NextResponse.json({ ok: false, error: '조회 실패' }, { status: 500 });
  }

  const { data: customer } = await sb
    .from('baby_food_customers')
    .select('baby_name, prepaid_balance, is_regular, regular_schedule, points, postal_code')
    .eq('phone', phone)
    .maybeSingle();

  // 2요소 확인: 전화번호에 연결된 아기 이름과 일치해야 함
  const knownNames = new Set<string>();
  (orders || []).forEach(o => { if (o.baby_name) knownNames.add(norm(o.baby_name)); });
  if (customer?.baby_name) knownNames.add(norm(customer.baby_name));

  if (knownNames.size > 0 && !knownNames.has(name)) {
    // 이름 불일치 — 존재 여부를 노출하지 않도록 빈 결과 반환
    return NextResponse.json({ ok: true, orders: [], customer: null, mismatch: true });
  }

  // 응답에서 baby_name 제거 (불필요 노출 최소화)
  const cleanOrders = (orders || []).map(({ baby_name, ...rest }) => rest);
  return NextResponse.json({ ok: true, orders: cleanOrders, customer: customer || null });
}
