import type { SupabaseClient } from '@supabase/supabase-js';
import { notifyError } from './notify';

/*
  선결제 장부에 한 줄 남긴다 (표: baby_food_prepaid_ledger, 2026-11-13).

  사장님: "기록은 쌓여야 되고 선결제도 전부 잘 정리되어 있어야 돼, 오류 없이"

  잔액(baby_food_customers.prepaid_balance)이 바뀌는 모든 곳에서 부른다 —
    충전 /api/customers/[id]/prepaid · 사용 /api/orders · 환불 lib/orderCancel ·
    수정 /api/admin/order-edit (두 군데)
  잔액을 바꾼 '다음에' 부르고, balance_after 에는 바꾼 뒤의 값을 넣는다.
  마지막 줄의 balance_after 가 고객 표의 잔액과 같아야 한다 — 다르면 어딘가 장부 없이 바뀐 것이다.

  ⚠️ 장부 쓰기가 실패해도 이미 바뀐 잔액을 되돌리지는 않는다(주문은 이미 들어갔다).
     대신 조용히 넘기지 않고 텔레그램으로 알린다 — 빈 줄을 나중에 손으로 채울 수 있게.
*/
export type LedgerKind = '충전' | '사용' | '환불' | '수정';

export async function recordPrepaid(sb: SupabaseClient, e: {
  customerId: string | null;
  phone?: string | null;
  babyName?: string | null;
  kind: LedgerKind;
  packs: number;            // + 늘어남 / − 줄어듦
  balanceAfter: number;
  amountWon?: number | null;
  orderId?: string | null;
  memo?: string | null;
  item?: '이유식' | '반찬' | '택배'; // 반찬·택배비 선결제는 팩이 아니라 '회'로 센다 (기본 이유식)
}): Promise<void> {
  if (!e.packs) return;
  try {
    const { error } = await sb.from('baby_food_prepaid_ledger').insert({
      customer_id: e.customerId, phone: e.phone ?? null, baby_name: e.babyName ?? null,
      kind: e.kind, packs: e.packs, balance_after: e.balanceAfter,
      amount_won: e.amountWon ?? null, order_id: e.orderId ?? null, memo: e.memo ?? null,
      item: e.item || '이유식',
    });
    if (error) throw error;
  } catch (err) {
    void notifyError('prepaid-ledger', err, {
      단계: '선결제 장부 기록 실패 (잔액은 이미 바뀜)',
      아기: e.babyName ?? undefined, 종류: e.kind, 팩: e.packs, 잔액: e.balanceAfter, 주문: e.orderId ?? undefined,
    });
  }
}
