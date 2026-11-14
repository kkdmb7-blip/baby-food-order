import { NextRequest, NextResponse } from 'next/server';
import { recordPrepaid } from '@/lib/prepaidLedger';
import { movePrepaid, kindOf, kindTag } from '@/lib/prepaidSplit';
import {
  supabaseService, MENU_TYPES, STAGE_OPTIONS, getPrice, shippingFeeFor, tierOf,
  type StageType, type PriceTier,
} from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';
import { orderDates, slicesOn, rewriteMenusOn } from '@/lib/orderItems';

/*
  조리표에서 팩수를 고친다 — 주문 한 건(= 단계·용량 한 칸)의 메뉴별 팩수만 바꾼다.

  왜 이 길이 따로 필요한가
    손님이 "한우 2 → 3" 처럼 바꿔 달라고 하실 때, 지금까지는 취소하고 다시 넣어야 했다.
    그러면 입금확인·메모가 날아가고 '추가' 표시가 붙는다.
    여기서 고치면 같은 주문 줄에 그대로 반영된다.

  돈이 걸려 있어서 조심한 것들
    - 팩수가 바뀌면 금액(total_price)·배송비(shipping_fee)도 다시 계산해야 한다.
      화면에서 보내온 금액은 믿지 않고 서버가 단가표(getPrice)로 다시 계산한다.
    - 선결제는 팩을 미리 사둔 것이라, 늘면 그만큼 더 빠지고 줄면 되돌아와야 한다.
      "읽은 값 그대로일 때만" 갱신(CAS)해서 동시에 두 번 눌러도 두 번 빠지지 않게 한다.
      늘리는데 잔여가 모자라면 아예 고치지 않는다.
    - 일반 주문의 적립 포인트(3%)도 금액이 바뀌면 달라진다. 가입·추천 보너스는
      금액과 무관하므로 '기존 적립 - 기존금액의 3%' 를 보너스로 보고 그대로 남긴다.
    - 잔액을 먼저 맞추고 주문 줄을 고친다. 주문 줄 고치기가 실패하면 잔액을 되돌린다.

  못 고치는 것 (고치면 틀리는 쪽이라 거부한다)
    - 여러 날짜가 묶인 주문 (total_qty 가 날짜 전체 합이라 한 날만 바꿀 수 없다)
    - 그날 몫이 두 묶음 이상인 주문
    - 반찬세트 (단가 체계가 다르다)
*/

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function bad(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function POST(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const b = await req.json().catch(() => ({}));
  const id = String(b.id || '');
  const date = String(b.date || '').trim();
  if (!UUID.test(id)) return bad('invalid id');
  if (!DATE.test(date)) return bad('invalid date');

  // 메뉴별 팩수만 받는다. 단계·용량은 주문에 있는 그대로 쓴다(화면이 바꾸지 못하게).
  const menus: Record<string, number> = {};
  let newQty = 0;
  for (const m of MENU_TYPES) {
    const n = Math.max(0, Math.min(99, Math.floor(Number(b.menus?.[m]) || 0)));
    if (n > 0) { menus[m] = n; newQty += n; }
  }
  if (newQty <= 0) return bad('0팩으로는 못 고쳐요 — 취소를 눌러주세요');

  const sb = supabaseService();

  const { data: o } = await sb
    .from('baby_food_orders')
    .select('id, status, order_type, customer_phone, customer_id, baby_name, stage, volume, items, total_qty, total_price, shipping_fee, points_earned, delivery_method, receive_method, delivery_date, paid_note')
    .eq('id', id).single();
  if (!o) return bad('주문 없음', 404);
  if (o.status === '취소') return bad('취소된 주문이에요');

  const dates = orderDates(o as any);
  if (dates.length > 1) {
    return bad(`여러 날짜(${dates.join(', ')})가 묶인 주문은 여기서 못 고쳐요 — 주문 탭에서 취소하고 다시 넣어주세요`, 409);
  }
  const slices = slicesOn(o as any, date);
  if (slices.length !== 1) {
    return bad(slices.length === 0 ? '그 날짜 몫이 없는 주문이에요' : '그날 몫이 두 묶음 이상이라 여기서 못 고쳐요', 409);
  }

  const stage = String(slices[0].stage || '') as StageType;
  const volume = Number(slices[0].volume || 0);
  if (!STAGE_OPTIONS[stage]) return bad(`${stage || '이 단계'}는 여기서 못 고쳐요 (반찬세트 등)`, 409);

  // 단가 — 지역 인상분(팩당 500원)은 그 주문에 저장된 배송 방법을 따른다.
  // 픽업은 배송을 안 나가니 기본가다(주문 만들 때와 같은 규칙).
  const tier: PriceTier = o.receive_method === '픽업' ? '직배송' : tierOf(o.delivery_method);
  const perPack = getPrice(stage, volume, tier);
  if (!perPack) return bad('단가를 찾을 수 없어요');

  const oldQty = Number(o.total_qty) || 0;
  const oldPrice = Number(o.total_price) || 0;
  const newPrice = perPack * newQty;
  const newShipping = o.order_type === '선결제' ? 0 : shippingFeeFor(tier, newQty, newPrice);

  // 적립 포인트 — 보너스(가입·추천)는 금액과 무관하므로 떼어 두고 3%만 다시 계산한다
  const oldEarned = Number(o.points_earned) || 0;
  const bonus = Math.max(0, oldEarned - Math.floor(oldPrice * 0.03));
  const newEarned = o.order_type === '선결제' ? 0 : Math.floor(newPrice * 0.03) + bonus;

  const qtyDelta = newQty - oldQty;          // 팩이 늘면 +
  const pointDelta = newEarned - oldEarned;  // 적립이 늘면 +

  // ── 1) 선결제 잔여 맞추기 (CAS, 모자라면 중단)
  // 입금 탭에서 선결제로 뺀 주문도 팩이 걸려 있다 — 팩수가 바뀌면 같이 맞추고 표시 문구의 팩수도 고친다
  const panel = String(o.paid_note || '').match(/^선결제 차감 (\d+)팩 \(입금 탭 ([^,]+), 남은 (-?\d+)팩\)/);
  const kind = kindOf(stage, volume);
  let prepaidMoved = 0;
  let prepaidCust: { id: string; after: number; tag: string } | null = null;
  let newPaidNote: string | null = null;
  if ((o.order_type === '선결제' || panel) && qtyDelta !== 0) {
    const cid = o.customer_id || (o.customer_phone
      ? (await sb.from('baby_food_customers').select('id').eq('phone', o.customer_phone).maybeSingle()).data?.id : null);
    if (!cid) return bad('선결제 고객을 찾을 수 없어요');
    // 주문할 때 선결제는 잔여 안에서만(모자라면 거절, 예전 그대로). 입금 탭으로 뺀 건 마이너스도 그대로 둔다(입금 요청 대상)
    const mv = await movePrepaid(sb, cid, { delta: -qtyDelta, kind, requireEnough: o.order_type === '선결제' });
    if (!mv.ok) return bad(mv.status === 400 ? `${mv.error} — 충전 후 고쳐주세요` : mv.error, mv.status);
    prepaidMoved = qtyDelta;
    prepaidCust = { id: cid, after: mv.after, tag: kindTag(mv) };
    if (panel) newPaidNote = `선결제 차감 ${newQty}팩 (입금 탭 ${panel[2]}, 남은 ${mv.partAfter}팩)`;
  }

  // ── 2) 주문 줄 고치기. items 안쪽 팩수·메뉴도 같이 고쳐야 조리표가 바뀐다.
  //    items 는 두 모양이 섞여 있다. 신형은 [{delivery_date, sets:[…], date_qty}],
  //    구형은 메뉴 목록 그대로 [{menu, qty}] 다.
  const menuList = Object.entries(menus).map(([menu, qty]) => ({ menu, qty }));
  const nextItems = rewriteMenusOn(o.items, date, menuList, newQty);

  const { error } = await sb.from('baby_food_orders').update({
    items: nextItems,
    total_qty: newQty,
    total_price: newPrice,
    shipping_fee: newShipping,
    points_earned: newEarned,
    ...(newPaidNote ? { paid_note: newPaidNote } : {}),
  }).eq('id', id);

  if (error) {
    // 잔액을 이미 옮겼으면 되돌린다 — 고치지도 못했는데 팩이 빠져 있으면 안 된다
    if (prepaidMoved !== 0 && prepaidCust) {
      await movePrepaid(sb, prepaidCust.id, { delta: prepaidMoved, kind });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // 선결제 장부 — 주문이 실제로 고쳐진 뒤에만 남긴다(실패해서 되돌린 건 오간 팩이 없다)
  if (prepaidCust) {
    await recordPrepaid(sb, {
      customerId: prepaidCust.id, phone: o.customer_phone, babyName: o.baby_name,
      kind: '수정', packs: -prepaidMoved, balanceAfter: prepaidCust.after, orderId: id,
      memo: `${prepaidCust.tag}조리표에서 ${oldQty}→${newQty}팩`,
    });
  }

  // ── 3) 적립 포인트 차이 맞추기 (실패해도 주문은 이미 고쳐졌다 — 로그만)
  if (pointDelta !== 0 && o.order_type !== '선결제') {
    try {
      let cust = (await sb.from('baby_food_customers').select('id, points')
        .eq('phone', o.customer_phone).maybeSingle()).data;
      for (let i = 0; cust && i < 3; i++) {
        const base = Number(cust.points) || 0;
        const { data: upd } = await sb.from('baby_food_customers')
          .update({ points: Math.max(0, base + pointDelta) })
          .eq('id', cust.id).eq('points', base).select('id');
        if (upd && upd.length > 0) break;
        cust = (await sb.from('baby_food_customers').select('id, points').eq('id', cust.id).maybeSingle()).data;
      }
    } catch (e) { console.error('[order-edit points]', e); }
  }

  const { data: fresh } = await sb.from('baby_food_orders').select('*').eq('id', id).single();
  return NextResponse.json({
    ok: true, row: fresh,
    qty: { was: oldQty, now: newQty },
    price: { was: oldPrice, now: newPrice },
    prepaid_delta: prepaidMoved ? -prepaidMoved : 0,
  });
}
