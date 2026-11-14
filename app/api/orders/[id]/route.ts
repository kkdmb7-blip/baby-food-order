import { NextRequest, NextResponse } from 'next/server';
import { supabaseService, STAGE_OPTIONS, getPrice, shippingFeeFor, tierOf, type StageType } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';
import { applyCancelReversal } from '@/lib/orderCancel';
import { orderDates } from '@/lib/orderItems';
import { sendStatusPush, statusPushText } from '@/lib/push';
import { defaultArrivalNote } from '@/lib/arrival';

const STATUSES = ['접수', '준비중', '배송중', '배송완료', '취소'];

export async function PATCH(req: NextRequest, ctx: { params: { id: string } }) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const id = ctx.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const { status } = body;

  const sb = supabaseService();

  // 메모만 저장하는 경우 — 상태 변경 로직(취소 환불 등)을 타지 않게 여기서 끝낸다
  if (status === undefined && typeof body.memo === 'string') {
    const memo = String(body.memo).slice(0, 200).trim() || null;
    const { error } = await sb.from('baby_food_orders').update({ memo }).eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, memo });
  }

  // 도착 메시지 — 배송 후 사장님이 남기는 한마디. 손님 앱 '내 주문'에 보이고, 알림을 켠 손님에겐 푸시도 간다.
  // 글을 비워 보내면 기본 문구를 쓴다(여러 건 한꺼번에 보낼 때). 아직 배송완료가 아니면 배송완료로 바꾼다.
  // 돈이 걸린 상태 변경(취소)과는 무관하므로 아래 상태 변경 로직을 타지 않는다.
  if (status === undefined && body.arrive === true) {
    const { data: o } = await sb.from('baby_food_orders')
      .select('id, status, baby_name, customer_phone, delivery_date, receive_method').eq('id', id).single();
    if (!o) return NextResponse.json({ ok: false, error: '주문 없음' }, { status: 404 });
    if (o.status === '취소') return NextResponse.json({ ok: false, error: '취소된 주문이에요' }, { status: 409 });
    const typed = typeof body.arrival_note === 'string' ? body.arrival_note.trim().slice(0, 200) : '';
    const note = typed || defaultArrivalNote(o.baby_name, o.receive_method);
    const arrived_at = new Date().toISOString();
    const patch: Record<string, any> = { arrival_note: note, arrived_at };
    if (o.status !== '배송완료') patch.status = '배송완료';
    const { error } = await sb.from('baby_food_orders').update(patch).eq('id', id).neq('status', '취소');
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    void sendStatusPush(sb, o.customer_phone, `${o.baby_name} 이유식이 도착했어요`, note);
    return NextResponse.json({ ok: true, arrival_note: note, arrived_at, status: '배송완료' });
  }

  // 정보 나중에 넣기 — 조리표·입금 표 아래 줄에서 이름·팩수만으로 먼저 넣은 아이(연락처·주소 빈 칸)
  // { info: { customer_phone, address, address_detail?, door_password?, months, receive_method?, delivery_method? } }
  // 그 연락처의 손님 카드가 있으면 잇고, 없으면 새로 만든다. 배송 방법이 바뀌면 값(지역 인상분·배송비)을 다시 계산한다.
  if (status === undefined && body.info && typeof body.info === 'object') {
    const i = body.info;
    const phone = String(i.customer_phone || '').replace(/\D/g, '');
    const address = String(i.address || '').trim().slice(0, 200);
    const months = parseInt(i.months);
    if (!/^\d{10,11}$/.test(phone)) return NextResponse.json({ ok: false, error: '연락처를 확인해 주세요' }, { status: 400 });
    if (!address && i.receive_method !== '픽업') return NextResponse.json({ ok: false, error: '주소를 넣어 주세요' }, { status: 400 });
    if (!(months > 0)) return NextResponse.json({ ok: false, error: '개월수를 넣어 주세요' }, { status: 400 });
    const { data: o } = await sb.from('baby_food_orders').select('*').eq('id', id).single();
    if (!o) return NextResponse.json({ ok: false, error: '주문 없음' }, { status: 404 });
    const receive_method = i.receive_method === '픽업' ? '픽업' : '배송';
    const delivery_method = receive_method === '픽업' ? '직배송'
      : ['직배송', '당일배송', '택배익일배송'].includes(i.delivery_method) ? i.delivery_method : (o.delivery_method || '직배송');
    const patch: Record<string, any> = {
      customer_phone: phone, address, months, receive_method, delivery_method,
      address_detail: String(i.address_detail || '').trim().slice(0, 100) || null,
      door_password: String(i.door_password || '').trim().slice(0, 30) || null,
    };
    // 값 다시 계산 — 이유식 한 칸짜리 일반 주문이고 아직 입금 전일 때만 (선결제·입금된 주문은 돈이 이미 오갔다)
    const st = String(o.stage || '') as StageType;
    if (!o.paid && o.order_type === '일반' && STAGE_OPTIONS[st] && o.volume) {
      const tier = receive_method === '픽업' ? '직배송' : tierOf(delivery_method);
      const per = getPrice(st, Number(o.volume), tier);
      if (per) {
        patch.total_price = per * (Number(o.total_qty) || 0);
        patch.shipping_fee = shippingFeeFor(tier, Number(o.total_qty) || 0, patch.total_price);
      }
    }
    // 손님 카드 — 연락처로 찾고 없으면 만든다
    const { data: c0 } = await sb.from('baby_food_customers').select('id').eq('phone', phone).maybeSingle();
    let cid = c0?.id as string | undefined;
    if (!cid) {
      const { data: cn } = await sb.from('baby_food_customers').insert({ baby_name: o.baby_name, phone, points: 0 }).select('id').single();
      cid = cn?.id;
    }
    if (cid) patch.customer_id = cid;
    const { data: row, error } = await sb.from('baby_food_orders').update(patch).eq('id', id).select('*').single();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, row });
  }

  // 배송 칸 한 글자 고치기 — 조리표·입금 표 '배송' 칸을 눌러 빈칸 → 택 → 내 → 빈칸
  // 2026-11-14 사장님: "아래 추가해서 위로 올라갔을 때 택배도 적을 수 있게"
  // { ship: '' | '택' | '내' } — 택·내 = 택배(내 = 하루 보관했다 다음 날 것과 합쳐 택배, 메모 '내일 합쳐 택배').
  // 값(지역 인상분·배송비)은 정보 넣기와 같은 규칙으로 — 입금 전 일반 주문만 다시 계산한다.
  if (status === undefined && typeof body.ship === 'string') {
    const s = body.ship;
    if (!['', '택', '내'].includes(s)) return NextResponse.json({ ok: false, error: 'invalid ship' }, { status: 400 });
    const { data: o } = await sb.from('baby_food_orders').select('*').eq('id', id).single();
    if (!o) return NextResponse.json({ ok: false, error: '주문 없음' }, { status: 404 });
    if (o.status === '취소') return NextResponse.json({ ok: false, error: '취소된 주문이에요' }, { status: 409 });
    if (o.receive_method === '픽업') return NextResponse.json({ ok: false, error: '픽업 주문이에요 — 정보 넣기에서 바꿔 주세요' }, { status: 409 });
    const baseMemo = String(o.memo || '').replace(/\s*[·,/]?\s*(엑셀 표시 '내'|내일\s*합쳐(\s*택배)?)/g, '').trim();
    const memo = s === '내' ? (baseMemo ? `${baseMemo} · 내일 합쳐 택배` : '내일 합쳐 택배') : (baseMemo || null);
    const wasCourier = String(o.delivery_method || '').includes('택배');
    const delivery_method = s ? '택배익일배송'
      : wasCourier ? (/강서구|양천구/.test(String(o.address || '')) || !o.address ? '직배송' : '당일배송') : (o.delivery_method || '직배송');
    const patch: Record<string, any> = { memo, delivery_method };
    const st = String(o.stage || '') as StageType;
    if (!o.paid && o.order_type === '일반' && STAGE_OPTIONS[st] && o.volume) {
      const tier = tierOf(delivery_method);
      const per = getPrice(st, Number(o.volume), tier);
      if (per) {
        patch.total_price = per * (Number(o.total_qty) || 0);
        patch.shipping_fee = shippingFeeFor(tier, Number(o.total_qty) || 0, patch.total_price);
      }
    }
    const { data: row, error } = await sb.from('baby_food_orders').update(patch).eq('id', id).select('*').single();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, row });
  }

  // 아기 이름 고치기 — 조리표에 찍히는 이름은 카카오 채널에 저장해 둔 이름과 같아야 한다.
  // 동명이인이면 사장님이 카톡에 '찬희2', '찬희3' 으로 저장해 두시므로, 앱에서도
  // 그대로 고칠 수 있어야 한다. 앱이 꼬리표를 붙여 맞추면 카톡과 오히려 어긋난다.
  if (status === undefined && typeof body.baby_name === 'string') {
    const baby_name = String(body.baby_name).trim().slice(0, 20);
    if (!baby_name) return NextResponse.json({ error: '이름이 비었어요' }, { status: 400 });
    const { error } = await sb.from('baby_food_orders').update({ baby_name }).eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, baby_name });
  }

  // 조리일 고치기 — 손님이 날짜를 잘못 적거나 아예 안 적는 일이 많다.
  // ⚠️ 날짜는 두 군데 있다: 윗칸(delivery_date)과 items 안쪽. 조리표·주소록·대시보드는
  //    items 쪽을 보고 날짜를 가른다(orderDates). 윗칸만 고치면 조리표에는 옛 날짜에 남는다.
  //    여러 날짜가 묶인 주문은 어느 쪽을 옮길지 알 수 없어 받지 않는다.
  if (status === undefined && typeof body.delivery_date === 'string') {
    const next = body.delivery_date.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) {
      return NextResponse.json({ ok: false, error: '날짜 형식이 아니에요' }, { status: 400 });
    }
    const { data: o } = await sb
      .from('baby_food_orders').select('id, items, delivery_date').eq('id', id).single();
    if (!o) return NextResponse.json({ ok: false, error: '주문 없음' }, { status: 404 });

    const dates = orderDates(o as any);
    if (dates.length > 1) {
      return NextResponse.json({
        ok: false,
        error: `여러 날짜(${dates.join(', ')})가 묶인 주문이라 날짜만 바꿀 수 없어요 — 취소하고 다시 넣어주세요`,
      }, { status: 409 });
    }

    const items = Array.isArray(o.items)
      ? (o.items as any[]).map(it =>
          it && typeof it === 'object' && !Array.isArray(it) && 'delivery_date' in it
            ? { ...it, delivery_date: next }
            : it)
      : o.items;

    const { error } = await sb
      .from('baby_food_orders').update({ delivery_date: next, items }).eq('id', id);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, delivery_date: next, was: o.delivery_date });
  }

  if (!STATUSES.includes(status)) return NextResponse.json({ error: 'invalid status' }, { status: 400 });

  const { data: order } = await sb
    .from('baby_food_orders')
    .select('id, status, order_type, total_qty, points_used, points_earned, customer_phone, baby_name, delivery_date, customer_id, stage, volume, items, paid_note')
    .eq('id', id).single();
  if (!order) return NextResponse.json({ error: '주문 없음' }, { status: 404 });

  const becomingCancelled = status === '취소' && order.status !== '취소';
  const uncancelling = order.status === '취소' && status !== '취소';
  const statusChanged = status !== order.status;

  // eq('status', order.status)로 "내가 읽은 상태 그대로일 때만" 바뀌게 해서, 관리자 화면 이중클릭
  // 이나 두 기기에서 동시에 상태를 바꿀 때 취소 환불(applyCancelReversal)이 두 번 실행되는 걸 막음.
  const { data: updated, error } = await sb
    .from('baby_food_orders').update({ status })
    .eq('id', id).eq('status', order.status).select('id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: '다른 곳에서 이미 상태가 변경됐어요 — 새로고침 후 다시 시도해주세요' }, { status: 409 });
  }

  if (becomingCancelled) await applyCancelReversal(sb, order, 1);
  else if (uncancelling) await applyCancelReversal(sb, order, -1);

  if (statusChanged) {
    const text = statusPushText(status, order.delivery_date);
    if (text) void sendStatusPush(sb, order.customer_phone, text.title, text.body);
  }

  return NextResponse.json({ ok: true });
}
