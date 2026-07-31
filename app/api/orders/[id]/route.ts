import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';

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
    .select('id, status, order_type, total_qty, points_used, points_earned, customer_phone')
    .eq('id', id).single();
  if (!order) return NextResponse.json({ error: '주문 없음' }, { status: 404 });

  const becomingCancelled = status === '취소' && order.status !== '취소';
  const uncancelling = order.status === '취소' && status !== '취소';

  const { error } = await sb.from('baby_food_orders').update({ status }).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 취소/취소취소(복구) 시 선결제 잔여팩·포인트 사용·포인트 적립을 정확히 되돌림 — 실패해도 상태변경 자체는 유지(로그만)
  if (becomingCancelled || uncancelling) {
    const sign = becomingCancelled ? 1 : -1; // 취소=되돌려줌(+), 복구=다시 차감(-)
    try {
      if (order.order_type === '선결제') {
        const { data: cust } = await sb
          .from('baby_food_customers').select('id, prepaid_balance').eq('phone', order.customer_phone).maybeSingle();
        if (cust) {
          const next = Math.max(0, (cust.prepaid_balance || 0) + sign * order.total_qty);
          await sb.from('baby_food_customers').update({ prepaid_balance: next }).eq('id', cust.id);
        }
      } else if ((order.points_used || 0) > 0 || (order.points_earned || 0) > 0) {
        const { data: cust } = await sb
          .from('baby_food_customers').select('id, points').eq('phone', order.customer_phone).maybeSingle();
        if (cust) {
          // 취소: 썼던 포인트는 환불(+), 적립됐던 포인트는 회수(-) / 복구: 반대
          const delta = sign * (order.points_used || 0) - sign * (order.points_earned || 0);
          const next = Math.max(0, (cust.points || 0) + delta);
          await sb.from('baby_food_customers').update({ points: next }).eq('id', cust.id);
        }
      }
    } catch (e) { console.error('[order cancel reversal]', e); }
  }

  return NextResponse.json({ ok: true });
}
