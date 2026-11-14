import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';
import { recordPrepaid } from '@/lib/prepaidLedger';
import { isOpenworld } from '@/lib/openworld';
import { movePrepaid, kindOf, isSplit, balanceFor, orderKinds, partBalance, setPrepaidParts, shortKind, PREPAID_KINDS } from '@/lib/prepaidSplit';
import { deductShip } from '@/lib/prepaidShip';

export const dynamic = 'force-dynamic';

/*
  POST /api/admin/order-prepaid/cascade  { id, start, apply }
  2026-11-14 사장님: "2일 페이지에서 갯수 정하면 그 뒤로 체크 안 됐던 것들이 알아서 자동 차감"

  id    = 입금 탭에서 연 주문 (기준 날짜)
  start = 그 주문 '전에' 남아 있던 선결제 (이유식 팩 / 반찬 세트 회)
  그 날부터 뒤로 이 손님 주문을 날짜순으로 보면서
    이미 선결제로 빠진 주문(주문할 때 선결제 / '선결제 차감 …')  → 남은 수에서 뺀 것으로 센다
    아직 체크 안 된 주문(미입금, 또는 엑셀 시절 '대조안함')       → 이번에 선결제에서 뺀다
    돈으로 입금확인된 주문 · 오픈월드 · 취소                        → 건너뛴다
  끝난 숫자가 지금 남은 선결제가 된다. apply=false 면 미리보기만.
  표시는 입금 탭 '선결제에서 빼기'와 똑같이 → 하나씩 '되돌리기'가 그대로 된다.
*/
const PANEL_RE = /^선결제 차감 \d+(팩|회) \(입금 탭/;

export async function POST(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const id = String(b.id || '');
  const start = Number(b.start);
  // starts = { '중기·후기 300g': 20, '중기·후기 230g': 15 } — 용량별로 따로 (적은 묶음만 센다)
  const starts: Record<string, number> | null = b.starts && typeof b.starts === 'object' ? b.starts : null;
  if (starts) {
    const ks = Object.keys(starts);
    if (!ks.length || ks.some(k => !(PREPAID_KINDS as readonly string[]).includes(k) || !Number.isInteger(starts[k]) || starts[k] < 0 || starts[k] > 999))
      return NextResponse.json({ ok: false, error: '숫자를 확인해 주세요' }, { status: 400 });
  }
  if (!/^[0-9a-f-]{36}$/i.test(id) || (!starts && (!Number.isInteger(start) || start < 0 || start > 999)))
    return NextResponse.json({ ok: false, error: '숫자를 확인해 주세요' }, { status: 400 });
  const sb = supabaseService();

  const { data: o } = await sb.from('baby_food_orders').select('id, baby_name, stage, volume, delivery_date, customer_id, customer_phone')
    .eq('id', id).single();
  if (!o) return NextResponse.json({ ok: false, error: '주문 없음' }, { status: 404 });
  const banchan = String(o.stage || '').startsWith('반찬');
  if (o.stage === '반찬낱개') return NextResponse.json({ ok: false, error: '반찬 낱개는 선결제(세트 회수)가 아니에요' }, { status: 400 });
  const field = banchan ? 'prepaid_banchan' : 'prepaid_balance';
  const unit = banchan ? '회' : '팩';

  const cq = sb.from('baby_food_customers').select(`id, phone, baby_name, ${field}, prepaid_split, prepaid_label`);
  const { data: c } = o.customer_id ? await cq.eq('id', o.customer_id).maybeSingle()
    : o.customer_phone ? await cq.eq('phone', o.customer_phone).maybeSingle() : { data: null };
  if (!c) return NextResponse.json({ ok: false, error: '손님 카드를 못 찾았어요' }, { status: 404 });
  // 여러 단계 선결제 손님 — 이 주문 단계·용량의 묶음만 본다 (start 도 그 묶음 숫자). lib/prepaidSplit
  const split = !banchan && isSplit(c as any);
  const kind = banchan ? null : kindOf(o.stage, o.volume);
  const cur = banchan ? (Number((c as any)[field]) || 0) : balanceFor(c as any, kind);

  let q = sb.from('baby_food_orders')
    .select('id, delivery_date, created_at, stage, volume, items, total_qty, paid, paid_note, order_type, status')
    .gte('delivery_date', o.delivery_date).neq('status', '취소')
    .order('delivery_date').order('created_at').limit(500);
  q = c.phone ? q.or(`customer_id.eq.${c.id},customer_phone.eq.${c.phone}`) : q.eq('customer_id', c.id);
  const { data: rows, error: e1 } = await q;
  if (e1) return NextResponse.json({ ok: false, error: e1.message }, { status: 500 });

  if (starts && !banchan) return multi(sb, o, c, rows || [], starts, !!b.apply);

  const same = (st: string) => banchan ? (st.startsWith('반찬') && st !== '반찬낱개') : !st.startsWith('반찬');
  let bal = start;
  const lines: { id: string; date: string; qty: number; action: '뺌' | '이미 뺌' | '건너뜀'; why?: string; after: number }[] = [];
  for (const r of rows || []) {
    const st = String(r.stage || '');
    if (!same(st)) continue;
    // 다른 묶음(예: 완료기)은 그 묶음 판에서. 용량이 섞인 주문(230g+300g)은 이 숫자 하나로 못 세서 건너뛴다 — 그 날 ▸ 판에서 빼기
    const ks = banchan ? [] : orderKinds(r);
    if (split && !ks.some(x => x.kind === kind)) continue;
    if (split && ks.length > 1) {
      const mine = ks.find(x => x.kind === kind)!.qty;
      const n0 = String(r.paid_note || '');
      if (r.order_type === '선결제' || n0.startsWith('선결제 차감')) { bal -= mine; lines.push({ id: r.id, date: r.delivery_date, qty: mine, action: '이미 뺌', after: bal }); continue; }
      lines.push({ id: r.id, date: r.delivery_date, qty: Number(r.total_qty) || 0, action: '건너뜀', why: '230·300 섞인 주문 — 그 날 ▸ 판에서', after: bal }); continue; }
    const qty = Number(r.total_qty) || 0;
    const note = String(r.paid_note || '');
    if (r.order_type === '선결제' || note.startsWith('선결제 차감')) { bal -= qty; lines.push({ id: r.id, date: r.delivery_date, qty, action: '이미 뺌', after: bal }); continue; }
    if (r.paid) { lines.push({ id: r.id, date: r.delivery_date, qty, action: '건너뜀', why: '돈으로 입금확인', after: bal }); continue; }
    if (isOpenworld(note)) { lines.push({ id: r.id, date: r.delivery_date, qty, action: '건너뜀', why: '오픈월드', after: bal }); continue; }
    if (qty <= 0) continue;
    bal -= qty;
    lines.push({ id: r.id, date: r.delivery_date, qty, action: '뺌', after: bal });
  }
  const take = lines.filter(l => l.action === '뺌');
  const out = { ok: true, customer_id: c.id, field, unit, current: cur, final: bal, lines, kind: split ? kind : null };
  if (banchan && bal < 0) return NextResponse.json({ ...out, ok: false, error: `반찬 선결제가 모자라요 (끝에 ${bal}회)` }, { status: 409 });
  if (!b.apply) return NextResponse.json(out);

  // 잔액: 읽은 값 그대로일 때만 바꾼다(그 사이 다른 데서 바뀌었으면 멈춤)
  let totBefore = cur, totAfter = bal, newSplit: any = null;
  if (banchan) {
    const { data: up } = await sb.from('baby_food_customers').update({ [field]: bal }).eq('id', c.id).eq(field, cur).select('id');
    if (!up?.length) return NextResponse.json({ ok: false, error: '잔액이 그 사이 바뀌었어요 — 새로고침 후 다시' }, { status: 409 });
  } else {
    const mv = await movePrepaid(sb, c.id, { set: bal, kind, expectPart: cur });
    if (!mv.ok) return NextResponse.json({ ok: false, error: mv.error }, { status: mv.status });
    totBefore = mv.before; totAfter = mv.after; newSplit = mv.split;
  }
  const rollback = async () => banchan
    ? sb.from('baby_food_customers').update({ [field]: cur }).eq('id', c.id).eq(field, bal)
    : movePrepaid(sb, c.id, { set: cur, kind });

  const k = new Date(Date.now() + 9 * 3600e3).toISOString();
  const stamp = `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`;
  const done: { id: string; paid_note: string }[] = [];
  for (const l of take) {
    const paid_note = `선결제 차감 ${l.qty}${unit} (입금 탭 ${stamp}, 남은 ${l.after}${unit})`;
    const { data: u, error } = await sb.from('baby_food_orders').update({ paid: true, paid_at: new Date().toISOString(), paid_note })
      .eq('id', l.id).eq('paid', false).select('id');
    if (error || !u?.length) {
      // 하나라도 못 바꾸면 여기까지 바꾼 주문을 되돌리고 잔액도 되돌린다
      if (done.length) await sb.from('baby_food_orders').update({ paid: false, paid_at: null, paid_note: null }).in('id', done.map(d => d.id));
      await rollback();
      return NextResponse.json({ ok: false, error: `${l.date} 주문을 못 바꿔서 전부 되돌렸어요${error ? ': ' + error.message : ''}` }, { status: 500 });
    }
    done.push({ id: l.id, paid_note });
  }

  // 장부: 기준 맞춤(수정) 한 줄 + 뺀 주문마다 사용 한 줄 → 마지막 잔액이 지금 잔액과 같다
  // 장부의 balance_after 는 전체 잔액 기준 — 여러 묶음이면 [묶음] 을 메모 앞에
  const item = banchan ? '반찬' : '이유식';
  const tag = split && kind ? `[${kind}] ` : '';
  const takenSum = take.reduce((s, l) => s + l.qty, 0);
  const adjust = (totAfter + takenSum) - totBefore;
  let run = totBefore + adjust;
  await recordPrepaid(sb, { customerId: c.id, phone: c.phone, babyName: c.baby_name, kind: '수정', packs: adjust, balanceAfter: run, item,
    memo: `${tag}입금 탭: ${Number(o.delivery_date.slice(5, 7))}/${Number(o.delivery_date.slice(8, 10))} 주문 전 남은 ${start}${unit} 기준으로 맞춤` });
  for (const l of take) {
    run -= l.qty;
    await recordPrepaid(sb, { customerId: c.id, phone: c.phone, babyName: c.baby_name, kind: '사용', packs: -l.qty, balanceAfter: run, orderId: l.id, item,
      memo: `${tag}입금 탭에서 선결제로 처리 (뒤 주문 한꺼번에)` });
  }
  // 택배비 선결제 손님이면 날짜순으로 택배 회수도 (5팩까지 1회, 같은 날 상자는 합쳐서) — lib/prepaidShip
  for (const d of done) {
    const tail = await deductShip(sb, c.id, d.id);
    if (tail) { d.paid_note += tail; await sb.from('baby_food_orders').update({ paid_note: d.paid_note }).eq('id', d.id); }
  }
  return NextResponse.json({ ...out, done, total: totAfter, split: newSplit });
}

/* 용량별 한꺼번에 빼기 — 2026-11-14 사장님(서은혁): "한꺼번에 빼기에도 나눠서 빼는 기능"
   묶음마다 '이 주문 전 남은 수' 를 받아, 주문 안의 용량별 팩(orderKinds)을 그 묶음에서 뺀다.
   230g+300g 섞인 주문도 각 묶음에서 따로. 숫자를 안 적은 용량이 섞인 주문은 건너뛴다(반쪽만 뺄 수 없다).
   표시 문구: 한 용량 주문은 그 묶음 숫자(조리표 팩수 고치기와 맞물림), 섞인 주문은 '중후300 7·중후230 9'. */
async function multi(sb: any, o: any, c: any, rows: any[], starts: Record<string, number>, apply: boolean) {
  const kinds = Object.keys(starts);
  const bal: Record<string, number> = { ...starts };
  const cur: Record<string, number> = Object.fromEntries(kinds.map(k => [k, partBalance(c, k)]));
  const txt = (m: Record<string, number>, only?: string[]) => (only || kinds).map(k => `${shortKind(k)} ${m[k]}`).join('·');
  type L = { id: string; date: string; qty: number; action: '뺌' | '이미 뺌' | '건너뜀'; why?: string; after: string; per?: { kind: string; qty: number }[] };
  const lines: L[] = [];
  for (const r of rows) {
    const st = String(r.stage || '');
    if (!st || st.startsWith('반찬')) continue;
    const ks = orderKinds(r);
    const mine = ks.filter(k => k.kind && k.kind in bal) as { kind: string; qty: number }[];
    if (!mine.length) continue;
    const qty = mine.reduce((s, k) => s + k.qty, 0);
    const note = String(r.paid_note || '');
    const base = { id: r.id, date: r.delivery_date, qty };
    if (r.order_type === '선결제' || note.startsWith('선결제 차감')) {
      for (const k of mine) bal[k.kind] -= k.qty;
      lines.push({ ...base, action: '이미 뺌', after: txt(bal) }); continue;
    }
    if (mine.length < ks.length) { lines.push({ ...base, action: '건너뜀', why: '숫자 안 적은 용량이 섞임', after: txt(bal) }); continue; }
    if (r.paid) { lines.push({ ...base, action: '건너뜀', why: '돈으로 입금확인', after: txt(bal) }); continue; }
    if (isOpenworld(note)) { lines.push({ ...base, action: '건너뜀', why: '오픈월드', after: txt(bal) }); continue; }
    if (qty <= 0) continue;
    for (const k of mine) bal[k.kind] -= k.qty;
    lines.push({ ...base, action: '뺌', after: txt(bal), per: mine });
  }
  const neg = kinds.some(k => bal[k] < 0);
  const out = { ok: true, multi: true, customer_id: c.id, field: 'prepaid_balance', unit: '팩', current: txt(cur), final: txt(bal), finals: bal, neg, lines, kind: null };
  if (!apply) return NextResponse.json(out);

  const mv = await setPrepaidParts(sb, c.id, kinds.map(k => ({ kind: k, set: bal[k], expect: cur[k] })));
  if (!mv.ok) return NextResponse.json({ ok: false, error: mv.error }, { status: mv.status });
  const rollback = () => setPrepaidParts(sb, c.id, kinds.map(k => ({ kind: k, set: cur[k] })));

  const k9 = new Date(Date.now() + 9 * 3600e3).toISOString();
  const stamp = `${Number(k9.slice(5, 7))}/${Number(k9.slice(8, 10))}`;
  const take = lines.filter(l => l.action === '뺌');
  // 주문마다 그때 남은 수 — 다시 앞에서부터 세어 그 주문 묶음 숫자를 적는다
  const run: Record<string, number> = { ...starts };
  const noteOf: Record<string, string> = {};
  for (const r of rows) {
    const l = lines.find(x => x.id === r.id);
    if (!l || l.action === '건너뜀') continue;
    const ks = orderKinds(r).filter(k => k.kind && k.kind in run) as { kind: string; qty: number }[];
    for (const k of ks) run[k.kind] -= k.qty;
    if (l.action === '뺌') noteOf[r.id] = `선결제 차감 ${l.qty}팩 (입금 탭 ${stamp}, 남은 ${ks.length === 1 ? run[ks[0].kind] : txt(run, ks.map(k => k.kind))}팩)`;
  }
  const done: { id: string; paid_note: string }[] = [];
  for (const l of take) {
    const paid_note = noteOf[l.id];
    const { data: u, error } = await sb.from('baby_food_orders').update({ paid: true, paid_at: new Date().toISOString(), paid_note })
      .eq('id', l.id).eq('paid', false).select('id');
    if (error || !u?.length) {
      if (done.length) await sb.from('baby_food_orders').update({ paid: false, paid_at: null, paid_note: null }).in('id', done.map(d => d.id));
      await rollback();
      return NextResponse.json({ ok: false, error: `${l.date} 주문을 못 바꿔서 전부 되돌렸어요${error ? ': ' + error.message : ''}` }, { status: 500 });
    }
    done.push({ id: l.id, paid_note });
  }
  // 장부: 기준 맞춤(수정) 한 줄 + 뺀 주문마다 사용 한 줄 (balance_after 는 전체 잔액)
  const tag = `[${kinds.join('+')}] `;
  const takenSum = take.reduce((s, l) => s + l.qty, 0);
  let runTot = mv.after + takenSum;
  const md = `${Number(o.delivery_date.slice(5, 7))}/${Number(o.delivery_date.slice(8, 10))}`;
  await recordPrepaid(sb, { customerId: c.id, phone: c.phone, babyName: c.baby_name, kind: '수정', packs: runTot - mv.before, balanceAfter: runTot, item: '이유식',
    memo: `${tag}입금 탭: ${md} 주문 전 남은 ${txt(starts)}팩 기준으로 맞춤` });
  for (const l of take) {
    runTot -= l.qty;
    await recordPrepaid(sb, { customerId: c.id, phone: c.phone, babyName: c.baby_name, kind: '사용', packs: -l.qty, balanceAfter: runTot, orderId: l.id, item: '이유식',
      memo: `${tag}입금 탭에서 선결제로 처리 (뒤 주문 한꺼번에)` });
  }
  for (const d of done) {
    const tail = await deductShip(sb, c.id, d.id);
    if (tail) { d.paid_note += tail; await sb.from('baby_food_orders').update({ paid_note: d.paid_note }).eq('id', d.id); }
  }
  return NextResponse.json({ ...out, done, total: mv.after, split: mv.split });
}