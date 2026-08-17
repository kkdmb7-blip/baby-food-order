import { NextRequest, NextResponse } from 'next/server';
import { supabaseService, STAGES, MIN_ORDER_QTY, getPrice, getBanchanPrice, tierOf, type StageType, type PriceTier } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';
import { kstToday } from '@/lib/dates';
import { notify, notifyError } from '@/lib/notify';

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
    const customer_request = String(b.customer_request || '').trim().slice(0, 60) || null;
    const stage = String(b.stage || '') as StageType;
    const volume = Number(b.volume);
    const items = Array.isArray(b.items) ? b.items : [];
    // 복합(다중일자) 주문은 total_qty를 클라이언트가 보낸 값 그대로 믿지 않고 items[].sets[].qty
    // 합계로 서버가 다시 계산함 — 안 그러면 실제 배송/가격은 items로 계산되는데 total_qty만
    // 조작해서 선결제 잔액을 실제보다 적게 차감시킬 수 있음(가격 계산은 이미 items 기준으로
    // 재계산되고 있었는데 선결제 차감용 수량만 이 검증이 빠져 있었음).
    const isMulti = Array.isArray(items) && items.length > 0 && !!items[0].delivery_date;
    const total_qty = isMulti
      ? items.reduce((sum: number, d: any) =>
          sum + (d.sets || []).reduce((s2: number, s: any) => s2 + (Number(s.qty) || 0), 0), 0)
      : Number(b.total_qty);
    const delivery_date = String(b.delivery_date || '');
    const order_type = String(b.order_type || '일반');
    const allergies = Array.isArray(b.allergies)
      ? b.allergies.map((x: any) => String(x).slice(0, 20)).slice(0, 40)
      : [];
    const postal_code = String(b.postal_code || '').replace(/\D/g, '').slice(0, 5) || null;
    const zone_group = b.zone_group ? String(b.zone_group).slice(0, 30) : null;
    const delivery_method = ['직배송', '택배익일배송', '당일배송'].includes(b.delivery_method) ? b.delivery_method : '당일배송';
    const referrer_phone_input = String(b.referrer_phone || '').replace(/\D/g, '') || null;
    const referrer_code = String(b.referrer_code || '').trim().slice(0, 20) || null;
    const acquisition_source = String(b.acquisition_source || '').trim().slice(0, 40) || null;

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

    const sb = supabaseService();

    // 서버 tier 재판별 (클라이언트 값 불신) — postal_code로 dubal_zones 조회
    // 강서·양천(서울)=직배송(기본가), 그 외(두발 당일·택배)=기타(+500). postal_code 없으면 delivery_method로 폴백.
    let serverTier: PriceTier = '기타';
    if (postal_code) {
      const { data: zrow } = await sb
        .from('dubal_zones').select('sido, gu').eq('postal_code', postal_code).maybeSingle();
      serverTier = zrow && String(zrow.sido || '').includes('서울')
        && ['강서구', '양천구'].some(g => String(zrow.gu || '').includes(g))
        ? '직배송' : '기타';
    } else {
      serverTier = tierOf(delivery_method);
    }

    // 복합 주문(mixed)은 아이템별 소계, 단일은 서버 재계산 — 둘 다 serverTier 적용
    let total_price: number;
    if (isMulti) {
      total_price = items.reduce((sum: number, d: any) =>
        sum + (d.sets || []).reduce((s2: number, s: any) => {
          if (s.stage === '반찬세트') return s2 + getBanchanPrice(serverTier) * (s.qty || 0);
          return s2 + (getPrice(s.stage as StageType, s.volume, serverTier) || 0) * (s.qty || 0);
        }, 0), 0);
      if (total_price <= 0) return bad('가격 계산 오류');
    } else {
      const pricePerPack = getPrice(stage, volume, serverTier);
      if (!pricePerPack) return bad('가격 정보 오류');
      total_price = total_qty * pricePerPack;
    }

    // 선결제 고객이면 잔여 차감
    let customer_id: string | null = null;
    if (order_type === '선결제') {
      const { data: cust } = await sb
        .from('baby_food_customers')
        .select('id, prepaid_balance, baby_name')
        .eq('phone', customer_phone)
        .maybeSingle();
      if (!cust) return bad('선결제 고객 정보를 찾을 수 없습니다');
      // ⚠️ 전화번호만 맞으면 통과되던 부분 — /api/my, /api/my/cancel은 전화번호+아기이름 2요소를
      // 확인하는데 여기(선결제 주문 생성)만 전화번호 하나만 봤음. 전화번호는 비밀번호가 아니라
      // 남에게 알려질 수 있는 정보라, 이것만으로 남의 선결제 잔액을 차감하고 자기 주소로
      // 배송시킬 수 있었음 — 다른 엔드포인트와 동일하게 아기 이름까지 맞아야 진행되게 함.
      const norm = (s: string) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
      if (norm(cust.baby_name) !== norm(baby_name)) {
        return bad('선결제 고객 정보와 아기 이름이 일치하지 않습니다');
      }
      if (cust.prepaid_balance < total_qty)
        return bad(`잔여 팩이 부족합니다 (잔여: ${cust.prepaid_balance}팩, 필요: ${total_qty}팩)`);
      // ⚠️ "읽은 값 - 수량"을 그냥 덮어쓰면, 같은 고객이 거의 동시에 두 번 주문(중복클릭 등)했을 때
      // 둘 다 같은 잔액을 읽어서 각자 계산 → 마지막에 쓴 값만 남아 실제로는 1번만 차감되거나
      // 잔액 부족인데도 통과되는 경쟁조건이 생김. eq('prepaid_balance', cust.prepaid_balance)로
      // "내가 읽은 값 그대로일 때만" 갱신되게 해서, 동시 요청 중 하나는 매칭 실패로 안전하게 막는다.
      const { data: updated, error: ue } = await sb
        .from('baby_food_customers')
        .update({ prepaid_balance: cust.prepaid_balance - total_qty })
        .eq('id', cust.id)
        .eq('prepaid_balance', cust.prepaid_balance)
        .select('id');
      if (ue) return NextResponse.json({ ok: false, error: '잔여 차감 실패' }, { status: 500 });
      if (!updated || updated.length === 0) {
        return bad('처리 중 잔액이 변경됐어요 — 다시 시도해주세요 (중복 제출 방지)');
      }
      customer_id = cust.id;
    }

    // G. 포인트 사용/적립 — 일반·정기 주문만 (선결제 제외). 고객 1회 조회
    const usePointsReq = Math.max(0, Math.floor(Number(b.use_points) || 0));
    let pointsUsed = 0;
    let custRow: { id: string; points: number } | null = null;
    if (order_type !== '선결제') {
      const { data: existing } = await sb
        .from('baby_food_customers').select('id, points').eq('phone', customer_phone).maybeSingle();
      custRow = existing ? { id: existing.id, points: existing.points || 0 } : null;
      pointsUsed = Math.min(usePointsReq, custRow?.points ?? 0, total_price); // 1P = 1원
    }
    const net_price = total_price - pointsUsed;

    // 리퍼럴 링크(?ref=코드)로 왔으면 코드로 추천인 조회 — 전화번호를 텍스트에 노출 안 해도 되게.
    // 코드가 없으면(직접 입력한 경우 등) 수동 입력 전화번호를 그대로 사용.
    let referrer_phone = referrer_phone_input;
    if (referrer_code) {
      const { data: refByCode } = await sb
        .from('baby_food_customers').select('phone').eq('referral_code', referrer_code).maybeSingle();
      if (refByCode?.phone) referrer_phone = refByCode.phone;
    }

    // H. 첫주문 웰컴포인트 / 추천인 포인트 — 선결제 제외, 이 연락처로 주문한 적이 전혀 없을 때만
    const WELCOME_BONUS = 2000;
    const REFERRAL_BONUS = 3000;
    let welcomeBonus = 0;
    let referralBonus = 0;
    let referredByStored: string | null = null;
    if (order_type !== '선결제') {
      const { data: priorOrder } = await sb
        .from('baby_food_orders').select('id').eq('customer_phone', customer_phone).limit(1).maybeSingle();
      const isFirstOrder = !priorOrder;
      if (isFirstOrder && referrer_phone && referrer_phone !== customer_phone) {
        const { data: referrerOrder } = await sb
          .from('baby_food_orders').select('id').eq('customer_phone', referrer_phone).limit(1).maybeSingle();
        if (referrerOrder) { referralBonus = REFERRAL_BONUS; referredByStored = referrer_phone; }
      }
      if (isFirstOrder && referralBonus === 0) welcomeBonus = WELCOME_BONUS;
    }
    const newCustomerBonus = referralBonus || welcomeBonus;
    const pointsEarned = order_type === '선결제' ? 0 : Math.floor(net_price * 0.03) + newCustomerBonus;

    const { data, error } = await sb
      .from('baby_food_orders')
      .insert({
        baby_name, months, customer_phone, address, address_detail, door_password,
        stage, volume, items, total_qty, total_price: net_price, delivery_date, customer_request,
        order_type, status: '접수', customer_id, allergies, points_used: pointsUsed,
        postal_code, zone_group, delivery_method, referred_by_phone: referredByStored,
        points_earned: pointsEarned, acquisition_source
      })
      .select('id')
      .single();

    if (error) {
      console.error('[orders POST]', error);
      // 손님은 "저장 실패"만 보고 떠나기 때문에 알려주지 않으면 사장님은 영영 모름
      void notifyError('order-save', error, {
        아기: baby_name, 연락처: customer_phone, 조리일: delivery_date,
        수량: total_qty, 금액: net_price,
      });
      return NextResponse.json({ ok: false, error: 'DB 저장 실패' }, { status: 500 });
    }

    // 고객 포인트 갱신 (차감 + 적립) — 실패 무시
    try {
      if (order_type !== '선결제') {
        if (custRow) {
          await applyPointsDelta(sb, custRow.id, custRow.points, pointsEarned - pointsUsed);
        } else if (pointsEarned > 0) {
          await sb.from('baby_food_customers').insert({ baby_name, phone: customer_phone, points: pointsEarned });
        }
      }
      // 추천인에게도 동일 보너스 적립
      if (referralBonus > 0 && referredByStored) {
        const { data: refCust } = await sb
          .from('baby_food_customers').select('id, points').eq('phone', referredByStored).maybeSingle();
        if (refCust) {
          await applyPointsDelta(sb, refCust.id, refCust.points || 0, referralBonus);
        }
      }
    } catch (e) {
      // 포인트는 돈이라 조용히 넘기면 안 됨 — 주문은 이미 저장됐으니 흐름은 막지 않고 알림만
      console.error('[points]', e);
      void notifyError('points', e, { 아기: baby_name, 연락처: customer_phone, 주문ID: data.id });
    }

    // 텔레그램 즉시 알림 — 메일은 확인이 늦어서 새 주문을 놓치기 쉬움
    {
      const dateList = isMulti
        ? [...new Set(items.map((d: any) => d.delivery_date).filter(Boolean))].sort().join(', ')
        : delivery_date;
      void notify('order', {
        아기: baby_name,
        조리일: dateList,
        수량: `${total_qty}팩`,
        금액: `${net_price.toLocaleString()}원`,
        배송: delivery_method + (zone_group ? ` (${zone_group})` : ''),
        주소: address,
        연락처: customer_phone,
        알레르기: allergies.length ? allergies.join(', ') : undefined,
        요청: customer_request || undefined,
      }, '새 주문');
    }

    // 이메일 알림 (실패 무시)
    void fetch(new URL('/api/notify', req.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // items까지 넘겨야 알림 메일에 날짜별 구성이 풀려 나옴(복합주문이 'mixed'로만 오던 문제)
      body: JSON.stringify({ id: data.id, baby_name, delivery_date, stage, volume, items, total_qty, total_price: net_price, customer_phone, address })
    }).catch(() => {});

    return NextResponse.json({
      ok: true, id: data.id, points_earned: pointsEarned, points_used: pointsUsed, net_price,
      welcome_bonus: welcomeBonus, referral_bonus: referralBonus,
    });
  } catch (e: any) {
    console.error(e);
    void notifyError('order-exception', e, { 단계: '주문 접수 처리 중' });
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

// 포인트 잔액 갱신을 "내가 읽은 값 그대로일 때만" 갱신되게 함 — 선결제 차감과 동일한 CAS 패턴.
// 같은 고객이 두 탭/기기에서 거의 동시에 주문하면 둘 다 같은 시작 잔액을 읽어서 마지막에 쓴
// 값만 남는 경쟁조건(lost update)이 있었음 — 값이 그 사이 바뀌었으면 최신값으로 다시 읽어 재시도.
async function applyPointsDelta(sb: ReturnType<typeof supabaseService>, custId: string, knownPoints: number, delta: number) {
  let base = knownPoints;
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = Math.max(0, base + delta);
    const { data: updated } = await sb
      .from('baby_food_customers')
      .update({ points: next })
      .eq('id', custId)
      .eq('points', base)
      .select('id');
    if (updated && updated.length > 0) return;
    const { data: fresh } = await sb.from('baby_food_customers').select('points').eq('id', custId).maybeSingle();
    if (!fresh) return;
    base = fresh.points || 0;
  }
}
