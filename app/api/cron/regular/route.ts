import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';
import { syncRegularOrders } from '@/lib/regularSync';

// GET /api/cron/regular — 정기배송 자동 주문 생성 (Vercel Cron 전용)
// 안전장치: ① CRON_SECRET 인증 ② REGULAR_AUTO_ENABLED=true 일 때만 실제 생성 ③ 중복 방지
// 실제 동기화 로직은 lib/regularSync.ts — 신청 저장(/api/my/regular)에서도 같은 함수를 쓴다.
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

  try {
    const r = await syncRegularOrders(supabaseService(), enabled);
    return NextResponse.json({
      ok: true, enabled, dryRun: !enabled,
      regularCustomers: r.regularCustomers,
      plannedOrders: r.plan.length,
      createdOrders: r.created, updatedOrders: r.updated, revivedOrders: r.revived,
      cancelledOrders: r.cancelled.length, cancelled: r.cancelled,
      plan: r.plan, skipped: r.skipped,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
