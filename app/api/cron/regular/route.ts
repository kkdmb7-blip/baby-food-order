import { NextRequest, NextResponse } from 'next/server';
import { supabaseService, getPrice, type StageType, type PriceTier } from '@/lib/supabase';

// GET /api/cron/regular — 정기배송 자동 주문 생성 (Vercel Cron 전용)
// 안전장치: ① CRON_SECRET 인증 ② REGULAR_AUTO_ENABLED=true 일 때만 실제 생성 ③ 중복 방지
export async function GET(req: NextRequest) {
  // ① 인증 — Vercel Cron은 Authorization: Bearer <CRON_SECRET> 헤더를 붙임
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization');
  if (secret && auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  // ② 마스터 스위치 — 기본 꺼짐. 사장님이 Vercel 환경변수로 켜야 실제 주문 생성
  const enabled = process.env.REGULAR_AUTO_ENABLED === 'true';

  const sb = supabaseService();
  const { data: regulars, error } = await sb
    .from('baby_food_customers')
    .select('id, baby_name, phone, is_regular, regular_schedule, postal_code')
    .eq('is_regular', true);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // 앞으로 7일간의 조리일(월1·화2·목4·금5) 계산 (KST)
  const DOW_KOR: Record<number, string> = { 1: '월', 2: '화', 4: '목', 5: '금' };
  const nowKST = Date.now() + 9 * 3600 * 1000;
  const upcoming: { date: string; day: string }[] = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(nowKST + i * 86400000);
    const dow = d.getUTCDay();
    if (DOW_KOR[dow]) upcoming.push({ date: d.toISOString().slice(0, 10), day: DOW_KOR[dow] });
  }

  const plan: any[] = [];
  let created = 0;

  for (const c of regulars || []) {
    const sched = c.regular_schedule as any; // { stage, volume, slots:[{day,qty}] }
    if (!sched?.stage || !sched?.volume || !Array.isArray(sched?.slots)) continue;
    const stage = sched.stage as StageType;
    const volume = Number(sched.volume);

    // 고객 배송지(postal_code)로 tier·배송종류 판별
    let tier: PriceTier = '기타';
    let deliveryMethod = '당일배송';
    let zoneGroup: string | null = null;
    if (c.postal_code) {
      const { data: zrow } = await sb
        .from('dubal_zones').select('sido, gu, zone_group').eq('postal_code', c.postal_code).maybeSingle();
      if (zrow && String(zrow.sido || '').includes('서울') && ['강서구', '양천구'].some(g => String(zrow.gu || '').includes(g))) {
        tier = '직배송'; deliveryMethod = '직배송';
      } else if (zrow) {
        tier = '기타'; deliveryMethod = '당일배송'; zoneGroup = zrow.zone_group || null;
      } else {
        tier = '기타'; deliveryMethod = '택배익일배송';
      }
    }
    const pricePer = getPrice(stage, volume, tier);
    if (!pricePer) continue;

    for (const u of upcoming) {
      const slot = sched.slots.find((s: any) => s.day === u.day && Number(s.qty) > 0);
      if (!slot) continue;
      const qty = Number(slot.qty);

      // ③ 중복 방지 — 같은 전화·배송일·정기 주문이 이미 있으면 건너뜀
      const { data: exists } = await sb
        .from('baby_food_orders')
        .select('id')
        .eq('customer_phone', c.phone)
        .eq('delivery_date', u.date)
        .eq('order_type', '정기')
        .maybeSingle();
      if (exists) continue;

      const rec = { phone: '****' + String(c.phone).slice(-4), date: u.date, qty, stage, volume, price: pricePer * qty };
      plan.push(rec);

      if (enabled) {
        const items = [{
          delivery_date: u.date,
          sets: [{ stage, volume, price_per: pricePer, simple: true, menus: [], qty, subtotal: pricePer * qty }],
          date_qty: qty, date_price: pricePer * qty,
        }];
        const { error: ie } = await sb.from('baby_food_orders').insert({
          baby_name: c.baby_name || '정기배송', months: 0, customer_phone: c.phone,
          address: '(정기배송 등록 주소)', stage, volume, items,
          total_qty: qty, total_price: pricePer * qty, delivery_date: u.date,
          order_type: '정기', status: '접수', customer_id: c.id,
          postal_code: c.postal_code || null, zone_group: zoneGroup, delivery_method: deliveryMethod,
        });
        if (!ie) created++;
      }
    }
  }

  return NextResponse.json({
    ok: true, enabled, dryRun: !enabled,
    regularCustomers: regulars?.length || 0,
    plannedOrders: plan.length, createdOrders: created, plan,
  });
}
