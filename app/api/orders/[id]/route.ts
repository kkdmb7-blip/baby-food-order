import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';
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
    .select('id, status, order_type, total_qty, points_used, points_earned, customer_phone, baby_name, delivery_date')
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
