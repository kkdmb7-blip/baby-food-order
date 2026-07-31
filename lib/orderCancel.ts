import type { SupabaseClient } from '@supabase/supabase-js';

type CancelableOrder = {
  order_type: string;
  total_qty: number;
  points_used: number | null;
  points_earned: number | null;
  customer_phone: string;
};

// 취소(+1)/취소복구(-1) 시 선결제 잔여팩·포인트 사용·포인트 적립을 정확히 되돌림.
// 취소: 썼던 포인트 환불(+), 적립됐던 포인트 회수(-) / 복구: 반대.
export async function applyCancelReversal(sb: SupabaseClient, order: CancelableOrder, sign: 1 | -1) {
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
        const delta = sign * (order.points_used || 0) - sign * (order.points_earned || 0);
        const next = Math.max(0, (cust.points || 0) + delta);
        await sb.from('baby_food_customers').update({ points: next }).eq('id', cust.id);
      }
    }
  } catch (e) { console.error('[order cancel reversal]', e); }
}
