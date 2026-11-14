import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';
import { recordPrepaid } from '@/lib/prepaidLedger';
import { convertNeed, orderKinds, setPrepaidParts, guessKinds, CONVERT_PER_PACK, PREPAID_KINDS } from '@/lib/prepaidSplit';
import { nameKey } from '@/lib/depositMatch';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f-]{36}$/i;

/*
  POST /api/admin/prepaid-convert — 선결제 단계 변경 (중기·후기 → 완료기)
  2026-11-14 사장님(안시은): "완료기로 바꾸고 싶으면 차액을 추가 입금하면 해 줘. 24팩 남았으면 12,000원.
    지금은 완료기인데도 같이 카운팅이 됐어. 표기가 필요하고 입금 받았는지 확인해야 하고, 입금했다면 진행도"

  { customer_id, to }                              → 미리보기: 바꿀 팩·차액·맞는 은행 입금 후보
  { customer_id, to, apply, units, expect_from, deposit_id | cash:true } → 바꾸기
      남은 중기·후기 팩을 통째로 완료기 묶음으로 옮기고, 차액 입금을 이 일로 묶는다(입금 줄 상태 '선결제').

  바꿀 팩 = 지금 남은 중기·후기 팩 + 이미 완료기 주문으로 그 묶음에서 빠진 팩
    (마지막 중기·후기 주문 뒤의 완료기 주문 — 바꾸기 전에 먹은 완료기도 차액 대상이다)
*/
async function load(sb: any, id: string, to: string) {
  const { data: c } = await sb.from('baby_food_customers')
    .select('id, phone, baby_name, payer_names, prepaid_balance, prepaid_label, prepaid_split').eq('id', id).maybeSingle();
  if (!c) return { c: null as any, need: null, usedTo: 0 };
  // 종류 기록 없는 옛 카드는 처음 선결제로 빠진 주문 종류로 짐작 (입금 표 표시와 같은 규칙)
  if (!c.prepaid_label && !c.prepaid_split) {
    const g = await guessKinds(sb, [c.id]).catch(() => ({} as Record<string, string>));
    if (g[c.id]) c.prepaid_label_guess = g[c.id];
  }
  const need = convertNeed(c, to);
  if (!need) return { c, need: null, usedTo: 0 };
  let q = sb.from('baby_food_orders').select('id, delivery_date, stage, volume, items, total_qty, order_type, paid_note, status')
    .neq('status', '취소').order('delivery_date').limit(500);
  q = c.phone ? q.or(`customer_id.eq.${c.id},customer_phone.eq.${c.phone}`) : q.eq('customer_id', c.id);
  const { data: rows } = await q;
  const deducted = (rows || []).filter((r: any) => !String(r.stage || '').startsWith('반찬')
    && (r.order_type === '선결제' || String(r.paid_note || '').startsWith('선결제 차감')));
  let lastFrom = '';
  for (const r of deducted) if (orderKinds(r).some(k => k.kind === need.from) && r.delivery_date > lastFrom) lastFrom = r.delivery_date;
  let usedTo = 0;
  for (const r of deducted) {
    if (r.delivery_date < lastFrom) continue;
    for (const k of orderKinds(r)) if (k.kind === need.to) usedTo += k.qty;
  }
  return { c, need, usedTo };
}

export async function POST(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const id = String(b.customer_id || '');
  const to = String(b.to || '');
  if (!UUID.test(id) || !(PREPAID_KINDS as readonly string[]).includes(to) || !to.startsWith('완료기'))
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  const sb = supabaseService();
  const { c, need, usedTo } = await load(sb, id, to);
  if (!c) return NextResponse.json({ ok: false, error: '손님 카드를 못 찾았어요' }, { status: 404 });
  if (!need) return NextResponse.json({ ok: true, need: null });

  if (!b.apply) {
    const units = need.fromBalance + usedTo;
    const won = units * CONVERT_PER_PACK;
    // 차액과 같은 금액의 아직 정리 안 된 입금 — 이름(아기·입금자 이름)이 맞는 걸 위로
    const since = new Date(Date.now() - 60 * 864e5).toISOString();
    const { data: deps } = await sb.from('baby_food_deposits').select('id, deposited_at, depositor, amount, status')
      .eq('amount', won).in('status', ['모름', '확인필요']).gte('deposited_at', since).order('deposited_at', { ascending: false }).limit(30);
    const keys = [c.baby_name, ...(c.payer_names || [])].map((x: string) => nameKey(x)).filter((x: string) => x.length >= 2);
    const list = (deps || []).map((d: any) => ({ ...d, match: keys.some((k: string) => nameKey(d.depositor).includes(k)) }))
      .sort((a: any, z: any) => Number(z.match) - Number(a.match)).slice(0, 8);
    return NextResponse.json({ ok: true, need, usedTo, units, won, per: CONVERT_PER_PACK, deposits: list });
  }

  const units = Number(b.units);
  if (!Number.isInteger(units) || units < need.fromBalance || units > 999) return NextResponse.json({ ok: false, error: '바꿀 팩 수를 확인해 주세요' }, { status: 400 });
  if (Number(b.expect_from) !== need.fromBalance) return NextResponse.json({ ok: false, error: '남은 팩이 그 사이 바뀌었어요 — 새로고침 후 다시' }, { status: 409 });
  const won = units * CONVERT_PER_PACK;
  let dep: any = null;
  if (b.deposit_id) {
    if (!UUID.test(String(b.deposit_id))) return NextResponse.json({ ok: false, error: 'invalid deposit' }, { status: 400 });
    dep = (await sb.from('baby_food_deposits').select('id, deposited_at, depositor, amount, status').eq('id', b.deposit_id).maybeSingle()).data;
    if (!dep) return NextResponse.json({ ok: false, error: '입금 줄을 못 찾았어요' }, { status: 404 });
    if (!['모름', '확인필요'].includes(dep.status)) return NextResponse.json({ ok: false, error: `이미 정리된 입금이에요 (${dep.status})` }, { status: 409 });
    if (Number(dep.amount) !== won) return NextResponse.json({ ok: false, error: `입금 ${Number(dep.amount).toLocaleString()}원이 차액 ${won.toLocaleString()}원과 달라요` }, { status: 409 });
  } else if (!b.cash) {
    return NextResponse.json({ ok: false, error: '입금을 고르거나 "따로 받았어요"를 눌러 주세요' }, { status: 400 });
  }

  const B = need.fromBalance;
  const mv = await setPrepaidParts(sb, id, [{ kind: need.from, set: 0, expect: B }, { kind: need.to, set: B }]);
  if (!mv.ok) return NextResponse.json({ ok: false, error: mv.error }, { status: mv.status });

  const kst = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString();
  const md = (iso: string) => { const k = kst(iso); return `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`; };
  const how = dep ? `입금 ${dep.depositor} ${md(dep.deposited_at)}` : '따로 받음(사장님 확인)';
  const tag = `[${need.from}→${need.to}]`;
  await recordPrepaid(sb, { customerId: id, phone: c.phone, babyName: c.baby_name, kind: '수정', packs: -B, balanceAfter: mv.before - B,
    memo: `${tag} 단계 변경 — ${need.from} ${B}팩을 완료기로 옮김` });
  await recordPrepaid(sb, { customerId: id, phone: c.phone, babyName: c.baby_name, kind: '충전', packs: B, balanceAfter: mv.after, amountWon: won,
    memo: `${tag} 단계 변경 차액 ${won.toLocaleString()}원 (${units}팩×${CONVERT_PER_PACK}원${units > B ? `, 이미 먹은 완료기 ${units - B}팩 포함` : ''}) · ${how}` });
  if (dep) {
    await sb.from('baby_food_deposits').update({
      status: '선결제', order_ids: [], customer_phone: c.phone || null, confirmed_at: new Date().toISOString(),
      note: `단계 변경 차액 — ${c.baby_name} ${need.from}→${need.to} ${units}팩×${CONVERT_PER_PACK}원 (사장님 확인)`,
    }).eq('id', dep.id);
  }
  const { data: nc } = await sb.from('baby_food_customers').select('prepaid_balance, prepaid_split, prepaid_label').eq('id', id).maybeSingle();
  return NextResponse.json({ ok: true, customer: nc, won, units, how });
}
