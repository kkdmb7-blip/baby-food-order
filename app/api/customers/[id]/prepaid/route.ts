import { NextRequest, NextResponse } from 'next/server';
import { supabaseService, PREPAID_UNITS } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';
import { recordPrepaid } from '@/lib/prepaidLedger';
import { parseKakaoPrepaid, memoSummary } from '@/lib/kakaoPrepaid';
import { movePrepaid, kindOfLabel, isSplit, kindTag, partBalance, setPrepaidParts } from '@/lib/prepaidSplit';

// POST /api/customers/[id]/prepaid — 선결제 충전 (admin)
// body { units: 20|30|50, amount_won?: 받은 돈 }
//
// ⚠️ 전에는 "읽은 잔액 + 팩" 을 그냥 덮어써서, 충전 단추를 두 번 빨리 누르거나 그 사이 주문이
//    들어오면 한쪽이 지워질 수 있었다. 다른 곳(주문 차감·취소)처럼 "읽은 값 그대로일 때만" 쓴다.
// ⚠️ 충전 기록이 아무 데도 안 남았다. 이제 장부(baby_food_prepaid_ledger)에 남긴다.
export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const body = await req.json().catch(() => ({}));

  // 카톡 메모장 정리를 통째로 붙여넣기 — { memo: '8/21 중230ᆞ50입\n8/24 50-3-6-3-6=32 …' }
  // 메모장이 원본이다. 잔여는 마지막 묶음의 적힌 마지막 결과, 단계·용량은 그 묶음의 마지막 '입' 줄.
  // 다시 붙여넣으면 그 값으로 다시 맞춘다(더하지 않는다). 바뀐 만큼 장부에 '수정' 한 줄.
  // ⚠️ 잔여 고치기·충전도 사유를 'memo' 로 보낸다({ set, memo: '사유' }). 그걸 카톡 메모로 읽으면
  //    "읽을 줄이 없어요" 로 거절돼 잔여 고치기가 전부 안 먹었다(2026-11-14 사장님 신고). 숫자가 같이 오면 카톡 메모가 아니다.
  if (typeof body.memo === 'string' && body.set === undefined && body.times === undefined && body.units === undefined) {
    const memo = body.memo.replace(/\r/g, '').trim().slice(0, 20000);
    const parsed = parseKakaoPrepaid(memo);
    const tracks = memoSummary(parsed);
    if (!tracks.length) return NextResponse.json({ error: "읽을 줄이 없어요 — '8/21 중230ᆞ50입', '8/24 50-3-6=41' 같은 줄이 있어야 해요" }, { status: 400 });
    const last = tracks[tracks.length - 1];
    const sb = supabaseService();
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data: c } = await sb.from('baby_food_customers')
        .select('prepaid_balance, phone, baby_name').eq('id', ctx.params.id).single();
      if (!c) return NextResponse.json({ error: '고객 없음' }, { status: 404 });
      const base = Number(c.prepaid_balance) || 0;
      const { data: upd, error } = await sb.from('baby_food_customers').update({
        prepaid_balance: last.balance, prepaid_label: last.label, prepaid_memo: memo,
        prepaid_memo_at: new Date().toISOString(), prepaid_tracks: tracks,
        prepaid_split: null, // 카톡 메모는 한 묶음으로 다시 맞춘다 (여러 단계면 고객관리에서 묶음별로 고치기)
      }).eq('id', ctx.params.id).eq('prepaid_balance', base).select('id');
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (upd && upd.length) {
        if (base !== last.balance) {
          await recordPrepaid(sb, {
            customerId: ctx.params.id, phone: c.phone, babyName: c.baby_name,
            kind: '수정', packs: last.balance - base, balanceAfter: last.balance,
            memo: `카톡 메모 반영 ${base}→${last.balance}팩${last.label ? ` (${last.label})` : ''}`
              + (tracks.length > 1 ? ` · 다른 묶음 ${tracks.slice(0, -1).map(t => `${t.label || ''} ${t.balance}팩`).join(', ')}` : ''),
          });
        }
        return NextResponse.json({ ok: true, new_balance: last.balance, label: last.label, tracks, problems: parsed.problems });
      }
    }
    return NextResponse.json({ error: '잔액이 계속 바뀌어 저장하지 못했어요 — 다시 눌러주세요' }, { status: 409 });
  }

  // 어떤 단계·용량으로 산 선결제인지 — { label: '완료기 300g' } (빈 값이면 지움)
  if (body.label !== undefined && body.set === undefined && body.times === undefined && body.units === undefined) {
    const label = String(body.label || '').trim().slice(0, 30) || null;
    const sb = supabaseService();
    const { error } = await sb.from('baby_food_customers').update({ prepaid_label: label }).eq('id', ctx.params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, label });
  }

  // 이유식은 팩(prepaid_balance), 반찬은 회(prepaid_banchan) — 서로 섞이지 않게 칸이 따로다
  // 택배비(prepaid_ship)도 회로 — 택배 주문이 선결제로 빠질 때 5팩까지 1회 (lib/prepaidShip)
  const isBanchan = body.item === '반찬';
  const isShip = body.item === '택배';
  const col = isBanchan ? 'prepaid_banchan' : isShip ? 'prepaid_ship' : 'prepaid_balance';
  const unit = isBanchan || isShip ? '회' : '팩';
  const item = isBanchan ? '반찬' as const : isShip ? '택배' as const : '이유식' as const;

  // 택배비 선결제 그만 — { item:'택배', set: null } → 칸을 비운다(앞으로 택배 회수 안 뺌)
  if (isShip && body.set === null) {
    const { error } = await supabaseService().from('baby_food_customers').update({ prepaid_ship: null }).eq('id', ctx.params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, new_balance: null, item });
  }

  // 사장님이 잔여를 직접 고치는 경우 — { set: 새 잔여, memo: 사유, item? }
  // 카톡으로 받은 선결제를 처음 옮기거나, 손님과 맞춰보다 틀린 걸 고칠 때. 장부에 '수정' 으로 남긴다.
  // 반찬 회수 충전 — { item:'반찬', times: 4, amount_won } 도 같은 길로 (더하기만 다르다)
  if (body.set !== undefined || ((isBanchan || isShip) && body.times !== undefined)) {
    const adding = body.set === undefined;
    const delta = Number(body.times);
    const target0 = Number(body.set);
    if (adding ? (!Number.isInteger(delta) || delta < 1 || delta > 50)
               : (!Number.isInteger(target0) || target0 < (isBanchan ? 0 : -999) || target0 > 999)) {
      return NextResponse.json({ error: adding ? '1~50회로 적어주세요' : '-999~999 사이 숫자로 적어주세요' }, { status: 400 });
    }
    const memo = String(body.memo || '').trim().slice(0, 100);
    const amountWon = Number(body.amount_won) > 0 ? Math.floor(Number(body.amount_won)) : null;
    const sb = supabaseService();
    // 이유식 잔여 고치기 — 여러 단계 손님은 어느 묶음인지(kind) 같이 온다 (lib/prepaidSplit)
    if (!isBanchan && !isShip) {
      const kind = body.kind ? kindOfLabel(String(body.kind)) : null;
      const { data: c0 } = await sb.from('baby_food_customers').select('prepaid_balance, prepaid_label, prepaid_split').eq('id', ctx.params.id).maybeSingle();
      if (!c0) return NextResponse.json({ error: '고객 없음' }, { status: 404 });
      if (isSplit(c0 as any) && !kind) return NextResponse.json({ error: '여러 단계 선결제 손님이에요 — 어느 묶음을 고칠지 골라 주세요' }, { status: 400 });
      // 용량별 칸(입금 탭 판, 230·300 섞인 손님) — 그 묶음만 고친다. 한 묶음 손님이면 여기서 묶음이 나뉜다
      // 2026-11-14 사장님(서은혁): "카운팅 자체를 2개로 나눠서 해야 돼"
      if (body.per_kind && kind) {
        const before = partBalance(c0 as any, kind);
        const r = await setPrepaidParts(sb, ctx.params.id, [{ kind, set: target0, expect: before }]);
        if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
        if (before !== target0) {
          const { data: who } = await sb.from('baby_food_customers').select('phone, baby_name').eq('id', ctx.params.id).maybeSingle();
          await recordPrepaid(sb, {
            customerId: ctx.params.id, phone: who?.phone ?? null, babyName: who?.baby_name ?? null,
            kind: '수정', packs: r.after - r.before, balanceAfter: r.after, item,
            memo: `[${kind}] 사장님이 직접 고침 ${before}→${target0}${unit}${memo ? ` · ${memo}` : ''}`,
          });
        }
        return NextResponse.json({ ok: true, new_balance: r.after, part: target0, split: r.split, label: r.split ? undefined : kind, item });
      }
      const r = await movePrepaid(sb, ctx.params.id, { set: target0, kind });
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
      if (r.before !== r.after || r.partBefore !== r.partAfter) {
        await recordPrepaid(sb, {
          customerId: ctx.params.id, phone: r.phone, babyName: r.babyName,
          kind: '수정', packs: r.after - r.before, balanceAfter: r.after, item,
          memo: `${kindTag(r)}사장님이 직접 고침 ${r.partBefore}→${r.partAfter}${unit}${memo ? ` · ${memo}` : ''}`,
        });
      }
      return NextResponse.json({ ok: true, new_balance: r.after, part: r.partAfter, split: r.split, item });
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data: c } = await sb.from('baby_food_customers')
        .select(`${col}, phone, baby_name`).eq('id', ctx.params.id).single();
      if (!c) return NextResponse.json({ error: '고객 없음' }, { status: 404 });
      const raw = (c as any)[col];
      const base = Number(raw) || 0;
      const target = adding ? base + delta : target0;
      if (base === target && raw !== null) return NextResponse.json({ ok: true, new_balance: base, unchanged: true });
      // 택배비 칸이 비어 있던(null) 손님은 is null 로 맞춰 본다 — eq(0) 은 null 과 안 맞는다
      const q0 = sb.from('baby_food_customers').update({ [col]: target }).eq('id', ctx.params.id);
      const { data: upd, error } = await (raw === null ? q0.is(col, null) : q0.eq(col, base)).select('id');
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (upd && upd.length) {
        await recordPrepaid(sb, {
          customerId: ctx.params.id, phone: (c as any).phone, babyName: (c as any).baby_name,
          kind: adding ? '충전' : '수정', packs: target - base, balanceAfter: target, amountWon, item,
          memo: adding ? `${isShip ? '택배비' : '반찬'} ${delta}회 충전${memo ? ` · ${memo}` : ''}`
                       : `사장님이 직접 고침 ${base}→${target}${unit}${memo ? ` · ${memo}` : ''}`,
        });
        return NextResponse.json({ ok: true, new_balance: target, item });
      }
    }
    return NextResponse.json({ error: '잔액이 계속 바뀌어 고치지 못했어요 — 다시 눌러주세요' }, { status: 409 });
  }

  const units = body.units;
  if (!PREPAID_UNITS.includes(units)) {
    return NextResponse.json({ error: `유효 단위: ${PREPAID_UNITS.join('/')}팩` }, { status: 400 });
  }
  const amountWon = Number(body.amount_won) > 0 ? Math.floor(Number(body.amount_won)) : null;
  const id = ctx.params.id;
  const sb = supabaseService();

  // 충전할 때 고른 종류(예: '완료기 300g')를 손님의 선결제 단계로 남긴다 — 다음 충전·입금 대조가 이 값을 쓴다.
  // 지금 남은 팩과 다른 종류면 묶음이 따로 생긴다(후기230 + 완료기230 처럼) — lib/prepaidSplit
  const pickLabel = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 30) : null;
  const kind = kindOfLabel(pickLabel) || pickLabel;
  const r = await movePrepaid(sb, id, { delta: units, charge: true, kind });
  if (!r.ok) return NextResponse.json({ error: r.error === '손님 카드를 못 찾았어요' ? '고객 없음' : r.error }, { status: r.status });
  await recordPrepaid(sb, {
    customerId: id, phone: r.phone, babyName: r.babyName,
    kind: '충전', packs: units, balanceAfter: r.after, amountWon,
    memo: `${kindTag(r)}${units}팩 충전${pickLabel ? ` (${pickLabel})` : ''}`,
  });
  return NextResponse.json({ ok: true, new_balance: r.after, part: r.partAfter, split: r.split, label: r.kind || kind });
}

// GET /api/customers/[id]/prepaid — 그 손님의 선결제 장부(최근 100줄) + 주문 내역(최근 200건)
// 주문은 지우지 않고 취소도 상태만 바뀌므로, 여기서 그 손님이 언제 무엇을 주문했는지 전부 보인다.
export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const sb = supabaseService();
  const { data: c } = await sb.from('baby_food_customers').select('phone, payer_names, memo, prepaid_label, prepaid_banchan, prepaid_memo, prepaid_memo_at, prepaid_tracks').eq('id', ctx.params.id).maybeSingle();
  const [led, ord] = await Promise.all([
    sb.from('baby_food_prepaid_ledger')
      .select('created_at, kind, packs, balance_after, amount_won, order_id, memo, item')
      .eq('customer_id', ctx.params.id).order('created_at', { ascending: false }).limit(100),
    // 번호 없는 손님(택배·당일·픽업)은 주문을 customer_id 로 잇는다
    sb.from('baby_food_orders')
      .select('id, created_at, delivery_date, stage, volume, total_qty, total_price, shipping_fee, status, order_type, receive_method, paid, paid_note, source')
      .or(c?.phone ? `customer_phone.eq.${String(c.phone).replace(/\D/g, '')},customer_id.eq.${ctx.params.id}` : `customer_id.eq.${ctx.params.id}`)
      .order('delivery_date', { ascending: false }).limit(200),
  ]);
  if (led.error) return NextResponse.json({ error: led.error.message }, { status: 500 });
  if (ord.error) return NextResponse.json({ error: ord.error.message }, { status: 500 });
  return NextResponse.json({ ok: true, rows: led.data || [], orders: ord.data || [], payer_names: c?.payer_names || [], memo: c?.memo || null,
    label: c?.prepaid_label || null, banchan: Number(c?.prepaid_banchan) || 0,
    kakao_memo: c?.prepaid_memo || '', kakao_memo_at: c?.prepaid_memo_at || null, tracks: c?.prepaid_tracks || null });
}
