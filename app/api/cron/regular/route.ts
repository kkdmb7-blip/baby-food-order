import { NextRequest, NextResponse } from 'next/server';
import { supabaseService, getPrice, MIN_ORDER_QTY, type StageType, type PriceTier } from '@/lib/supabase';
import { notify } from '@/lib/notify';

// GET /api/cron/regular — 정기배송 자동 주문 생성 (Vercel Cron 전용)
// 안전장치: ① CRON_SECRET 인증 ② REGULAR_AUTO_ENABLED=true 일 때만 실제 생성 ③ 중복 방지
export async function GET(req: NextRequest) {
  // ① 인증 — Vercel Cron은 Authorization: Bearer <CRON_SECRET> 헤더를 붙임
  // ⚠️ 예전엔 CRON_SECRET이 설정 안 돼있으면(secret이 falsy) 검사 자체를 건너뛰어서 인증 없이도
  // 통과됐음(fail-open) — 이 엔드포인트는 URL만 알면 누구나 GET할 수 있는 공개 경로라, 이러면
  // ②(REGULAR_AUTO_ENABLED)까지 켜져 있을 때 아무나 실제 정기주문 생성을 트리거할 수 있었음.
  // 환경변수가 없으면 무조건 막도록(fail-closed) 바꿈 — cron이 갑자기 401 나면 CRON_SECRET부터 확인.
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization');
  if (!secret) {
    console.error('[cron/regular] CRON_SECRET 환경변수가 설정되지 않아 요청을 거부합니다');
    return NextResponse.json({ ok: false, error: 'server misconfigured: CRON_SECRET missing' }, { status: 500 });
  }
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  // ② 마스터 스위치 — 기본 꺼짐. 사장님이 Vercel 환경변수로 켜야 실제 주문 생성
  const enabled = process.env.REGULAR_AUTO_ENABLED === 'true';

  const sb = supabaseService();
  const { data: regulars, error } = await sb
    .from('baby_food_customers')
    .select('id, baby_name, phone, is_regular, regular_schedule, postal_code, address, address_detail, door_password')
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
  const skipped: { phone: string; reason: string }[] = [];
  const keep = new Set<string>(); // 'phone|date' — 지금 스케줄이 실제로 원하는 주문
  let created = 0;
  let updated = 0;

  for (const c of regulars || []) {
    const sched = c.regular_schedule as any; // { stage, volume, slots:[{day, qty, menus:[{menu,qty}]}] }
    if (!sched?.stage || !sched?.volume || !Array.isArray(sched?.slots)) {
      skipped.push({ phone: mask(c.phone), reason: '스케줄 정보 없음' });
      continue;
    }
    // 주소가 없으면 배송을 나갈 수 없는 주문이 생긴다 — 만들지 않고 사장님께 알린다.
    // (예전엔 address를 '(정기배송 등록 주소)'라는 문자열로 넣어서 주소록에 그대로 찍혔음)
    if (!c.address) {
      skipped.push({ phone: mask(c.phone), reason: '배송지 미등록' });
      continue;
    }
    const stage = sched.stage as StageType;
    const volume = Number(sched.volume);

    // baby_food_orders.months는 CHECK (months > 0) — 예전엔 0을 넣어서 저장이 매번 실패했고
    // 그 오류를 아무도 못 봤음(created만 세고 실패는 버렸음). 고객의 최근 주문 개월수를 그대로 쓴다.
    const { data: lastOrder } = await sb
      .from('baby_food_orders').select('months')
      .eq('customer_phone', c.phone).gt('months', 0)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    const months = Number(lastOrder?.months) > 0 ? Number(lastOrder!.months) : null;
    if (!months) {
      skipped.push({ phone: mask(c.phone), reason: '개월수 확인 불가(주문 이력 없음)' });
      continue;
    }

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
      // 조리표는 메뉴별 팩수로 찍히므로 menus를 그대로 실어야 함 — 없으면 "메뉴 미지정"이 된다.
      // 수량 기준은 menus 합으로 통일(청구는 하고 조리표엔 안 뜨는 팩이 생기지 않게).
      const menus = Array.isArray(slot.menus)
        ? slot.menus.filter((m: any) => Number(m?.qty) > 0).map((m: any) => ({ menu: String(m.menu), qty: Number(m.qty) }))
        : [];
      const qty = menus.length > 0
        ? menus.reduce((a: number, m: any) => a + m.qty, 0)
        : Number(slot.qty);
      if (qty < MIN_ORDER_QTY) { // 서버 주문 검증과 같은 규칙 — 통과 못 할 주문은 만들지 않음
        skipped.push({ phone: mask(c.phone), reason: `${u.day} ${qty}팩 — 최소 ${MIN_ORDER_QTY}팩 미달` });
        continue;
      }

      keep.add(`${c.phone}|${u.date}`);

      const items = [{
        delivery_date: u.date,
        sets: [{
          stage, volume, price_per: pricePer,
          simple: menus.length === 0, menus,
          qty, subtotal: pricePer * qty,
        }],
        date_qty: qty, date_price: pricePer * qty,
      }];

      // ③ 중복 방지 — 같은 전화·배송일·정기 주문이 이미 있으면 새로 만들지 않는다.
      // 다만 손님이 정기배송 내용(단계·용량·메뉴)을 바꾸면 이미 만들어진 앞으로의 주문도
      // 같이 바뀌어야 함 — 안 그러면 최대 7일치가 옛 구성으로 조리된다.
      // 조리가 시작된 건(준비중 이후)은 절대 건드리지 않는다.
      const { data: exists } = await sb
        .from('baby_food_orders')
        .select('id, status, items, total_qty, total_price')
        .eq('customer_phone', c.phone)
        .eq('delivery_date', u.date)
        .eq('order_type', '정기')
        .maybeSingle();
      if (exists) {
        if (exists.status !== '접수') continue; // 이미 조리·배송 단계면 그대로 둠
        const same = JSON.stringify(exists.items) === JSON.stringify(items);
        if (same) continue;
        if (enabled) {
          const { error: ue } = await sb.from('baby_food_orders')
            .update({ stage, volume, items, total_qty: qty, total_price: pricePer * qty })
            .eq('id', exists.id).eq('status', '접수'); // 읽은 뒤 상태가 바뀌었으면 덮어쓰지 않음
          if (ue) skipped.push({ phone: mask(c.phone), reason: `갱신 실패: ${ue.message}` });
          else updated++;
        } else {
          plan.push({ phone: mask(c.phone), date: u.date, qty, stage, volume, price: pricePer * qty, action: '갱신' });
        }
        continue;
      }

      plan.push({ phone: mask(c.phone), date: u.date, qty, stage, volume, price: pricePer * qty, action: '신규' });

      if (enabled) {
        const { error: ie } = await sb.from('baby_food_orders').insert({
          baby_name: c.baby_name || '정기배송', months, customer_phone: c.phone,
          address: c.address, address_detail: c.address_detail || null,
          door_password: c.door_password || null,
          stage, volume, items,
          total_qty: qty, total_price: pricePer * qty, delivery_date: u.date,
          order_type: '정기', status: '접수', customer_id: c.id,
          postal_code: c.postal_code || null, zone_group: zoneGroup, delivery_method: deliveryMethod,
        });
        if (ie) skipped.push({ phone: mask(c.phone), reason: `저장 실패: ${ie.message}` });
        else created++;
      }
    }
  }

  // ④ 해지·요일 삭제분 정리 — 손님이 정기배송을 해지하거나 특정 요일을 빼도 이미 만들어진
  // 앞으로의 주문이 그대로 남아 있어서, 사장님이 계속 조리·배송하게 되는 구멍이 있었음.
  // 아직 '접수'인 미래 정기 주문 중 지금 스케줄에 없는 건만 취소한다(조리 시작분은 건드리지 않음).
  const cancelled: string[] = [];
  const windowStart = upcoming[0]?.date;
  const windowEnd = upcoming[upcoming.length - 1]?.date;
  if (windowStart && windowEnd) {
    const { data: future } = await sb
      .from('baby_food_orders')
      .select('id, customer_phone, delivery_date')
      .eq('order_type', '정기').eq('status', '접수')
      .gte('delivery_date', windowStart).lte('delivery_date', windowEnd);
    for (const o of future || []) {
      if (keep.has(`${o.customer_phone}|${o.delivery_date}`)) continue;
      cancelled.push(`${mask(o.customer_phone)} ${o.delivery_date}`);
      if (enabled) {
        await sb.from('baby_food_orders').update({ status: '취소' })
          .eq('id', o.id).eq('status', '접수'); // 읽은 뒤 상태가 바뀌었으면 취소하지 않음
      }
    }
  }

  // 자동 주문이 조용히 안 만들어지는 게 가장 위험함 — 건너뛴 게 있으면 사장님께 알린다
  if (skipped.length > 0) {
    void notify('regular-skip', {
      건너뜀: `${skipped.length}건`,
      사유: skipped.map(s => `${s.phone} ${s.reason}`).join(' / ').slice(0, 300),
    }, '정기배송 자동주문 누락');
  }

  return NextResponse.json({
    ok: true, enabled, dryRun: !enabled,
    regularCustomers: regulars?.length || 0,
    plannedOrders: plan.length, createdOrders: created, updatedOrders: updated,
    cancelledOrders: cancelled.length, cancelled, plan, skipped,
  });
}

function mask(phone: string) { return '****' + String(phone || '').slice(-4); }
