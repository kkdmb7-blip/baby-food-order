import { NextRequest, NextResponse } from 'next/server';
import { supabaseService, STAGES, getPrice, type StageType } from '@/lib/supabase';

const norm = (s: string) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');

// POST /api/my/regular — 정기배송 신청/해지
// body: { phone, baby_name, active, stage, volume, slots:[{day,qty}] }
// ⚠️ 예전엔 전화번호 형식만 확인해서, 남의 번호만 알면 그 사람 정기배송을 해지하거나
// 수량을 바꿀 수 있었음(/api/my, /api/my/cancel은 전화번호+아기이름 2요소를 보는데 여기만 빠져 있었음).
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const phone = String(b.phone || '').replace(/\D/g, '');
    const name = norm(b.baby_name || '');
    if (!/^\d{10,11}$/.test(phone)) return bad('연락처를 확인해주세요');
    if (!name) return bad('아기 이름을 입력해주세요');

    const active = !!b.active;
    const postal_code = String(b.postal_code || '').replace(/\D/g, '').slice(0, 5) || null;
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
      .from('baby_food_customers').select('id, baby_name').eq('phone', phone).maybeSingle();

    // 2요소 확인 — 이 번호로 알려진 아기 이름(고객정보 또는 주문이력)과 일치해야 함
    const knownNames = new Set<string>();
    if (existing?.baby_name) knownNames.add(norm(existing.baby_name));
    const { data: priorOrders } = await sb
      .from('baby_food_orders').select('baby_name').eq('customer_phone', phone).limit(20);
    (priorOrders || []).forEach(o => { if (o.baby_name) knownNames.add(norm(o.baby_name)); });
    if (knownNames.size > 0 && !knownNames.has(name)) {
      return bad('연락처와 아기 이름이 일치하지 않아요');
    }

    const patch: any = { is_regular: active, regular_schedule };
    if (postal_code) patch.postal_code = postal_code; // 정기배송 tier 판별용
    if (existing) {
      const { error } = await sb.from('baby_food_customers').update(patch).eq('id', existing.id);
      if (error) return NextResponse.json({ ok: false, error: '저장 실패' }, { status: 500 });
    } else {
      const { error } = await sb.from('baby_food_customers')
        .insert({ baby_name: String(b.baby_name || '정기배송').slice(0, 20), phone, ...patch });
      if (error) return NextResponse.json({ ok: false, error: '저장 실패' }, { status: 500 });
    }
    return NextResponse.json({ ok: true, active });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: '잘못된 요청' }, { status: 400 });
  }
}

function bad(msg: string) { return NextResponse.json({ ok: false, error: msg }, { status: 400 }); }
