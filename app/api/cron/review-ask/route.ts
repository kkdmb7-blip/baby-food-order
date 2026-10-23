import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';
import { sendStatusPush } from '@/lib/push';
import { kstToday } from '@/lib/dates';
import { withSubject } from '@/lib/korean';

/*
  GET /api/cron/review-ask — 배송 끝난 분께 후기를 한 번 부탁하는 푸시 (Vercel Cron 전용)

  왜 필요한가
    후기 기능은 이미 다 있다 — 작성 화면, 1,000P 적립, 승인 절차, 관리자 관리.
    그런데 아무도 "써주세요" 라고 말하지 않는다. 손님은 먹이고 나면 앱을 닫고,
    주문완료 화면에 있던 후기 단추는 그때 한 번 지나간 뒤 다시 안 보인다.
    이유식은 '아이 입에 들어가는 것' 이라 사는 쪽의 가장 큰 벽이 불안이고,
    그 벽을 깨는 것은 실제로 먹인 사람의 말뿐이다. 그래서 물어보는 자리가 필요하다.

  안전장치 (기존 정기배송 크론과 같은 방식)
    ① CRON_SECRET 인증. 환경변수가 없으면 무조건 막는다(fail-closed) —
       이 경로는 URL 만 알면 누구나 GET 할 수 있다.
    ② REVIEW_ASK_ENABLED=true 일 때만 실제로 보낸다. 기본은 꺼짐이고,
       꺼져 있으면 "누구에게 보낼 것인지" 만 돌려준다(dryRun).
       손님 폰으로 가는 알림이라, 켜는 것은 사장님이 결정해야 한다.

  두 번 묻지 않는 방법
    컬럼을 더하지 않았다(운영 DB 스키마를 건드리지 않으려고).
    대신 '배송일이 정확히 N일 전인 주문' 만 고른다. 크론이 하루 한 번 도니
    한 주문은 딱 한 번 걸린다. 날짜 창이 곧 중복 방지다.
    이미 후기를 쓴 분은 건너뛴다 — 쓴 사람에게 또 부탁하면 그게 광고다.
*/

/** 배송 며칠 뒤에 물어볼지. 먹여보고 느낌이 생길 만큼은 지나야 한다. */
const DAYS_AFTER = 3;

/*
  언제 도는가
    vercel.json 에 "0 2 * * *" — 크론 시각은 UTC 라서 한국 오전 11시다.
    아기 키우는 집에 밤 알림을 보내면 자는 아기를 깨울 수 있다. 낮에도 낮잠이 있지만
    밤보다는 낫고, 오전 11시면 대개 손이 비어 있다. 바꾸려면 vercel.json 한 줄이다.

    Hobby 요금제는 크론을 2개까지, 하루 한 번씩만 돌린다. 지금 정기배송 + 이것으로
    정확히 2개를 쓴다. 세 번째 크론이 필요해지면 하나로 합치거나 요금제를 올려야 한다.
    또 Hobby 는 '그 시각 정각' 이 아니라 그 시간대 안에서 돌려주므로 분은 의미가 없다.
*/

function kstDaysAgo(n: number): string {
  // kstToday() 가 'YYYY-MM-DD' 를 주므로 그 날짜에서 n 일을 뺀다.
  // Date 로 바꿀 때 시간대가 끼지 않도록 정오를 붙인다 — 자정 기준으로 만들면
  // 시간대 차이로 하루가 밀릴 수 있다.
  const [y, m, d] = kstToday().split('-').map(Number);
  const base = new Date(y, m - 1, d, 12, 0, 0);
  base.setDate(base.getDate() - n);
  const p = (v: number) => String(v).padStart(2, '0');
  return base.getFullYear() + '-' + p(base.getMonth() + 1) + '-' + p(base.getDate());
}

export async function GET(req: NextRequest) {
  // ① 인증
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization');
  if (!secret) {
    console.error('[cron/review-ask] CRON_SECRET 환경변수가 없어 요청을 거부합니다');
    return NextResponse.json({ ok: false, error: 'server misconfigured: CRON_SECRET missing' }, { status: 500 });
  }
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  // ② 마스터 스위치 — 기본 꺼짐
  const enabled = process.env.REVIEW_ASK_ENABLED === 'true';
  const target = kstDaysAgo(DAYS_AFTER);

  try {
    const sb = supabaseService();

    // 그날 배송분.
    //
    // 처음엔 status='배송완료' 로 골랐다. 그랬다가 운영 DB를 세어보니 주문 120건이
    // 전부 '접수' 였다 — 사장님이 상태칩을 쓰지 않는다. DB 제약을 직접 읽어 '배송중'
    // 도 허용되는 것을 확인했으니 막힌 것이 아니라, 그냥 안 쓰는 흐름이다.
    // '배송완료' 를 조건으로 두면 이 크론은 영원히 0명만 조용히 보고한다.
    //
    // 그래서 가게가 실제로 만드는 데이터로 고른다: 배송일이 지났고 취소가 아니면
    // 그날 음식은 나갔다. 10년 된 가게의 일하는 방식을 내 크론에 맞춰 바꾸게 하는 건
    // 순서가 거꾸로다.
    const { data: orders, error } = await sb
      .from('baby_food_orders')
      .select('id, baby_name, customer_phone, delivery_date, status')
      .eq('delivery_date', target)
      .neq('status', '취소');
    if (error) throw new Error(error.message);

    const rows = orders || [];
    if (rows.length === 0) {
      return NextResponse.json({
        ok: true, enabled, dryRun: !enabled, target, daysAfter: DAYS_AFTER,
        candidates: 0, willSend: 0, attempted: 0, skipped: [],
      });
    }

    // 한 사람이 그날 여러 건 받았을 수 있다 — 연락처로 묶어 한 번만 보낸다
    const phones = Array.from(new Set(rows.map(o => o.customer_phone).filter(Boolean)));

    // 이미 후기를 쓴 분은 건너뛴다
    const { data: already } = await sb
      .from('baby_food_reviews')
      .select('customer_phone')
      .in('customer_phone', phones);
    const wrote = new Set((already || []).map(r => r.customer_phone));

    // 푸시를 받을 수 있는 분만 (구독이 없으면 보낼 데가 없다)
    const { data: subs } = await sb
      .from('baby_food_push_subscriptions')
      .select('customer_phone')
      .in('customer_phone', phones);
    const subscribed = new Set((subs || []).map(s => s.customer_phone));

    const skipped: { phone: string; why: string }[] = [];
    const toSend: string[] = [];
    for (const p of phones) {
      if (wrote.has(p)) { skipped.push({ phone: p, why: '이미 후기를 씀' }); continue; }
      if (!subscribed.has(p)) { skipped.push({ phone: p, why: '푸시 구독 없음' }); continue; }
      toSend.push(p);
    }

    // 푸시를 누르면 /order 홈으로 간다 (lib/push.ts 가 url 을 '/order' 로 고정).
    // 홈에는 "후기 남기고 1,000P →" 단추가 이미 있으니 한 번 더 누르면 작성 화면이다.
    // 바로 작성 화면으로 보내려면 주문 페이지가 주소의 mode 값을 읽어야 하는데,
    // 그 페이지는 결제가 도는 화면이고 지금 로컬 환경변수가 낡아 제대로 시험할 수 없다.
    // 시험 못 하는 변경을 매출 코드에 넣지 않는다 — 한 번 더 누르는 쪽을 택했다.
    let attempted = 0;
    if (enabled) {
      for (const p of toSend) {
        const name = rows.find(o => o.customer_phone === p)?.baby_name || '';
        await sendStatusPush(
          sb, p,
          '후기를 남겨주시겠어요?',
          (name ? withSubject(name) + ' ' : '') + '잘 먹었는지 한 줄만 남겨주시면 1,000P 드려요'
        );
        attempted++;
      }
    }

    return NextResponse.json({
      ok: true,
      enabled,
      dryRun: !enabled,
      target,                      // 어느 날 배송분을 봤는지
      daysAfter: DAYS_AFTER,
      candidates: phones.length,
      willSend: toSend.length,     // 꺼져 있을 때 "보낼 대상" 수
      // '보냈다' 가 아니라 '보내달라고 했다' 다. sendStatusPush 는 VAPID 키가 없으면
      // 조용히 넘어가고, 기기가 거부한 것도 안에서 삼킨다. 숫자를 부풀리지 않으려고 이름을 이렇게 둔다.
      attempted,
      skipped,
    });
  } catch (e: any) {
    console.error('[cron/review-ask]', e);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
