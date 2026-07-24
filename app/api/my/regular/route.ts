import { NextRequest, NextResponse } from 'next/server';
import { supabaseService, STAGES, getPrice, type StageType } from '@/lib/supabase';

// POST /api/my/regular — 정기배송 신청/해지 (전화번호 게이트)
// body: { phone, baby_name?, active, stage, volume, slots:[{day,qty}] }
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const phone = String(b.phone || '').replace(/\D/g, '');
    if (!/^\d{10,11}$/.test(phone)) return bad('연락처를 확인해주세요');

    const active = !!b.active;
    let regular_schedule: any = {};
    if (active) {
      const stage = String(b.stage || '') as StageType;
      const volume = Number(b.volume);
      const slots = Array.isArray(b.slots)
        ? b.slots.filter((s: any) => ['월', '화', '목', '금'].includes(s.day) && Number(s.qty) > 0)
            .map((s: any) => ({ day: s.day, qty: Math.min(10, Math.max(0, Number(s.qty))) }))
        : [];
      if (!STAGES.includes(stage)) return bad('단계를 선택해주세요');
      if (!getPrice(stage, volume)) return bad('용량을 선택해주세요');
      if (slots.length === 0) return bad('요일과 수량을 1개 이상 선택해주세요');
      regular_schedule = { stage, volume, slots };
    }

    const sb = supabaseService();
    const { data: existing } = await sb
      .from('baby_food_customers').select('id').eq('phone', phone).maybeSingle();

    if (existing) {
      const { error } = await sb.from('baby_food_customers')
        .update({ is_regular: active, regular_schedule }).eq('id', existing.id);
      if (error) return NextResponse.json({ ok: false, error: '저장 실패' }, { status: 500 });
    } else {
      const { error } = await sb.from('baby_food_customers')
        .insert({ baby_name: String(b.baby_name || '정기배송').slice(0, 20), phone, is_regular: active, regular_schedule });
      if (error) return NextResponse.json({ ok: false, error: '저장 실패' }, { status: 500 });
    }
    return NextResponse.json({ ok: true, active });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: '잘못된 요청' }, { status: 400 });
  }
}

function bad(msg: string) { return NextResponse.json({ ok: false, error: msg }, { status: 400 }); }
