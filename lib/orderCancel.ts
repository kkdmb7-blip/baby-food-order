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
//
// ⚠️ 예전엔 읽고 그대로 덮어써서, 같은 주문이 (관리자 이중클릭·중복 API 호출 등으로) 거의
// 동시에 두 번 취소 처리되면 잔액/포인트가 두 번 환불되는 문제가 있었음 — 선결제 차감 때 쓰던
// "내가 읽은 값 그대로일 때만" 갱신하는 CAS 패턴을 여기도 적용하고, 값이 그 사이 바뀌었으면
// 최신값으로 다시 읽어 재시도함(취소 복구는 반드시 반영돼야 하므로 실패해도 포기하지 않음).
export async function applyCancelReversal(sb: SupabaseClient, order: CancelableOrder, sign: 1 | -1) {
  try {
    if (order.order_type === '선결제') {
      let cust = (await sb
        .from('baby_food_customers').select('id, prepaid_balance').eq('phone', order.customer_phone).maybeSingle()).data;
      for (let attempt = 0; cust && attempt < 3; attempt++) {
        const base = cust.prepaid_balance || 0;
        const next = Math.max(0, base + sign * order.total_qty);
        const { data: updated } = await sb
          .from('baby_food_customers').update({ prepaid_balance: next })
          .eq('id', cust.id).eq('prepaid_balance', base).select('id');
        if (updated && updated.length > 0) break;
        cust = (await sb.from('baby_food_customers').select('id, prepaid_balance').eq('id', cust.id).maybeSingle()).data;
      }
    } else if ((order.points_used || 0) > 0 || (order.points_earned || 0) > 0) {
      let cust = (await sb
        .from('baby_food_customers').select('id, points').eq('phone', order.customer_phone).maybeSingle()).data;
      for (let attempt = 0; cust && attempt < 3; attempt++) {
        const delta = sign * (order.points_used || 0) - sign * (order.points_earned || 0);
        const base = cust.points || 0;
        const next = Math.max(0, base + delta);
        const { data: updated } = await sb
          .from('baby_food_customers').update({ points: next })
          .eq('id', cust.id).eq('points', base).select('id');
        if (updated && updated.length > 0) break;
        cust = (await sb.from('baby_food_customers').select('id, points').eq('id', cust.id).maybeSingle()).data;
      }
    }
  } catch (e) { console.error('[order cancel reversal]', e); }
}
