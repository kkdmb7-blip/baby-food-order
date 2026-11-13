import { NextRequest, NextResponse } from 'next/server';
import { supabaseService, STAGES, MENU_TYPES, getPrice, type StageType } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';
import { syncRegularOrders } from '@/lib/regularSync';
import { notifyError } from '@/lib/notify';

/*
  PUT /api/customers/[id]/regular — 사장님이 정기배송 일정을 직접 맞춘다 (admin)

  사장님: "정기배송으로 해도 중간에 변경하는 경우도 있고 … 월 중기 300그램 3팩 목 4팩 이렇게 받다가
          월요일 후기 230 6개 화요일 후기 230 3개 금요일 후기 230 6개 이런 식으로 … 유연하게 변경 가능하게"

  그래서 요일마다 단계·용량·메뉴별 팩수를 따로 받는다.
    body { active, slots:[{ day:'월', stage:'후기', volume:230, menus:{한우:2, 닭:2, 기타단백질:2} }], memo? }

  손님 화면의 정기배송(/api/my/regular)은 단계·용량을 하나만 고르므로, 거기서 저장하면 이 설정이
  하나로 합쳐진다 — 그래서 손님 화면은 요일마다 다르면 보여주기만 한다(app/order/components.tsx).
  이미 만들어진 그 주 주문은 lib/regularSync 가 바로 맞춘다(조리 시작 전 '접수' 건만).
*/
const DAYS = ['월', '화', '목', '금'] as const;

export async function PUT(req: NextRequest, ctx: { params: { id: string } }) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const active = !!b.active;
  const sb = supabaseService();

  const { data: c, error: ce } = await sb.from('baby_food_customers')
    .select('id, phone, address, regular_schedule').eq('id', ctx.params.id).maybeSingle();
  if (ce) return NextResponse.json({ error: ce.message }, { status: 500 });
  if (!c) return NextResponse.json({ error: '고객 없음' }, { status: 404 });

  let regular_schedule: any = c.regular_schedule || {};
  if (active) {
    const slots: any[] = [];
    for (const s of Array.isArray(b.slots) ? b.slots : []) {
      if (!DAYS.includes(s?.day)) continue;
      const menus = MENU_TYPES.map(m => ({ menu: m, qty: Math.min(30, Math.max(0, Math.floor(Number(s?.menus?.[m]) || 0))) }))
        .filter(m => m.qty > 0);
      const qty = menus.reduce((a, m) => a + m.qty, 0);
      if (qty === 0) continue;
      const stage = String(s.stage || '') as StageType;
      const volume = Number(s.volume);
      if (!STAGES.includes(stage)) return bad(`${s.day}요일 단계를 골라주세요`);
      if (!getPrice(stage, volume)) return bad(`${s.day}요일 용량을 골라주세요`);
      slots.push({ day: s.day, stage, volume, qty, menus });
    }
    if (slots.length === 0) return bad('받는 요일을 하나 이상 넣어주세요');
    if (!c.address) return bad('이 손님은 배송지가 없어요 — 주소가 있어야 자동 주문이 나갑니다');
    if (!/^\d{10,11}$/.test(String(c.phone || ''))) return bad('연락처가 없는 손님은 정기배송을 켤 수 없어요');
    // 전체 stage·volume 은 예전 화면·예전 코드가 읽는 값이라 첫 요일 것으로 채워 둔다
    regular_schedule = { stage: slots[0].stage, volume: slots[0].volume, slots };
  }

  const { error } = await sb.from('baby_food_customers')
    .update({ is_regular: active, regular_schedule }).eq('id', c.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let sync: any = null;
  let syncError: string | null = null;
  const enabled = process.env.REGULAR_AUTO_ENABLED === 'true';
  if (enabled) {
    try {
      const r = await syncRegularOrders(sb, true, c.phone);
      sync = { created: r.created, updated: r.updated, revived: r.revived, cancelled: r.cancelled.length, skipped: r.skipped };
    } catch (e: any) {
      syncError = e?.message || '동기화 실패';
      void notifyError('regular-sync', e, { 단계: '사장님 정기배송 저장 후 동기화' });
    }
  }
  return NextResponse.json({ ok: true, active, regular_schedule, autoEnabled: enabled, sync, syncError });
}

function bad(msg: string) { return NextResponse.json({ ok: false, error: msg }, { status: 400 }); }
