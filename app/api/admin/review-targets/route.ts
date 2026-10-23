import { NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';
import { kstToday } from '@/lib/dates';

/*
  GET /api/admin/review-targets — 후기를 부탁할 손님 명단 (관리자 전용)

  왜 푸시 크론만으로는 안 되는가 (세어본 숫자)
    후기를 부탁할 만한 손님 42명 중, 푸시 알림으로 닿는 사람은 0명이었다.
    전체 푸시 구독이 1개뿐이다. 알림 기능은 있지만 켠 사람이 없다.
    그래서 /api/cron/review-ask 는 맞게 만들어도 지금은 아무에게도 가지 않는다.
    크론은 남겨둔다 — 구독이 늘면 그때부터 저절로 일한다. 공짜로 기다리는 장치다.

    하지만 오늘 후기를 모으려면 이미 가진 것으로 해야 한다: 연락처다.
    가게는 10년간 손님과 전화·카톡으로 이야기해 왔다. 그 통로가 유일하게 열려 있다.
    이 명단은 사장님이 직접 연락할 수 있도록 "누구에게, 왜 그 사람인지" 를 보여준다.

  누구를 고르는가
    배송일이 지났고(음식이 나갔고), 취소가 아니고, 아직 후기를 안 쓴 사람.

    처음엔 주문 횟수 많은 순으로 올렸다. 여러 번 산 사람이 할 말이 많을 테니까.
    그런데 실제로 돌려보니 2번 이상 주문한 21명의 마지막 배송이 대부분 8월이었다 —
    두 달 전이다. 그분들께 지금 맛을 물으면 기억이 없다.
    최근에 받은 분은 혀에 남아 있다. 그래서 마지막 배송이 가까운 순으로 올린다.
    주문 횟수는 지우지 않고 옆에 뱃지로 남겨, 누가 단골인지 사장님이 같이 보게 한다.

  읽기만 한다. 아무것도 쓰지 않고 아무것도 보내지 않는다.
  연락은 사장님이 사람에게 한다.
*/

export async function GET() {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const sb = supabaseService();
  const today = kstToday();

  try {
    // 주문 전체를 페이징으로 읽는다. PostgREST 는 1000행에서 조용히 자르기 때문에
    // limit 하나로 두면 가게가 커질수록 명단이 말없이 줄어든다.
    const orders: {
      delivery_date: string; status: string; customer_phone: string; baby_name: string;
    }[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb
        .from('baby_food_orders')
        .select('delivery_date, status, customer_phone, baby_name')
        .order('delivery_date', { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      orders.push(...(data || []));
      if (!data || data.length < 1000) break;
    }

    // 이미 후기를 쓴 사람
    const { data: revs, error: e2 } = await sb.from('baby_food_reviews').select('customer_phone');
    if (e2) throw new Error(e2.message);
    const wrote = new Set((revs || []).map(r => r.customer_phone));

    // 푸시로 닿는 사람 (닿으면 크론이 알아서 한다 → 손으로 연락할 필요 없음을 표시)
    const { data: subs } = await sb.from('baby_food_push_subscriptions').select('customer_phone');
    const pushable = new Set((subs || []).map(s => s.customer_phone));

    // 사람 단위로 묶는다
    type Person = { phone: string; babyName: string; orders: number; lastDelivery: string; pushable: boolean };
    const byPhone = new Map<string, Person>();
    for (const o of orders) {
      if (!o.customer_phone) continue;
      if (o.status === '취소') continue;
      if (o.delivery_date >= today) continue;          // 아직 안 나간 배송은 세지 않는다
      const cur = byPhone.get(o.customer_phone);
      if (cur) {
        cur.orders++;
        if (o.delivery_date > cur.lastDelivery) { cur.lastDelivery = o.delivery_date; cur.babyName = o.baby_name; }
      } else {
        byPhone.set(o.customer_phone, {
          phone: o.customer_phone, babyName: o.baby_name, orders: 1,
          lastDelivery: o.delivery_date, pushable: pushable.has(o.customer_phone),
        });
      }
    }

    const all = [...byPhone.values()];
    const targets = all
      .filter(p => !wrote.has(p.phone))
      .sort((a, b) => b.lastDelivery.localeCompare(a.lastDelivery) || b.orders - a.orders);

    return NextResponse.json({
      ok: true,
      today,
      targets,
      summary: {
        customers: all.length,                                   // 배송 받아본 손님 전체
        alreadyWrote: all.filter(p => wrote.has(p.phone)).length,
        toAsk: targets.length,
        repeat: all.filter(p => p.orders >= 2).length,            // 2회 이상 — 재구매
        // 푸시로 닿는 사람이 몇 명인지. 이 숫자가 0이면 크론은 아직 아무 일도 못 한다.
        reachableByPush: targets.filter(p => p.pushable).length,
      },
    });
  } catch (e: any) {
    console.error('[admin/review-targets]', e);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
