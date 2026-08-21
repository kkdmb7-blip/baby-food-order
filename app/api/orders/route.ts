import { NextRequest, NextResponse } from 'next/server';
import {
  supabaseService, STAGES, MIN_ORDER_QTY, getPrice, getBanchanPrice, tierOf,
  hanwooAllowed, othersNeededForHanwoo, HANWOO_MAX_RATIO, COOKING_DAYS, BANCHAN_DOW,
  type StageType, type PriceTier,
} from '@/lib/supabase';
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
    // 픽업(방문수령)은 1~2팩도 가능. 배송을 안 나가므로 주소록에서 빠지고, 배송비 인상(+500)도 없음.
    const receive_method = b.receive_method === '픽업' ? '픽업' : '배송';
    const referrer_phone_input = String(b.referrer_phone || '').replace(/\D/g, '') || null;
    const referrer_code = String(b.referrer_code || '').trim().slice(0, 20) || null;
    const acquisition_source = String(b.acquisition_source || '').trim().slice(0, 40) || null;

    // 검증
    if (!baby_name) return bad('아기 이름이 필요합니다');
    if (!months || months <= 0) return bad('개월수를 확인해주세요');
    if (!/^\d{10,11}$/.test(customer_phone)) return bad('연락처를 확인해주세요');
    if (!address) return bad('주소가 필요합니다');
    if (total_qty < 1) return bad('수량 오류');

    // ⚠️ items가 비어 있으면 isMulti가 false가 되어 옛 단일주문 경로로 빠지고,
    // total_qty·stage·volume만으로 금액이 계산돼 "3팩 15,000원 접수 / 조리표엔 아무것도 없음"인
    // 주문이 만들어졌음(돈은 받고 조리는 못 함). 주문 내용이 없는 주문은 받지 않는다.
    if (items.length === 0) return bad('주문 내용이 비어 있어요. 앱을 새로고침한 뒤 다시 담아주세요.');
    if (isMulti && items.some((d: any) => !Array.isArray(d.sets) || d.sets.length === 0)) {
      return bad('주문 내용이 비어 있는 날짜가 있어요. 앱을 새로고침한 뒤 다시 담아주세요.');
    }

    // order_type은 DB CHECK로만 걸러져서 "DB 저장 실패"라는 엉뚱한 메시지가 나갔음
    if (!['일반', '정기', '선결제'].includes(order_type)) return bad('주문 유형이 올바르지 않아요');

    // 세트의 qty와 메뉴별 팩수 합이 어긋나면 "값은 받았는데 조리표엔 그 팩이 없는" 주문이 된다.
    // 실제로 클라이언트가 합계는 모든 키를 더하고 메뉴 목록은 알려진 메뉴만 담는 바람에
    // 3팩 값을 받고 조리표엔 2팩만 찍힌 주문이 들어왔었음(8/16). 서버에서도 막는다.
    if (isMulti) {
      for (const d of items) {
        for (const s of (d.sets || [])) {
          if (s.simple || s.stage === '반찬세트') continue; // 간단주문·반찬은 메뉴 구성이 없음
          const menuSum = (s.menus || []).reduce((a: number, m: any) => a + (Number(m.qty) || 0), 0);
          if (menuSum !== (Number(s.qty) || 0)) {
            void notifyError('order-qty-mismatch', new Error('세트 수량 불일치'), {
              아기: baby_name, 조리일: d.delivery_date,
              단계: `${s.stage} ${s.volume}`, 세트수량: s.qty, 메뉴합: menuSum,
            });
            return bad('주문 수량이 메뉴 구성과 맞지 않아요. 앱을 새로고침한 뒤 다시 담아주세요.');
          }
        }
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(delivery_date)) return bad('배송일 형식 오류');
    if (delivery_date <= kstToday()) return bad('조리일은 내일 이후여야 합니다');

    // 조리하는 요일에만 주문을 받는다 — 이유식은 월·화·목·금, 반찬 세트는 수요일.
    // 그 밖의 날은 애초에 메뉴가 없어서 만들 수가 없다.
    // 앱에서는 그런 날짜가 보이지도 않지만 API를 직접 부르면 들어왔음(수요일·토요일 이유식이 접수됨).
    const DOW_KOR_SHORT = ['일', '월', '화', '수', '목', '금', '토'];
    const dowOf = (d: string) => new Date(d + 'T00:00:00Z').getUTCDay();
    const dayCheck = (date: string, hasYusik: boolean, hasBanchan: boolean) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '배송일 형식 오류';
      const dow = dowOf(date);
      const label = `${date}(${DOW_KOR_SHORT[dow]})`;
      if (hasYusik && !(COOKING_DAYS as readonly number[]).includes(dow)) {
        return `${label}은 이유식을 만들지 않는 날이에요. 월·화·목·금 중에서 골라주세요.`;
      }
      if (hasBanchan && dow !== BANCHAN_DOW) {
        return `${label}은 반찬 세트를 만들지 않는 날이에요. 수요일에만 주문할 수 있어요.`;
      }
      return null;
    };
    if (isMulti) {
      for (const d of items) {
        const sets = d.sets || [];
        const err = dayCheck(
          String(d.delivery_date || ''),
          sets.some((s: any) => s.stage !== '반찬세트'),
          sets.some((s: any) => s.stage === '반찬세트'),
        );
        if (err) return bad(err);
      }
    } else {
      // 옛 단일주문 형식 — 이유식만 가능한 구조라 조리 요일만 확인
      const err = dayCheck(delivery_date, true, false);
      if (err) return bad(err);
    }

    // 한우 비율 — 한우만 담은 주문은 원가 때문에 받지 않는다. 날짜(1회분)별로 본다.
    // 클라이언트에서도 담기지 않게 막지만, API를 직접 부르면 통과되므로 서버가 최종 방어선.
    if (isMulti) {
      for (const d of items) {
        let hanwoo = 0, others = 0;
        for (const s of (d.sets || [])) {
          if (s.stage === '반찬세트') continue; // 반찬은 이유식 메뉴 구성이 없음
          for (const m of (s.menus || [])) {
            const q = Number(m?.qty) || 0;
            if (m?.menu === '한우') hanwoo += q; else others += q;
          }
        }
        if (!hanwooAllowed(hanwoo, others)) {
          const need = othersNeededForHanwoo(hanwoo, others);
          return bad(`${d.delivery_date} 한우 ${hanwoo}팩 / 나머지 ${others}팩 — 한우는 나머지 메뉴의 ${HANWOO_MAX_RATIO}배까지만 가능해요. 닭이나 기타를 ${need}팩 더 담아주세요.`);
        }
      }
    }

    // 배송은 1회 3팩부터. 1~2팩은 픽업(방문수령)만 가능 —
    // 예전엔 3팩 미만을 아예 거부해서, 픽업으로 받아가겠다는 손님도 주문을 넣을 수 없었음.
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
        if (qty < MIN_ORDER_QTY && receive_method !== '픽업') {
          const label = key === 'A' ? '월·화 합산' : key === 'B' ? '목·금 합산' : key;
          return bad(`${label} ${qty}팩 — 배송은 1회 ${MIN_ORDER_QTY}팩부터예요. ${qty}팩은 픽업으로 받으실 수 있어요.`);
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
    // 픽업은 배송을 안 나가니 지역 배송비 인상분을 붙이지 않는다 — 기본가로 계산
    if (receive_method === '픽업') serverTier = '직배송';

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
        postal_code, zone_group, delivery_method, receive_method, referred_by_phone: referredByStored,
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
        // 픽업은 배송을 안 나가므로 알림에서 바로 구분돼야 함(주소록에도 안 뜸)
        배송: receive_method === '픽업' ? '픽업(방문수령)' : delivery_method + (zone_group ? ` (${zone_group})` : ''),
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

  // 이름·연락처로 찾기 — 문의 전화가 왔을 때 날짜를 옮겨가며 눈으로 찾던 걸 없앰.
  // 검색일 때는 날짜 범위를 걸지 않고 전체에서 찾는다(언제 주문했는지 모르는 게 보통이라).
  const search = String(p.get('q') || '').trim();

  const sb = supabaseService();
  let q = sb.from('baby_food_orders').select('*')
    .order('delivery_date', { ascending: false }).order('created_at', { ascending: false });

  if (search) {
    const digits = search.replace(/\D/g, '');
    // 숫자를 넣으면 연락처로, 글자를 넣으면 아기 이름으로 (부분 일치)
    q = digits.length >= 4
      ? q.ilike('customer_phone', `%${digits}%`)
      : q.ilike('baby_name', `%${search}%`);
  } else if (date) {
    q = q.eq('delivery_date', date);
  } else {
    if (from) q = q.gte('delivery_date', from);
    if (to) q = q.lte('delivery_date', to);
  }
  if (status) q = q.eq('status', status);

  const { data, error } = await q.limit(search ? 100 : 500);
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
