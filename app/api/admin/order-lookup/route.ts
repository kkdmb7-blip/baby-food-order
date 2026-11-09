import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';

/*
  GET /api/admin/order-lookup?q=<아기이름 또는 번호 끝자리> — 조리표에 줄을 넣을 때 쓰는 손님 찾기

  왜 필요한가
    오전 7시에 조리표를 치실 때 매번 쳐야 하는 건 사실 이름과 팩수뿐이다.
    연락처·주소·현관비번·단계·용량은 단골이면 지난 주문에 이미 있다.
    그걸 다시 타이핑하게 하면 반수동이 아니라 그냥 수동이다.

    이름 두 글자만 치면 지난 주문에서 그 집을 찾아 전부 끌어온다.
    단계와 용량까지 가져오는 게 핵심이다 — 대개 지난번과 같은 것을 시키신다.

  왜 baby_food_customers 가 아니라 주문을 보는가
    고객 표에는 이름과 번호만 있고 주소·개월수·단계·용량이 없다.
    그것들은 주문에만 있다. 그래서 주문을 사람 단위로 묶어 최신 것을 돌려준다.

  개월수
    저장된 값은 그 주문 때의 개월수다. 아기는 자라니 지금은 다르다.
    지난 주문 이후 지난 달수를 더해 짐작값을 같이 보내고,
    무엇을 근거로 짐작했는지(lastDate, lastMonths)도 함께 보낸다.
    화면에 근거를 적어 사장님이 틀린 걸 알 수 있게 하려는 것이다. 멋대로 고치지 않는다.

  읽기만 한다.
*/

export const dynamic = 'force-dynamic';

type Hit = {
  babyName: string;
  phone: string;
  address: string;
  addressDetail: string | null;
  doorPassword: string | null;
  stage: string | null;
  volume: number | null;
  postalCode: string | null;
  deliveryMethod: string | null;
  receiveMethod: string | null;
  lastDate: string;        // 마지막 조리일
  lastMonths: number;      // 그때 적힌 개월수
  guessMonths: number;     // 지금 몇 개월일지 짐작
  orders: number;          // 지금까지 몇 번
  orderType: string | null;
};

/** 'YYYY-MM-DD' 두 날짜 사이의 개월 수 (내림). 날짜까지는 보지 않는다. */
function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  if (!fy || !ty) return 0;
  const n = (ty - fy) * 12 + (tm - fm);
  return n > 0 ? n : 0;
}

export async function GET(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  if (q.length < 1) return NextResponse.json({ ok: true, hits: [] });

  const sb = supabaseService();
  const digits = q.replace(/\D/g, '');

  try {
    // 이름으로, 숫자를 넣으셨으면 번호로도 찾는다 (끝자리만 기억날 때가 있다).
    // or() 안에서 쉼표는 조건 구분자라 검색어의 쉼표는 미리 지운다.
    const safe = q.replace(/[,()*]/g, '');
    let filter = `baby_name.ilike.%${safe}%`;
    if (digits.length >= 2) filter += `,customer_phone.ilike.%${digits}%`;

    const { data, error } = await sb
      .from('baby_food_orders')
      .select('baby_name, customer_phone, address, address_detail, door_password, months, stage, volume, postal_code, delivery_method, receive_method, delivery_date, order_type, status')
      .or(filter)
      .neq('status', '취소')
      .order('delivery_date', { ascending: false })
      .limit(400);
    if (error) throw new Error(error.message);

    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

    // 사람 단위로 묶는다. 정렬이 최신순이므로 처음 만난 행이 가장 최근 주문이다.
    const byPhone = new Map<string, Hit>();
    for (const o of data || []) {
      const phone = String(o.customer_phone || '');
      if (!phone) continue;
      const seen = byPhone.get(phone);
      if (seen) { seen.orders++; continue; }
      const lastDate = String(o.delivery_date || '');
      const lastMonths = Number(o.months) || 0;
      byPhone.set(phone, {
        babyName: String(o.baby_name || ''),
        phone,
        address: String(o.address || ''),
        addressDetail: o.address_detail ?? null,
        doorPassword: o.door_password ?? null,
        stage: o.stage ?? null,
        // 복합주문은 volume 이 null 이다 — 그대로 null 로 넘기고 화면에서 고르게 한다
        volume: o.volume == null ? null : Number(o.volume),
        postalCode: o.postal_code ?? null,
        deliveryMethod: o.delivery_method ?? null,
        receiveMethod: o.receive_method ?? null,
        lastDate,
        lastMonths,
        guessMonths: lastMonths ? lastMonths + monthsBetween(lastDate, today) : 0,
        orders: 1,
        orderType: o.order_type ?? null,
      });
    }

    // 최근에 주문한 집이 위로. 같으면 많이 주문한 집이 위로.
    const hits = [...byPhone.values()]
      .sort((a, b) => b.lastDate.localeCompare(a.lastDate) || b.orders - a.orders)
      .slice(0, 8);

    return NextResponse.json({ ok: true, hits });
  } catch (e: any) {
    console.error('[admin/order-lookup]', e);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
