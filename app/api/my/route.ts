import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';

// GET /api/my?phone=01012345678
// 손님 본인 주문 조회 (전화번호 게이트) — 배송상태 추적(D) + 선결제 잔액(⑦)
export async function GET(req: NextRequest) {
  const phone = String(new URL(req.url).searchParams.get('phone') || '').replace(/\D/g, '');
  if (!/^\d{10,11}$/.test(phone)) {
    return NextResponse.json({ ok: false, error: '연락처를 확인해주세요' }, { status: 400 });
  }

  const sb = supabaseService();

  // 최근 주문 (배송상태 포함)
  const { data: orders, error } = await sb
    .from('baby_food_orders')
    .select('id, created_at, delivery_date, stage, volume, items, total_qty, total_price, status, order_type, allergies')
    .eq('customer_phone', phone)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('[my GET]', error);
    return NextResponse.json({ ok: false, error: '조회 실패' }, { status: 500 });
  }

  // 선결제/정기 고객 정보 (없을 수 있음)
  const { data: customer } = await sb
    .from('baby_food_customers')
    .select('baby_name, prepaid_balance, is_regular, regular_schedule, points')
    .eq('phone', phone)
    .maybeSingle();

  return NextResponse.json({ ok: true, orders: orders || [], customer: customer || null });
}
