import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';

function genCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O, 1/I 제외
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// POST /api/my/referral-code — 본인 리퍼럴 코드 발급/조회 (주문 이력 있는 연락처만)
export async function POST(req: NextRequest) {
  try {
    const { phone } = await req.json();
    const digits = String(phone || '').replace(/\D/g, '');
    if (!/^\d{10,11}$/.test(digits)) return NextResponse.json({ ok: false, error: '연락처를 확인해주세요' }, { status: 400 });

    const sb = supabaseService();
    const { data: cust } = await sb.from('baby_food_customers').select('id, referral_code').eq('phone', digits).maybeSingle();
    if (!cust) return NextResponse.json({ ok: false, error: '먼저 주문을 한 번 해주셔야 추천 코드를 받을 수 있어요' }, { status: 400 });
    if (cust.referral_code) return NextResponse.json({ ok: true, code: cust.referral_code });

    // 유니크 충돌 시 몇 번 재시도
    for (let i = 0; i < 5; i++) {
      const code = genCode();
      const { error } = await sb.from('baby_food_customers').update({ referral_code: code }).eq('id', cust.id);
      if (!error) return NextResponse.json({ ok: true, code });
    }
    return NextResponse.json({ ok: false, error: '코드 발급 실패, 다시 시도해주세요' }, { status: 500 });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ ok: false, error: '잘못된 요청' }, { status: 400 });
  }
}
