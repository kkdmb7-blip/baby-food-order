import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';
import { applyCancelReversal } from '@/lib/orderCancel';
import { sendStatusPush, statusPushText } from '@/lib/push';

const STATUSES = ['접수', '준비중', '배송완료', '취소'];

export async function PATCH(req: NextRequest, ctx: { params: { id: string } }) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const id = ctx.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const { status } = await req.json().catch(() => ({}));
  if (!STATUSES.includes(status)) return NextResponse.json({ error: 'invalid status' }, { status: 400 });

  const sb = supabaseService();

  const { data: order } = await sb
    .from('baby_food_orders')
    .select('id, status, order_type, total_qty, points_used, points_earned, customer_phone, delivery_date')
    .eq('id', id).single();
  if (!order) return NextResponse.json({ error: '주문 없음' }, { status: 404 });

  const becomingCancelled = status === '취소' && order.status !== '취소';
  const uncancelling = order.status === '취소' && status !== '취소';
  const statusChanged = status !== order.status;

  // eq('status', order.status)로 "내가 읽은 상태 그대로일 때만" 바뀌게 해서, 관리자 화면 이중클릭
  // 이나 두 기기에서 동시에 상태를 바꿀 때 취소 환불(applyCancelReversal)이 두 번 실행되는 걸 막음.
  const { data: updated, error } = await sb
    .from('baby_food_orders').update({ status })
    .eq('id', id).eq('status', order.status).select('id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: '다른 곳에서 이미 상태가 변경됐어요 — 새로고침 후 다시 시도해주세요' }, { status: 409 });
  }

  if (becomingCancelled) await applyCancelReversal(sb, order, 1);
  else if (uncancelling) await applyCancelReversal(sb, order, -1);

  if (statusChanged) {
    const text = statusPushText(status, order.delivery_date);
    if (text) void sendStatusPush(sb, order.customer_phone, text.title, text.body);
  }

  return NextResponse.json({ ok: true });
}
