import { NextRequest, NextResponse } from 'next/server';
import {
  supabaseService, MENU_TYPES, MIN_ORDER_QTY, getPrice, tierOf,
  hanwooAllowed, othersNeededForHanwoo, HANWOO_MAX_RATIO,
  type StageType,
} from '@/lib/supabase';
import { kstToday } from '@/lib/dates';
import { notify } from '@/lib/notify';

const norm = (s: string) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');

// POST /api/my/regular-occurrence — 정기배송의 "이번 회차만" 손보기
//   action: 'skip'   이번 주 한 번만 건너뛰기 (정기배송은 그대로 유지)
//           'update' 이번 회차 수량만 변경
//
// ⚠️ 손댄 회차는 regular_locked를 켜서 크론이 다시 스케줄대로 덮어쓰지 못하게 한다.
//    (크론은 스케줄과 다르면 갱신하도록 돼 있어서, 표시가 없으면 자정에 원상복구돼 버림)
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const orderId = String(b.order_id || '');
    const phone = String(b.phone || '').replace(/\D/g, '');
    const name = norm(b.baby_name || '');
    const action = b.action === 'skip' ? 'skip' : b.action === 'update' ? 'update' : null;

    if (!/^[0-9a-f-]{36}$/i.test(orderId)) return bad('잘못된 요청');
    if (!/^\d{10,11}$/.test(phone)) return bad('연락처를 확인해주세요');
    if (!name) return bad('아기 이름을 입력해주세요');
    if (!action) return bad('요청 내용이 올바르지 않아요');

    const sb = supabaseService();
    const { data: order } = await sb
      .from('baby_food_orders')
      .select('id, status, order_type, baby_name, customer_phone, delivery_date, stage, volume, delivery_method, items, memo')
      .eq('id', orderId).single();
    if (!order) return bad('주문을 찾을 수 없어요');
    if (order.customer_phone !== phone || norm(order.baby_name) !== name) return bad('본인 주문만 변경할 수 있어요');
    if (order.order_type !== '정기') return bad('정기배송 주문이 아니에요');
    if (order.status !== '접수') return bad('이미 준비가 시작된 회차는 변경할 수 없어요. 문의해주세요.');
    if (order.delivery_date <= kstToday()) return bad('조리일이 지난 회차는 변경할 수 없어요');

    if (action === 'skip') {
      // eq('status','접수')로 "내가 확인한 상태 그대로일 때만" — 연타/동시 요청 방지
      const memo = [String(order.memo || ''), '이번 회차 건너뛰기(손님)'].filter(Boolean).join(' / ').slice(0, 200);
      const { data: updated, error } = await sb.from('baby_food_orders')
        .update({ status: '취소', regular_locked: true, memo })
        .eq('id', orderId).eq('status', '접수').select('id');
      if (error) return NextResponse.json({ ok: false, error: 'DB 저장 실패' }, { status: 500 });
      if (!updated?.length) return bad('이미 처리된 회차예요');

      void notify('regular-skip-one', {
        아기: order.baby_name, 조리일: order.delivery_date, 연락처: order.customer_phone,
      }, '정기배송 1회 건너뛰기');
      return NextResponse.json({ ok: true, action, delivery_date: order.delivery_date });
    }

    // ── 이번 회차 수량 변경 ──────────────────────────────────────
    const stage = order.stage as StageType;
    const volume = Number(order.volume);
    const menus = MENU_TYPES
      .map(m => ({ menu: m, qty: Math.min(10, Math.max(0, Number(b.menus?.[m]) || 0)) }))
      .filter(m => m.qty > 0);
    const qty = menus.reduce((a, m) => a + m.qty, 0);
    if (qty < 1) return bad('수량을 1팩 이상 담아주세요');

    // 새 주문과 같은 규칙을 그대로 적용 — 여기만 빠져나가면 규칙이 무의미해진다
    const hanwoo = menus.find(m => m.menu === '한우')?.qty || 0;
    const others = qty - hanwoo;
    if (!hanwooAllowed(hanwoo, others)) {
      return bad(`한우 ${hanwoo}팩 / 나머지 ${others}팩 — 한우는 나머지 메뉴의 ${HANWOO_MAX_RATIO}배까지만 가능해요. 닭이나 기타를 ${othersNeededForHanwoo(hanwoo, others)}팩 더 담아주세요.`);
    }
    if (qty < MIN_ORDER_QTY) {
      return bad(`배송은 1회 ${MIN_ORDER_QTY}팩부터예요. 이번 회차를 건너뛰시려면 '이번 회차 건너뛰기'를 눌러주세요.`);
    }

    const tier = tierOf(order.delivery_method);
    const pricePer = getPrice(stage, volume, tier);
    if (!pricePer) return bad('가격 정보 오류');
    const items = [{
      delivery_date: order.delivery_date,
      sets: [{ stage, volume, price_per: pricePer, simple: false, menus, qty, subtotal: pricePer * qty }],
      date_qty: qty, date_price: pricePer * qty,
    }];

    const { data: updated, error } = await sb.from('baby_food_orders')
      .update({ items, total_qty: qty, total_price: pricePer * qty, regular_locked: true })
      .eq('id', orderId).eq('status', '접수').select('id');
    if (error) return NextResponse.json({ ok: false, error: 'DB 저장 실패' }, { status: 500 });
    if (!updated?.length) return bad('이미 처리된 회차예요');

    void notify('regular-change-one', {
      아기: order.baby_name, 조리일: order.delivery_date,
      변경: `${qty}팩 (${menus.map(m => `${m.menu} ${m.qty}`).join(' · ')})`,
      연락처: order.customer_phone,
    }, '정기배송 1회 수량변경');
    return NextResponse.json({ ok: true, action, qty, total_price: pricePer * qty });
  } catch {
    return NextResponse.json({ ok: false, error: '잘못된 요청' }, { status: 400 });
  }
}

function bad(msg: string) { return NextResponse.json({ ok: false, error: msg }, { status: 400 }); }
