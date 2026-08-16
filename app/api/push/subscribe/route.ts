import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';

const norm = (s: string) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');

// POST /api/push/subscribe — 배송상태 알림 구독 등록
// ⚠️ 예전엔 전화번호만 있으면 등록돼서, 남의 번호로 구독하면 그 사람의 주문 상태·조리일
// 알림이 내 기기로 계속 왔음(개인정보 노출) — 다른 화면과 같은 2요소 확인을 건다.
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const phone = String(b.phone || '').replace(/\D/g, '');
    const name = norm(b.baby_name || '');
    const sub = b.subscription;
    if (!/^\d{10,11}$/.test(phone)) return bad('연락처를 확인해주세요');
    if (!name) return bad('아기 이름을 입력해주세요');
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return bad('구독 정보가 올바르지 않아요');

    const sb = supabaseService();

    const knownNames = new Set<string>();
    const { data: cust } = await sb.from('baby_food_customers').select('baby_name').eq('phone', phone).maybeSingle();
    if (cust?.baby_name) knownNames.add(norm(cust.baby_name));
    const { data: priorOrders } = await sb
      .from('baby_food_orders').select('baby_name').eq('customer_phone', phone).limit(20);
    (priorOrders || []).forEach(o => { if (o.baby_name) knownNames.add(norm(o.baby_name)); });
    if (knownNames.size === 0) return bad('주문 이력이 있는 연락처만 알림을 받을 수 있어요');
    if (!knownNames.has(name)) return bad('연락처와 아기 이름이 일치하지 않아요');
    const { error } = await sb.from('baby_food_push_subscriptions').upsert({
      customer_phone: phone, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth,
    }, { onConflict: 'endpoint' });
    if (error) return NextResponse.json({ ok: false, error: 'DB 저장 실패' }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ ok: false, error: '잘못된 요청' }, { status: 400 });
  }
}

// DELETE /api/push/subscribe — 알림 끄기
export async function DELETE(req: NextRequest) {
  try {
    const { endpoint } = await req.json();
    if (!endpoint) return bad('요청 오류');
    const sb = supabaseService();
    await sb.from('baby_food_push_subscriptions').delete().eq('endpoint', endpoint);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: '잘못된 요청' }, { status: 400 });
  }
}

function bad(msg: string) {
  return NextResponse.json({ ok: false, error: msg }, { status: 400 });
}
