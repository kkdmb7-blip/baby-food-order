import type { SupabaseClient } from '@supabase/supabase-js';
import { matchDeposits, nameKey, parseDepositor, type MOrder } from './depositMatch';

/*
  입금 대조 — DB 쪽. 짝짓기 규칙은 lib/depositMatch.ts.
  아직 사장님이 손대지 않은(confirmed_at 없음) '모름'·'확인필요' 입금만 다시 맞춘다.
  사장님이 확정·무관·선결제로 정한 건 다시 건드리지 않는다.
*/

const ORDER_COLS = 'id, baby_name, delivery_date, customer_phone, total_price, shipping_fee, total_qty, stage, delivery_method, paid, paid_note, status';
const kstDate = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

export function paidNoteFor(d: { depositor: string; deposited_at: string; amount: number }, how: '자동' | '사장님 확인') {
  const t = new Date(new Date(d.deposited_at).getTime() + 9 * 3600e3).toISOString();
  return `입금 ${d.depositor} ${Number(t.slice(5, 7))}/${Number(t.slice(8, 10))} ${t.slice(11, 16)} ${d.amount.toLocaleString('ko-KR')}원 (${how})`;
}

async function allRows<T>(q: () => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q().range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function rematchDeposits(sb: SupabaseClient) {
  const deps = await allRows<any>(() => sb.from('baby_food_deposits')
    .select('id, deposited_at, depositor, amount, status, order_ids')
    .in('status', ['모름', '확인필요']).is('confirmed_at', null).order('deposited_at'));
  if (deps.length === 0) return { checked: 0, auto: 0 };

  const days = deps.map(d => kstDate(d.deposited_at)).sort();
  // 이름 찾기는 넓게(두 달 전까지) — 그래야 "그 이름 주문이 아예 없음" 과 "그 날 주문만 없음" 을 가른다.
  // 금액 맞추기는 depositMatch 안에서 날짜를 다시 좁힌다.
  const from = addDays(days[0], -60), to = addDays(days[days.length - 1], 30);
  const orders = await allRows<MOrder & { status: string }>(() => sb.from('baby_food_orders').select(ORDER_COLS)
    .gte('delivery_date', from).lte('delivery_date', to).neq('status', '취소').order('delivery_date'));
  const payerRows = await allRows<any>(() => sb.from('baby_food_customers').select('phone, payer_names').neq('payer_names', '{}'));
  const payer = Object.fromEntries(payerRows.map(r => [r.phone, r.payer_names || []]));

  const results = matchDeposits(deps, orders, payer);
  const depById = Object.fromEntries(deps.map(d => [d.id, d]));
  let auto = 0;
  for (const r of results) {
    const d = depById[r.id];
    if (r.status === '자동확인') {
      auto++;
      const { error } = await sb.from('baby_food_orders')
        .update({ paid: true, paid_at: d.deposited_at, paid_note: paidNoteFor(d, '자동') })
        .in('id', r.order_ids).eq('paid', false);
      if (error) throw error;
    }
    const { error } = await sb.from('baby_food_deposits').update({
      status: r.status, order_ids: r.order_ids, suggested_ids: r.suggested_ids,
      customer_phone: r.customer_phone, note: r.note,
    }).eq('id', r.id).is('confirmed_at', null);
    if (error) throw error;
  }
  return { checked: deps.length, auto };
}

/** 입금자 이름(날짜 뗀 것)을 손님 카드에 저장 — 다음부터 그 이름으로 온 돈을 이 손님으로 본다 */
export async function rememberPayer(sb: SupabaseClient, phones: string[], depositor: string, at: string) {
  const name = parseDepositor(depositor, at).name;
  if (nameKey(name).length < 2) return null;
  for (const phone of phones.filter(Boolean)) {
    const { data: c } = await sb.from('baby_food_customers').select('id, baby_name, payer_names').eq('phone', phone).maybeSingle();
    if (!c) continue;
    if (nameKey(c.baby_name) === nameKey(name)) continue; // 아기 이름 그대로면 저장할 필요 없음
    const list: string[] = c.payer_names || [];
    if (!list.includes(name)) await sb.from('baby_food_customers').update({ payer_names: [...list, name] }).eq('id', c.id);
  }
  return name;
}
