import { getPrice, MIN_ORDER_QTY, type StageType, type PriceTier } from '@/lib/supabase';
import { notify } from '@/lib/notify';

// 정기배송 스케줄 → 실제 주문 동기화.
// ⚠️ 이 로직은 크론(매일 자정)과 신청 저장(/api/my/regular) 두 곳에서 함께 쓴다.
// 예전엔 크론에만 있어서, 손님이 팩수를 바꿔 저장해도 자정까지 주문이 옛 팩수로 남아 있었음
// ("저장했는데 적용이 안 된다"는 게 이 문제였다).
//
// 크론이 스스로 취소한 정기 주문 표시 — 사장님이 직접 취소한 건과 구분해서 되살릴 때 씀
export const AUTO_CANCEL = '자동취소(정기 스케줄 변경)';

export type SyncResult = {
  enabled: boolean;
  regularCustomers: number;
  created: number;
  updated: number;
  revived: number;
  cancelled: string[];
  plan: any[];
  skipped: { phone: string; reason: string }[];
};

function mask(phone: string) { return '****' + String(phone || '').slice(-4); }

// 주문 내용을 "의미"만 남긴 문자열로 — 키 순서·필드 추가에 흔들리지 않게 비교용으로만 씀.
// ⚠️ JSON.stringify로 비교하면 안 됨 — jsonb는 저장할 때 키 순서를 재정렬하므로 내용이
// 같아도 문자열이 달라져서 매번 전부 불필요하게 갱신됐음.
function sig(items: any): string {
  return (Array.isArray(items) ? items : []).map((d: any) =>
    `${d?.delivery_date}#` + (Array.isArray(d?.sets) ? d.sets : []).map((s: any) =>
      [
        s?.stage, s?.volume, Number(s?.qty) || 0, Number(s?.price_per) || 0,
        (Array.isArray(s?.menus) ? s.menus : [])
          .map((m: any) => `${m?.menu}:${Number(m?.qty) || 0}`)
          .sort().join(','),
      ].join('|')
    ).join(';')
  ).sort().join('/');
}

/**
 * @param sb          service-role 클라이언트
 * @param enabled     false면 계획만 세우고 DB는 건드리지 않음(dry run)
 * @param onlyPhone   특정 손님만 동기화 (신청 저장 직후 호출용). 없으면 전체.
 */
export async function syncRegularOrders(
  sb: any, enabled: boolean, onlyPhone?: string
): Promise<SyncResult> {
  let q = sb.from('baby_food_customers')
    .select('id, baby_name, phone, is_regular, regular_schedule, postal_code, address, address_detail, door_password')
    .eq('is_regular', true);
  if (onlyPhone) q = q.eq('phone', onlyPhone);
  const { data: regulars, error } = await q;
  if (error) throw new Error(error.message);

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
  let created = 0, updated = 0, revived = 0;

  for (const c of regulars || []) {
    const sched = c.regular_schedule as any; // { stage, volume, slots:[{day, qty, menus:[{menu,qty}]}] }
    if (!sched?.stage || !sched?.volume || !Array.isArray(sched?.slots)) {
      skipped.push({ phone: mask(c.phone), reason: '스케줄 정보 없음' });
      continue;
    }
    // 주소가 없으면 배송을 나갈 수 없는 주문이 생긴다 — 만들지 않고 사장님께 알린다.
    if (!c.address) {
      skipped.push({ phone: mask(c.phone), reason: '배송지 미등록' });
      continue;
    }
    const stage = sched.stage as StageType;
    const volume = Number(sched.volume);

    // baby_food_orders.months는 CHECK (months > 0) — 0을 넣으면 저장이 매번 실패한다.
    const { data: lastOrder } = await sb
      .from('baby_food_orders').select('months')
      .eq('customer_phone', c.phone).gt('months', 0)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    const months = Number(lastOrder?.months) > 0 ? Number(lastOrder.months) : null;
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
    if (!pricePer) {
      skipped.push({ phone: mask(c.phone), reason: `가격 없음 (${stage} ${volume}g)` });
      continue;
    }

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

      // 같은 전화·배송일·정기 주문이 이미 있으면 새로 만들지 않고, 내용이 다르면 갱신한다.
      // 조리가 시작된 건(준비중 이후)은 절대 건드리지 않는다.
      const { data: exists } = await sb
        .from('baby_food_orders')
        .select('id, status, items, memo')
        .eq('customer_phone', c.phone)
        .eq('delivery_date', u.date)
        .eq('order_type', '정기')
        .maybeSingle();

      if (exists) {
        // 요일을 뺐다가 다시 넣으면, 자동취소해 둔 그 날 주문이 재생성을 영구히 막고 있었음.
        // 자동취소 표시가 있는 것만 되살린다 — 사장님이 직접 취소한 건은 그대로 둠.
        if (exists.status === '취소' && String(exists.memo || '').includes(AUTO_CANCEL)) {
          if (enabled) {
            const memo = String(exists.memo || '').split(' / ').filter((x: string) => x && x !== AUTO_CANCEL).join(' / ') || null;
            const { error: re } = await sb.from('baby_food_orders')
              .update({ status: '접수', memo, stage, volume, items, total_qty: qty, total_price: pricePer * qty })
              .eq('id', exists.id).eq('status', '취소');
            if (re) skipped.push({ phone: mask(c.phone), reason: `재개 실패: ${re.message}` });
            else revived++;
          } else {
            plan.push({ phone: mask(c.phone), date: u.date, qty, stage, volume, price: pricePer * qty, action: '재개' });
          }
          continue;
        }
        if (exists.status !== '접수') continue; // 조리·배송 단계거나 사장님이 취소한 건
        if (sig(exists.items) === sig(items)) continue;
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

  // 해지·요일 삭제분 정리 — 해지하거나 요일을 빼도 이미 만들어진 앞으로의 주문이 남아서
  // 사장님이 계속 조리·배송하게 되는 구멍이 있었음.
  // ⚠️ onlyPhone이 지정되면 그 손님 것만 정리해야 함 — 전체를 훑으면 스케줄을 읽지 않은
  //   다른 손님의 주문까지 "스케줄에 없다"고 판단해 통째로 취소해버린다.
  const cancelled: string[] = [];
  const windowStart = upcoming[0]?.date;
  const windowEnd = upcoming[upcoming.length - 1]?.date;
  if (windowStart && windowEnd) {
    let fq = sb.from('baby_food_orders')
      .select('id, customer_phone, delivery_date, memo')
      .eq('order_type', '정기').eq('status', '접수')
      .gte('delivery_date', windowStart).lte('delivery_date', windowEnd);
    if (onlyPhone) fq = fq.eq('customer_phone', onlyPhone);
    const { data: future } = await fq;
    for (const o of future || []) {
      if (keep.has(`${o.customer_phone}|${o.delivery_date}`)) continue;
      cancelled.push(`${mask(o.customer_phone)} ${o.delivery_date}`);
      if (enabled) {
        // 누가 취소했는지 남겨둔다 — 스케줄에 그 요일이 다시 들어오면 이 표시가 있는 건만 되살림
        const memo = [String(o.memo || ''), AUTO_CANCEL].filter(Boolean).join(' / ').slice(0, 200);
        await sb.from('baby_food_orders').update({ status: '취소', memo })
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

  return {
    enabled,
    regularCustomers: regulars?.length || 0,
    created, updated, revived, cancelled, plan, skipped,
  };
}
