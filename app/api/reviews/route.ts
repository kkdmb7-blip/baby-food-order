import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';

const REVIEW_BONUS = 1000;

// GET — 공개 후기 목록(최근 20개) + 전체 평균별점·개수 (전화번호는 노출하지 않음)
export async function GET() {
  const sb = supabaseService();
  const [{ data, error }, { data: allRatings }] = await Promise.all([
    sb.from('baby_food_reviews').select('id, baby_name, rating, content, created_at')
      .eq('is_approved', true).order('created_at', { ascending: false }).limit(20),
    sb.from('baby_food_reviews').select('rating').eq('is_approved', true),
  ]);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const ratings = allRatings || [];
  const count = ratings.length;
  const avg = count > 0 ? Math.round((ratings.reduce((s, r) => s + r.rating, 0) / count) * 10) / 10 : 0;

  return NextResponse.json({ ok: true, reviews: data || [], summary: { count, avg } });
}

// POST — 후기 작성 (실제 주문 이력이 있는 연락처만 가능, 첫 후기에 한해 포인트 적립)
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const customer_phone = String(b.customer_phone || '').replace(/\D/g, '');
    const baby_name = String(b.baby_name || '').trim().slice(0, 20);
    const rating = Math.round(Number(b.rating));
    const content = String(b.content || '').trim().slice(0, 500);

    if (!/^\d{10,11}$/.test(customer_phone)) return bad('연락처를 확인해주세요');
    if (!baby_name) return bad('아기 이름이 필요합니다');
    if (!(rating >= 1 && rating <= 5)) return bad('별점을 선택해주세요');
    if (content.length < 5) return bad('후기 내용을 5자 이상 입력해주세요');

    const sb = supabaseService();

    // 실제 주문 이력이 있는 연락처만 후기 작성 가능 (가짜 후기 방지)
    const { data: priorOrder } = await sb
      .from('baby_food_orders').select('id').eq('customer_phone', customer_phone).limit(1).maybeSingle();
    if (!priorOrder) return bad('주문 이력이 있는 연락처만 후기를 남길 수 있어요');

    // 첫 후기인지 확인 (포인트는 연락처당 1회만 지급)
    const { data: priorReview } = await sb
      .from('baby_food_reviews').select('id').eq('customer_phone', customer_phone).limit(1).maybeSingle();
    const isFirstReview = !priorReview;

    const { data, error } = await sb
      .from('baby_food_reviews')
      .insert({ customer_phone, baby_name, rating, content, points_awarded: isFirstReview })
      .select('id')
      .single();
    if (error) {
      console.error('[reviews POST]', error);
      return NextResponse.json({ ok: false, error: 'DB 저장 실패' }, { status: 500 });
    }

    let bonus = 0;
    if (isFirstReview) {
      try {
        const { data: cust } = await sb
          .from('baby_food_customers').select('id, points').eq('phone', customer_phone).maybeSingle();
        if (cust) {
          await sb.from('baby_food_customers').update({ points: (cust.points || 0) + REVIEW_BONUS }).eq('id', cust.id);
        } else {
          await sb.from('baby_food_customers').insert({ baby_name, phone: customer_phone, points: REVIEW_BONUS });
        }
        bonus = REVIEW_BONUS;
      } catch (e) { console.error('[review points]', e); }
    }

    return NextResponse.json({ ok: true, id: data.id, bonus });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ ok: false, error: '잘못된 요청' }, { status: 400 });
  }
}

function bad(msg: string) {
  return NextResponse.json({ ok: false, error: msg }, { status: 400 });
}
