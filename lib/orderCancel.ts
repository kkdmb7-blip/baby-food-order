import type { SupabaseClient } from '@supabase/supabase-js';
import { recordPrepaid } from './prepaidLedger';
import { movePrepaidMany, orderKinds, kindTag } from './prepaidSplit';
import { deductShip, refundShip, shipUnitsIn, stripShip } from './prepaidShip';

type CancelableOrder = {
  id?: string;
  baby_name?: string;
  order_type: string;
  total_qty: number;
  points_used: number | null;
  points_earned: number | null;
  customer_phone: string;
  customer_id?: string | null;
  stage?: string | null;
  volume?: number | null;
  items?: any;               // 용량 섞인 주문은 세트별로 묶음을 나눠 돌려준다 (lib/prepaidSplit orderKinds)
  paid_note?: string | null;
};

// 입금 탭 '선결제에서 빼기'가 남긴 표시 — app/api/admin/order-prepaid 와 같은 모양
const PANEL_RE = /^선결제 차감 (\d+)(팩|회) \(입금 탭/;

// 취소(+1)/취소복구(-1) 시 선결제 잔여팩·포인트 사용·포인트 적립을 정확히 되돌림.
// 취소: 썼던 포인트 환불(+), 적립됐던 포인트 회수(-) / 복구: 반대.
//
// ⚠️ 예전엔 읽고 그대로 덮어써서, 같은 주문이 (관리자 이중클릭·중복 API 호출 등으로) 거의
// 동시에 두 번 취소 처리되면 잔액/포인트가 두 번 환불되는 문제가 있었음 — 선결제 차감 때 쓰던
// "내가 읽은 값 그대로일 때만" 갱신하는 CAS 패턴을 여기도 적용하고, 값이 그 사이 바뀌었으면
// 최신값으로 다시 읽어 재시도함(취소 복구는 반드시 반영돼야 하므로 실패해도 포기하지 않음).
// 손님 카드 — 주문에 이어진 카드(customer_id)가 먼저, 없으면 연락처. 번호 없는 손님(택배·픽업)도 찾게.
async function custIdOf(sb: SupabaseClient, order: CancelableOrder): Promise<string | null> {
  if (order.customer_id) return order.customer_id;
  if (!order.customer_phone) return null;
  return (await sb.from('baby_food_customers').select('id').eq('phone', order.customer_phone).maybeSingle()).data?.id ?? null;
}

export async function applyCancelReversal(sb: SupabaseClient, order: CancelableOrder, sign: 1 | -1) {
  try {
    const panel = String(order.paid_note || '').match(PANEL_RE);
    if (order.order_type === '선결제') {
      const cid = await custIdOf(sb, order);
      if (cid) {
        // 여러 단계 선결제면 그 주문 단계·용량의 묶음으로 돌려준다 (lib/prepaidSplit)
        const r = await movePrepaidMany(sb, cid, orderKinds(order).map(x => ({ kind: x.kind, delta: sign * x.qty })));
        if (r.ok) {
          // 장부 — 취소면 팩이 돌아오고(환불), 취소를 되돌리면 다시 빠진다(사용)
          await recordPrepaid(sb, {
            customerId: cid, phone: order.customer_phone, babyName: order.baby_name,
            kind: sign > 0 ? '환불' : '사용', packs: r.after - r.before, balanceAfter: r.after,
            orderId: order.id ?? null, memo: `${kindTag(r)}${sign > 0 ? '주문 취소' : '취소한 주문을 되살림'}`,
          });
        }
        // 택배비 선결제 — 취소면 그 주문에서 뺀 회수를 돌려주고 표시를 지운다, 되살리면 다시 뺀다 (lib/prepaidShip)
        if (order.id) {
          if (sign > 0 && shipUnitsIn(order.paid_note)) {
            await refundShip(sb, cid, order.id, order.paid_note, '주문 취소');
            await sb.from('baby_food_orders').update({ paid_note: stripShip(String(order.paid_note)) || null }).eq('id', order.id);
          } else if (sign < 0) {
            const tail = await deductShip(sb, cid, order.id);
            if (tail) await sb.from('baby_food_orders').update({ paid_note: (stripShip(String(order.paid_note || '')) + tail).trim() }).eq('id', order.id);
          }
        }
      }
    } else if (panel && sign > 0 && order.id) {
      // 입금 탭에서 선결제로 뺀 주문(paid_note '선결제 차감 N팩 (입금 탭 …') 을 취소 → 그 팩·회를 돌려주고 표시를 지운다.
      // 취소를 되살리면 미입금 주문으로 돌아온다 — 다시 빼려면 입금 탭에서 '선결제에서 빼기'.
      const qty = Number(panel[1]); const banchan = panel[2] === '회';
      const cid = await custIdOf(sb, order);
      if (cid && qty > 0) {
        let after: number | null = null; let tag = '';
        if (banchan) {
          for (let i = 0; i < 3 && after === null; i++) {
            const { data: c } = await sb.from('baby_food_customers').select('prepaid_banchan').eq('id', cid).maybeSingle();
            if (!c) break;
            const base = Number(c.prepaid_banchan) || 0;
            const { data: up } = await sb.from('baby_food_customers').update({ prepaid_banchan: base + qty }).eq('id', cid).eq('prepaid_banchan', base).select('id');
            if (up?.length) after = base + qty;
          }
        } else {
          const r = await movePrepaidMany(sb, cid, (orderKinds(order).reduce((s, x) => s + x.qty, 0) === qty ? orderKinds(order) : [{ kind: orderKinds(order)[0].kind, qty }]).map(x => ({ kind: x.kind, delta: x.qty })));
          if (r.ok) { after = r.after; tag = kindTag(r); }
        }
        if (after !== null) {
          await refundShip(sb, cid, order.id, order.paid_note, '주문 취소');
          await sb.from('baby_food_orders').update({ paid: false, paid_at: null, paid_note: `선결제 돌려놓음 ${qty}${banchan ? '회' : '팩'} (주문 취소)` }).eq('id', order.id);
          await recordPrepaid(sb, {
            customerId: cid, phone: order.customer_phone, babyName: order.baby_name,
            kind: '환불', packs: qty, balanceAfter: after, orderId: order.id, item: banchan ? '반찬' : '이유식',
            memo: `${tag}주문 취소 — 입금 탭에서 뺀 ${qty}${banchan ? '회' : '팩'} 돌려놓음`,
          });
        }
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
