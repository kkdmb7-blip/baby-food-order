import type { SupabaseClient } from '@supabase/supabase-js';
import { recordPrepaid } from './prepaidLedger';
import { shipTag } from './cookingSheet';

/*
  택배비 선결제 — 2026-11-14 사장님: "택배로 선결제한 아이들은 택배비 차감도 있어. 보통 30000원 10회 해서 5팩까지는 1회 차감"

  손님 카드 prepaid_ship = 남은 회수. null 이면 택배비 선결제를 안 하는 손님 → 아무것도 안 뺀다.
  택배 주문(배송 방법에 '택배', 픽업 아님)이 선결제로 빠질 때(입금 탭 빼기·한꺼번에, 선결제 주문) 회수도 같이 뺀다.

  한 상자 = 5팩까지 1회. 같은 날 같이 나가는 그 아이 택배 주문(후기+완료기 두 건 등)은 한 상자로 본다 —
    필요 회수 = ⌈(그날 이미 회수를 뺀 주문 팩 + 이 주문 팩) ÷ 5⌉ − 그날 이미 뺀 회수
  '내'(하루 보관 → 다음 날 것과 합쳐 택배) 주문은 다음 날 상자에 들어간다.
  뺀 회수는 주문 paid_note 끝에 ' · 택배 N회' 로 남긴다 — 되돌리기·취소 때 그만큼 돌려준다.
*/
import { SHIP_PACKS_PER_BOX } from './prepaidShipRules';
export { SHIP_PACKS_PER_BOX, SHIP_CHARGE } from './prepaidShipRules';
const SHIP_RE = / · 택배 (\d+)회/;

type O = {
  id: string; delivery_date: string; total_qty?: number | null; delivery_method?: string | null;
  receive_method?: string | null; memo?: string | null; paid_note?: string | null; status?: string | null;
};
export const isCourier = (o: O) => o.receive_method !== '픽업' && String(o.delivery_method || '').includes('택배');
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const shipDay = (o: O) => (shipTag(o) === '내' ? addDays(o.delivery_date, 1) : o.delivery_date);
export const shipUnitsIn = (note?: string | null) => Number(String(note || '').match(SHIP_RE)?.[1] || 0);
export const stripShip = (note: string) => note.replace(SHIP_RE, '');

const COLS = 'id, delivery_date, total_qty, delivery_method, receive_method, memo, paid_note, status';

async function moveShip(sb: SupabaseClient, customerId: string, delta: number) {
  for (let i = 0; i < 3; i++) {
    const { data: c } = await sb.from('baby_food_customers').select('id, phone, baby_name, prepaid_ship').eq('id', customerId).maybeSingle();
    if (!c || c.prepaid_ship === null || c.prepaid_ship === undefined) return null;
    const base = Number(c.prepaid_ship) || 0;
    const { data: up } = await sb.from('baby_food_customers').update({ prepaid_ship: base + delta })
      .eq('id', c.id).eq('prepaid_ship', base).select('id');
    if (up?.length) return { after: base + delta, phone: c.phone as string | null, babyName: c.baby_name as string | null };
  }
  return null;
}

/**
 * 이 주문이 선결제로 빠질 때 택배비 회수를 뺀다. 뺐으면 paid_note 끝에 붙일 꼬리(' · 택배 1회 (남은 9회)')를 돌려준다.
 * 택배가 아니거나 택배비 선결제 손님이 아니면 ''.
 */
export async function deductShip(sb: SupabaseClient, customerId: string, orderId: string): Promise<string> {
  const { data: o } = await sb.from('baby_food_orders').select(COLS).eq('id', orderId).maybeSingle();
  if (!o || !isCourier(o as O) || SHIP_RE.test(String(o.paid_note || ''))) return '';
  const { data: c } = await sb.from('baby_food_customers').select('phone, prepaid_ship').eq('id', customerId).maybeSingle();
  if (!c || c.prepaid_ship === null || c.prepaid_ship === undefined) return '';
  const day = shipDay(o as O);
  let q = sb.from('baby_food_orders').select(COLS).gte('delivery_date', addDays(day, -1)).lte('delivery_date', day).neq('status', '취소').neq('id', orderId);
  q = c.phone ? q.or(`customer_id.eq.${customerId},customer_phone.eq.${c.phone}`) : q.eq('customer_id', customerId);
  const { data: rows } = await q;
  const same = (rows || []).filter(r => isCourier(r as O) && shipDay(r as O) === day && SHIP_RE.test(String(r.paid_note || '')));  // 0회(같은 상자)도 그 상자에 든 팩
  const packs = same.reduce((s, r) => s + (Number(r.total_qty) || 0), 0);
  const used = same.reduce((s, r) => s + shipUnitsIn(r.paid_note), 0);
  const need = Math.max(0, Math.ceil((packs + (Number(o.total_qty) || 0)) / SHIP_PACKS_PER_BOX) - used);
  if (need <= 0) return ' · 택배 0회 (같은 상자)';
  const r = await moveShip(sb, customerId, -need);
  if (!r) return '';
  await recordPrepaid(sb, { customerId, phone: r.phone, babyName: r.babyName, kind: '사용', packs: -need, balanceAfter: r.after,
    orderId, item: '택배', memo: `택배비 ${need}회 (${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))} 상자)` });
  return ` · 택배 ${need}회 (남은 ${r.after}회)`;
}

/** 주문 표시(paid_note)에 적힌 택배 회수를 돌려준다 — 입금 탭 되돌리기·주문 취소 */
export async function refundShip(sb: SupabaseClient, customerId: string, orderId: string, note: string | null | undefined, why: string) {
  const n = shipUnitsIn(note);
  if (!n) return;
  const r = await moveShip(sb, customerId, n);
  if (!r) return;
  await recordPrepaid(sb, { customerId, phone: r.phone, babyName: r.babyName, kind: '환불', packs: n, balanceAfter: r.after,
    orderId, item: '택배', memo: `택배비 ${n}회 돌려놓음 — ${why}` });
}
