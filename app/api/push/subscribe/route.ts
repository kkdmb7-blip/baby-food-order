import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';

// POST /api/push/subscribe — 배송상태 알림 구독 등록
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const phone = String(b.phone || '').replace(/\D/g, '');
    const sub = b.subscription;
    if (!/^\d{10,11}$/.test(phone)) return bad('연락처를 확인해주세요');
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return bad('구독 정보가 올바르지 않아요');

    const sb = supabaseService();
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
