import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';
import { applyCancelReversal } from '@/lib/orderCancel';
import { sendStatusPush, statusPushText } from '@/lib/push';

const norm = (s: string) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');

// POST /api/my/cancel — 손님 본인 주문 취소 ('접수' 상태일 때만, 2요소 확인)
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const orderId = String(b.order_id || '');
    const phone = String(b.phone || '').replace(/\D/g, '');
    const name = norm(b.baby_name || '');
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) return bad('잘못된 요청');
    if (!/^\d{10,11}$/.test(phone)) return bad('연락처를 확인해주세요');
    if (!name) return bad('아기 이름을 입력해주세요');

    const sb = supabaseService();
    const { data: order } = await sb
      .from('baby_food_orders')
      .select('id, status, order_type, total_qty, points_used, points_earned, customer_phone, baby_name, delivery_date')
      .eq('id', orderId).single();
    if (!order) return bad('주문을 찾을 수 없어요');
    if (order.customer_phone !== phone || norm(order.baby_name) !== name) return bad('본인 주문만 취소할 수 있어요');
    if (order.status !== '접수') return bad('이미 준비가 시작된 주문은 취소할 수 없어요. 문의해주세요.');

    const { error } = await sb.from('baby_food_orders').update({ status: '취소' }).eq('id', orderId);
    if (error) return NextResponse.json({ ok: false, error: 'DB 저장 실패' }, { status: 500 });

    await applyCancelReversal(sb, order, 1);
    const text = statusPushText('취소', order.delivery_date);
    if (text) void sendStatusPush(sb, order.customer_phone, text.title, text.body);

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ ok: false, error: '잘못된 요청' }, { status: 400 });
  }
}

function bad(msg: string) {
  return NextResponse.json({ ok: false, error: msg }, { status: 400 });
}
