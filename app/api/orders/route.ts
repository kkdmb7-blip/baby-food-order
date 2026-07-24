import { NextRequest, NextResponse } from 'next/server';
import { supabaseService, STAGES, MIN_ORDER_QTY, getPrice, type StageType } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';
import { kstToday } from '@/lib/dates';

// POST — 신규 주문 (클라이언트 → service_role 경유)
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const baby_name = String(b.baby_name || '').trim().slice(0, 20);
    const months = parseInt(b.months);
    const customer_phone = String(b.customer_phone || '').replace(/\D/g, '');
    const address = String(b.address || '').trim().slice(0, 200);
    const address_detail = String(b.address_detail || '').trim().slice(0, 100) || null;
    const door_password = String(b.door_password || '').trim().slice(0, 30) || null;
    const stage = String(b.stage || '') as StageType;
    const volume = Number(b.volume);
    const items = Array.isArray(b.items) ? b.items : [];
    const total_qty = Number(b.total_qty);
    const delivery_date = String(b.delivery_date || '');
    const order_type = String(b.order_type || '일반');
    const allergies = Array.isArray(b.allergies)
      ? b.allergies.map((x: any) => String(x).slice(0, 20)).slice(0, 40)
      : [];

    // 검증
    if (!baby_name) return bad('아기 이름이 필요합니다');
    if (!months || months <= 0) return bad('개월수를 확인해주세요');
    if (!/^\d{10,11}$/.test(customer_phone)) return bad('연락처를 확인해주세요');
    if (!address) return bad('주소가 필요합니다');
    if (total_qty < 1) return bad('수량 오류');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(delivery_date)) return bad('배송일 형식 오류');
    if (delivery_date <= kstToday()) return bad('조리일은 내일 이후여야 합니다');

    // 복합 주문: 배송 그룹(월화/목금)별 합산 최소 3팩 검증
    if (Array.isArray(items) && items.length > 0 && items[0].delivery_date) {
      const groupQty: Record<string, number> = {};
      for (const d of items) {
        const dow = new Date(d.delivery_date + 'T00:00:00Z').getUTCDay();
        const key = (dow === 1 || dow === 2) ? 'A' : (dow === 4 || dow === 5) ? 'B' : d.delivery_date;
        groupQty[key] = (groupQty[key] || 0) + (d.date_qty || 0);
      }
      for (const [key, qty] of Object.entries(groupQty)) {
        // 수요일(반찬)은 최소 수량 체크 제외
        if (key.length === 10) {
          const dow = new Date(key + 'T00:00:00Z').getUTCDay();
          if (dow === 3) continue;
        }
        if (qty < MIN_ORDER_QTY) {
          const label = key === 'A' ? '월·화 합산' : key === 'B' ? '목·금 합산' : key;
          return bad(`${label} ${qty}팩 — 1회 배송 최소 ${MIN_ORDER_QTY}팩 이상이어야 합니다`);
        }
      }
    }

    // 복합 주문(mixed)은 클라이언트 계산 total_price 사용, 단일은 서버 재계산
    let total_price: number;
    const isMulti = Array.isArray(items) && items.length > 0 && items[0].delivery_date;
    if (isMulti) {
      // 아이템별 소계 합산으로 서버 재계산 (반찬세트 포함)
      total_price = items.reduce((sum: number, d: any) =>
        sum + (d.sets || []).reduce((s2: number, s: any) => {
          if (s.stage === '반찬세트') return s2 + 35000 * (s.qty || 0);
          return s2 + (getPrice(s.stage as StageType, s.volume) || 0) * (s.qty || 0);
        }, 0), 0);
      if (total_price <= 0) return bad('가격 계산 오류');
    } else {
      const pricePerPack = getPrice(stage, volume);
      if (!pricePerPack) return bad('가격 정보 오류');
      total_price = total_qty * pricePerPack;
    }

    const sb = supabaseService();

    // 선결제 고객이면 잔여 차감
    let customer_id: string | null = null;
    if (order_type === '선결제') {
      const { data: cust } = await sb
        .from('baby_food_customers')
        .select('id, prepaid_balance')
        .eq('customer_phone', customer_phone)
        .single();
      if (!cust) return bad('선결제 고객 정보를 찾을 수 없습니다');
      if (cust.prepaid_balance < total_qty)
        return bad(`잔여 팩이 부족합니다 (잔여: ${cust.prepaid_balance}팩, 필요: ${total_qty}팩)`);
      const { error: ue } = await sb
        .from('baby_food_customers')
        .update({ prepaid_balance: cust.prepaid_balance - total_qty })
        .eq('id', cust.id);
      if (ue) return NextResponse.json({ ok: false, error: '잔여 차감 실패' }, { status: 500 });
      customer_id = cust.id;
    }

    const { data, error } = await sb
      .from('baby_food_orders')
      .insert({
        baby_name, months, customer_phone, address, address_detail, door_password,
        stage, volume, items, total_qty, total_price, delivery_date,
        order_type, status: '접수', customer_id, allergies
      })
      .select('id')
      .single();

    if (error) {
      console.error('[orders POST]', error);
      return NextResponse.json({ ok: false, error: 'DB 저장 실패' }, { status: 500 });
    }

    // G. 포인트 적립 (결제액 3%) — 전화번호로 고객 찾거나 생성 (실패 무시)
    let pointsEarned = 0;
    try {
      pointsEarned = Math.floor(total_price * 0.03);
      if (pointsEarned > 0) {
        const { data: existing } = await sb
          .from('baby_food_customers')
          .select('id, points')
          .eq('phone', customer_phone)
          .maybeSingle();
        if (existing) {
          await sb.from('baby_food_customers')
            .update({ points: (existing.points || 0) + pointsEarned })
            .eq('id', existing.id);
        } else {
          await sb.from('baby_food_customers')
            .insert({ baby_name, phone: customer_phone, points: pointsEarned });
        }
      }
    } catch (e) { console.error('[points]', e); }

    // 이메일 알림 (실패 무시)
    void fetch(new URL('/api/notify', req.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: data.id, baby_name, delivery_date, stage, volume, total_qty, total_price, customer_phone, address })
    }).catch(() => {});

    return NextResponse.json({ ok: true, id: data.id, points_earned: pointsEarned });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ ok: false, error: '잘못된 요청' }, { status: 400 });
  }
}

// GET — 관리자 조회
export async function GET(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const p = new URL(req.url).searchParams;
  const from = p.get('from');
  const to = p.get('to');
  const date = p.get('date');
  const status = p.get('status');

  const sb = supabaseService();
  let q = sb.from('baby_food_orders').select('*').order('delivery_date').order('created_at', { ascending: false });
  if (date) q = q.eq('delivery_date', date);
  else {
    if (from) q = q.gte('delivery_date', from);
    if (to) q = q.lte('delivery_date', to);
  }
  if (status) q = q.eq('status', status);

  const { data, error } = await q.limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ orders: data });
}

function bad(msg: string) {
  return NextResponse.json({ ok: false, error: msg }, { status: 400 });
}
