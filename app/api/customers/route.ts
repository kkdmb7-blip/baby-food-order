import { NextRequest, NextResponse } from 'next/server';
import { supabaseService, PREPAID_UNITS } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';
import { OPENWORLD_NOTE, OPENWORLD_LAST_DATE } from '@/lib/openworld';

// GET /api/customers — 고객 목록 (admin)
//
// ?q= 로 이름·번호를 찾는다. 손님은 계속 쌓이는데 PostgREST 는 1000행에서 조용히 자르므로,
// 전부 받아다 화면에서 거르면 그 뒤 손님은 검색해도 안 나온다(에러도 없이).
// 찾는 일은 서버에서 한다.
export async function GET(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const sb = supabaseService();
  const q = (req.nextUrl.searchParams.get('q') || '').trim().slice(0, 40);

  // ?id= 또는 ?phone= — 손님 한 명 (입금 탭 선결제 판이 목록에 없는 손님을 열 때)
  const oneId = req.nextUrl.searchParams.get('id');
  const onePhone = req.nextUrl.searchParams.get('phone');
  if (oneId || onePhone) {
    if (oneId && !/^[0-9a-f-]{36}$/i.test(oneId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
    const qq = oneId ? sb.from('baby_food_customers').select('*').eq('id', oneId)
      : sb.from('baby_food_customers').select('*').eq('phone', String(onePhone).replace(/\D/g, ''));
    const { data, error } = await qq.limit(1).maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ customer: data || null });
  }

  // ?all=1 — 손님 전부 + 마지막 주문일(취소 빼고). 고객관리 목록을 ㄱㄴ순으로 다 띄우고
  // 3개월 넘게 주문이 없는 손님을 아래로 따로 뺄 때 쓴다. 1000행 절단을 피하려고 나눠 받는다.
  if (req.nextUrl.searchParams.get('all') === '1') {
    const page = async (t: string, cols: string, f?: (x: any) => any) => {
      const out: any[] = [];
      for (let from = 0; ; from += 1000) {
        let qq: any = sb.from(t).select(cols).order('id').range(from, from + 999);
        if (f) qq = f(qq);
        const { data, error } = await qq;
        if (error) throw error;
        out.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      return out;
    };
    try {
      const custs = await page('baby_food_customers', '*');
      const orders = await page('baby_food_orders', 'customer_id, customer_phone, delivery_date', x => x.neq('status', '취소'));
      const byId: Record<string, string> = {}, byPhone: Record<string, string> = {};
      for (const o of orders) {
        const d = String(o.delivery_date || '');
        if (o.customer_id && (!byId[o.customer_id] || byId[o.customer_id] < d)) byId[o.customer_id] = d;
        if (o.customer_phone && (!byPhone[o.customer_phone] || byPhone[o.customer_phone] < d)) byPhone[o.customer_phone] = d;
      }
      const customers = custs.map(c => {
        const a = byId[c.id] || '', b = c.phone ? byPhone[c.phone] || '' : '';
        return { ...c, last_order: (a > b ? a : b) || null };
      });
      return NextResponse.json({ customers });
    } catch (e: any) {
      return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
    }
  }

  let query = sb.from('baby_food_customers').select('*');
  if (q) {
    // ilike 특수문자(% _ ,)가 들어오면 패턴이 깨지거나 or() 구문이 쪼개진다
    const safe = q.replace(/[%_,()]/g, '');
    if (!safe) return NextResponse.json({ customers: [] });
    const digits = safe.replace(/\D/g, '');
    const conds = [`baby_name.ilike.%${safe}%`];
    if (digits.length >= 2) conds.push(`phone.ilike.%${digits}%`);
    query = query.or(conds.join(',')).order('baby_name').limit(80);
  } else {
    query = query.or('prepaid_balance.neq.0,prepaid_banchan.gt.0,is_regular.eq.true,openworld.eq.true,prepaid_split.not.is.null,prepaid_ship.not.is.null').order('baby_name').limit(1000);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ customers: data });
}

// PATCH /api/customers — 아기 이름만 고친다 (admin)
//
// 조리표에 찍히는 이름은 카카오 채널에 저장해 둔 이름과 같아야 한다. 주문이 카톡으로
// 오니까, 종이의 이름이 카톡 이름과 다르면 누구 주문인지 맞춰볼 수가 없다.
// 동명이인은 사장님이 카톡에 '찬희2', '찬희3' 으로 저장해 두시므로 앱도 그대로 따라간다.
//
// ⚠️ 이름은 주문 행에도 따로 저장돼 있다(baby_food_orders.baby_name). 고객 쪽만 고치면
// 조리표는 옛 이름을 계속 찍는다 — 조리표가 읽는 건 주문이기 때문이다. 그래서 같은
// 연락처의 주문 이름도 함께 바꾼다. "이 집 이름은 찬희2" 가 한 번에 맞춰져야 한다.
export async function PATCH(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const id = String(b.id || '');

  // 입금자 이름(엄마·아빠 이름 등)만 고치는 경우 — 입금 대조가 이 이름으로도 손님을 찾는다
  if (id && Array.isArray(b.payer_names)) {
    const names = [...new Set(b.payer_names.map((x: any) => String(x).replace(/[^가-힣A-Za-z]/g, '').slice(0, 10)).filter((x: string) => x.length >= 2))].slice(0, 10);
    const { error } = await supabaseService().from('baby_food_customers').update({ payer_names: names }).eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, payer_names: names });
  }

  // 오픈월드(후원사업) 표시 — 켜면 이 손님의 아직 입금 안 된 주문을 대조에서 빼고, 끄면 되돌린다.
  // 입금확인된 주문(paid=true)은 건드리지 않는다.
  if (id && typeof b.openworld === 'boolean') {
    const sb = supabaseService();
    const { data: c, error: e1 } = await sb.from('baby_food_customers').update({ openworld: b.openworld }).eq('id', id).select('id, phone').single();
    if (e1 || !c) return NextResponse.json({ error: e1?.message || '손님 없음' }, { status: 500 });
    let q = sb.from('baby_food_orders').update(b.openworld ? { paid_note: OPENWORLD_NOTE } : { paid_note: null })
      .eq('paid', false).neq('status', '취소');
    if (b.openworld) q = q.lte('delivery_date', OPENWORLD_LAST_DATE); // 지원 끝난 뒤 주문은 오픈월드로 안 돌린다
    q = c.phone ? q.or(`customer_id.eq.${c.id},customer_phone.eq.${c.phone}`) : q.eq('customer_id', c.id);
    q = b.openworld ? q.is('paid_note', null) : q.like('paid_note', '오픈월드%');
    const { data: changed, error: e2 } = await q.select('id');
    if (e2) return NextResponse.json({ error: e2.message }, { status: 500 });
    return NextResponse.json({ ok: true, openworld: b.openworld, orders: changed?.length || 0 });
  }

  const baby_name = String(b.baby_name || '').trim().slice(0, 20);
  if (!id || !baby_name) return NextResponse.json({ error: '이름이 비었어요' }, { status: 400 });

  const sb = supabaseService();
  const { data: cur, error: readErr } = await sb
    .from('baby_food_customers').select('id, phone, baby_name').eq('id', id).single();
  if (readErr || !cur) return NextResponse.json({ error: '고객을 찾지 못했어요' }, { status: 404 });

  const { error } = await sb.from('baby_food_customers').update({ baby_name }).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 주문 쪽도 맞춘다. 실패해도 고객 이름은 이미 바뀌었으니 몇 건이 안 바뀌었는지 알려준다.
  let ordersUpdated = 0;
  let ordersError: string | null = null;
  const phone = String(cur.phone || '').replace(/\D/g, '');
  if (!phone) {
    // 번호 없는 손님 — 주문은 customer_id 로 이어져 있다
    const { data: rows, error: oErr } = await sb
      .from('baby_food_orders').update({ baby_name }).eq('customer_id', id).select('id');
    if (oErr) ordersError = oErr.message;
    else ordersUpdated = rows?.length || 0;
  } else {
    const { data: rows, error: oErr } = await sb
      .from('baby_food_orders').update({ baby_name })
      .eq('customer_phone', phone).select('id');
    if (oErr) ordersError = oErr.message;
    else ordersUpdated = rows?.length || 0;
  }

  return NextResponse.json({ ok: true, baby_name, was: cur.baby_name, ordersUpdated, ordersError });
}

// POST /api/customers — 고객 등록/수정 (admin)
export async function POST(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const { id, baby_name, phone, is_regular, regular_schedule, memo } = b;
  if (!baby_name || !phone) return NextResponse.json({ error: '이름·연락처 필수' }, { status: 400 });

  const sb = supabaseService();
  // ⚠️ regular_schedule을 무조건 덮어쓰면(예전엔 `|| []`), 이름·메모만 고치려고 호출해도
  // 그 고객의 정기배송 스케줄이 통째로 날아가고 cron이 조용히 그 고객을 건너뛰게 됨.
  // 값을 명시적으로 보냈을 때만 갱신한다. 형식도 배열이 아니라 객체({stage,volume,slots})가 맞음.
  const row: Record<string, any> = {
    baby_name, phone: String(phone).replace(/\D/g, ''), is_regular: !!is_regular, memo: memo || null,
  };
  if (regular_schedule !== undefined) row.regular_schedule = regular_schedule || {};
  const { data, error } = id
    ? await sb.from('baby_food_customers').update(row).eq('id', id).select('id').single()
    : await sb.from('baby_food_customers').insert(row).select('id').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data?.id });
}
