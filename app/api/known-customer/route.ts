import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';

// POST /api/known-customer — 예전에 주문하신 손님의 주소를 불러오기
//
// ⚠️ 연락처만으로 조회하게 두면 남의 번호를 넣어 그 집 주소를 알아낼 수 있음.
// 그래서 다른 화면(/api/my, /api/my/cancel)과 동일하게 "연락처 + 아기 이름"이
// 모두 맞을 때만 돌려준다. 이름이 틀리면 존재 여부조차 알리지 않는다.
const norm = (s: string) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const phone = String(b.phone || '').replace(/\D/g, '');
    const name = norm(b.baby_name || '');
    if (!/^\d{10,11}$/.test(phone) || !name) {
      return NextResponse.json({ ok: true, found: false });
    }

    const sb = supabaseService();
    const { data } = await sb.from('baby_food_known_customers')
      .select('baby_name, address, door_password').eq('phone', phone).maybeSingle();

    // 이름이 다르면 "없음"과 똑같이 응답 (존재 여부 노출 방지)
    if (!data || norm(data.baby_name) !== name) return NextResponse.json({ ok: true, found: false });

    return NextResponse.json({
      ok: true, found: true,
      address: data.address || '', door_password: data.door_password || '',
    });
  } catch {
    return NextResponse.json({ ok: true, found: false });
  }
}
