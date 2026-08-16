import { redirect } from 'next/navigation';
import { isAdminAuthed } from '@/lib/auth';
import { supabaseService, STAGES, STAGE_OPTIONS, MENU_TYPES, type Order } from '@/lib/supabase';
import { kstToday } from '@/lib/dates';
import { orderDates, slicesOn, shiftDate } from '@/lib/orderItems';
import PrintAuto from '../PrintAuto';
import PrintBar from '../PrintBar';

export const dynamic = 'force-dynamic';

const DOW_KOR = ['일', '월', '화', '수', '목', '금', '토'];

// 단계마다 용량이 2가지 — 큰 쪽(310/300)은 빨간색으로 구분 (기존 엑셀 조리표와 동일)
const BIG_VOLUME: Record<string, number> = Object.fromEntries(
  STAGES.map(s => [s, Math.max(...STAGE_OPTIONS[s].map(o => o.volume))])
);
const SMALL_VOLUME: Record<string, number> = Object.fromEntries(
  STAGES.map(s => [s, Math.min(...STAGE_OPTIONS[s].map(o => o.volume))])
);

type PersonRow = {
  name: string;
  volume: number;
  isBig: boolean;
  menus: Record<string, number>;
  allergy: boolean;
};

export default async function CookingPrint({ searchParams }: { searchParams: { date?: string } }) {
  if (!isAdminAuthed()) redirect('/admin/login');
  const date = searchParams.date || kstToday();

  const sb = supabaseService();
  const { data } = await sb.from('baby_food_orders').select('*')
    .gte('delivery_date', shiftDate(date, -21))
    .lte('delivery_date', shiftDate(date, 21))
    .neq('status', '취소').order('created_at').limit(500);
  const orders: Order[] = (data || []).filter(o => orderDates(o as any).includes(date));

  // ⚠️ 조리는 "중기 다 챙기고 → 후기 다 챙기고" 순서로 진행하므로, 사람을 한 줄에 놓고
  // 단계를 가로로 늘어놓으면 빈 칸 사이를 계속 왔다갔다 해야 함.
  // 그래서 단계별로 사람을 따로 모아 블록을 만든다(기존 엑셀도 블록마다 한 단계씩 쓰고 있었음).
  const byStage = new Map<string, PersonRow[]>();
  const banchan: { name: string; qty: number }[] = [];
  for (const o of orders) {
    for (const s of slicesOn(o as any, date)) {
      if (s.stage === '반찬세트') { banchan.push({ name: o.baby_name, qty: s.qty }); continue; }
      const stage = String(s.stage || '');
      if (!STAGES.includes(stage as any)) continue;
      const menus: Record<string, number> = {};
      let has = false;
      for (const m of MENU_TYPES) { menus[m] = s.menus[m] || 0; if (menus[m]) has = true; }
      const unspec = Math.max(0, s.qty - MENU_TYPES.reduce((a, m) => a + menus[m], 0));
      if (!has && !unspec) continue;
      if (!byStage.has(stage)) byStage.set(stage, []);
      byStage.get(stage)!.push({
        name: o.baby_name + (unspec > 0 ? ` (미지정${unspec})` : ''),
        volume: Number(s.volume) || 0,
        isBig: Number(s.volume) === BIG_VOLUME[stage],
        menus,
        allergy: (o.allergies || []).length > 0,
      });
    }
  }
  // 같은 용량끼리 붙여두면 240g 먼저 쭉, 그다음 310g 쭉 챙길 수 있음
  for (const list of byStage.values()) {
    list.sort((a, b) => a.volume - b.volume || a.name.localeCompare(b.name));
  }

  const sections = STAGES.filter(s => (byStage.get(s) || []).length > 0).map(stage => {
    const list = byStage.get(stage)!;
    const tot: Record<string, { small: number; big: number }> = {};
    for (const m of MENU_TYPES) tot[m] = { small: 0, big: 0 };
    for (const p of list) for (const m of MENU_TYPES) {
      if (p.isBig) tot[m].big += p.menus[m]; else tot[m].small += p.menus[m];
    }
    return { stage, list, tot };
  });

  const totalPacks = sections.reduce((sum, sec) =>
    sum + MENU_TYPES.reduce((a, m) => a + sec.tot[m].small + sec.tot[m].big, 0), 0);
  const banchanTotal = banchan.reduce((s, b) => s + b.qty, 0);
  const allergyRows = orders.filter(o => (o.allergies || []).length > 0);
  const memoRows = orders.filter(o => o.memo);
  const dow = DOW_KOR[new Date(date + 'T00:00:00Z').getUTCDay()];

  const cell = (v: number, red: boolean) =>
    v ? <span className={red ? 'text-red-600 font-black' : 'font-black'}>{v}</span> : <span className="text-stone-200">·</span>;

  return (
    <div className="bg-white min-h-screen p-4 text-black print:p-0">
      <PrintAuto />
      <style>{`@media print { @page { size: A4 landscape; margin: 6mm; } }`}</style>

      <div className="flex justify-between items-end mb-2 border-b-2 border-black pb-1.5">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-xl font-black">조리표</h1>
          <span className="text-base font-bold">{date} ({dow})</span>
          <span className="text-sm">총 {orders.length}명 · {totalPacks}팩{banchanTotal > 0 && ` · 반찬 ${banchanTotal}세트`}</span>
          <span className="text-[11px] text-stone-600">
            칸 순서 한우 / 닭 / 기타 · 검정 = 작은 용량 · <span className="text-red-600 font-bold">빨강 = 큰 용량</span>
          </span>
        </div>
        <PrintBar date={date} kind="cooking" />
      </div>

      {/* 단계별 블록 — 한 블록을 다 챙기고 다음 블록으로 넘어가면 됨 */}
      <div className="flex gap-2 items-start flex-wrap">
        {sections.map(sec => (
          <table key={sec.stage} className="border-collapse text-[12px] leading-none break-inside-avoid">
            <thead>
              <tr>
                <th colSpan={4} className="border-2 border-black bg-black text-white px-1.5 py-1 text-[13px]">
                  {sec.stage}
                  <span className="ml-1.5 font-normal text-[10px]">
                    {SMALL_VOLUME[sec.stage]}g / <span className="text-red-300">{BIG_VOLUME[sec.stage]}g</span>
                  </span>
                  <span className="ml-1.5 font-normal text-[10px]">{sec.list.length}명</span>
                </th>
              </tr>
              <tr className="bg-stone-200">
                <th className="border border-black px-1 py-0.5 w-[70px]">이 름</th>
                {MENU_TYPES.map(m => (
                  <th key={m} className="border border-black px-0.5 py-0.5 w-[26px] text-[10px]">
                    {m.replace('기타단백질', '기타')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sec.list.map((p, i) => {
                const prev = sec.list[i - 1];
                const volChanged = prev && prev.isBig !== p.isBig;
                return (
                  <tr key={i} className={volChanged ? 'border-t-2 border-t-black' : ''}>
                    <td className="border border-black px-1 py-[4px] font-bold whitespace-nowrap max-w-[70px] overflow-hidden">
                      {p.name}{p.allergy && <span className="text-red-600">*</span>}
                    </td>
                    {MENU_TYPES.map(m => (
                      <td key={m} className="border border-black text-center py-[4px]">
                        {cell(p.menus[m], p.isBig)}
                      </td>
                    ))}
                  </tr>
                );
              })}
              {/* 단계별 합계 — 이만큼 만들면 됨 */}
              <tr className="bg-stone-100">
                <td className="border-2 border-black px-1 py-1 text-right font-black text-[10px]">
                  {SMALL_VOLUME[sec.stage]}g
                </td>
                {MENU_TYPES.map(m => (
                  <td key={m} className="border-2 border-black text-center py-1 font-black">
                    {sec.tot[m].small || <span className="text-stone-300">·</span>}
                  </td>
                ))}
              </tr>
              <tr className="bg-stone-100">
                <td className="border-2 border-black px-1 py-1 text-right font-black text-[10px] text-red-600">
                  {BIG_VOLUME[sec.stage]}g
                </td>
                {MENU_TYPES.map(m => (
                  <td key={m} className="border-2 border-black text-center py-1 font-black text-red-600">
                    {sec.tot[m].big || <span className="text-stone-300">·</span>}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        ))}

        {banchan.length > 0 && (
          <table className="border-collapse text-[12px] leading-none break-inside-avoid">
            <thead>
              <tr>
                <th colSpan={2} className="border-2 border-black bg-black text-white px-1.5 py-1 text-[13px]">
                  반찬 세트<span className="ml-1.5 font-normal text-[10px]">{banchan.length}명</span>
                </th>
              </tr>
              <tr className="bg-stone-200">
                <th className="border border-black px-1 py-0.5 w-[70px]">이 름</th>
                <th className="border border-black px-0.5 py-0.5 w-[26px] text-[10px]">세트</th>
              </tr>
            </thead>
            <tbody>
              {banchan.map((b, i) => (
                <tr key={i}>
                  <td className="border border-black px-1 py-[4px] font-bold whitespace-nowrap">{b.name}</td>
                  <td className="border border-black text-center py-[4px] font-black">{b.qty}</td>
                </tr>
              ))}
              <tr className="bg-stone-100">
                <td className="border-2 border-black px-1 py-1 text-right font-black text-[10px]">합계</td>
                <td className="border-2 border-black text-center py-1 font-black">{banchanTotal}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      {/* 알레르기 — 재료를 빼드리는 게 아니라(불가) 교차오염 주의용 */}
      {allergyRows.length > 0 && (
        <div className="mt-2 border-2 border-black px-2 py-1 text-[11px]">
          <span className="font-black">알레르기 주의</span>
          <span className="text-[10px] text-stone-600 ml-1">(재료 제거 불가 — 조리도구·교차오염 주의)</span>
          <span className="ml-2">
            {allergyRows.map((o, i) => (
              <span key={i} className="mr-3">
                <span className="font-black text-red-600">{o.baby_name}</span> {(o.allergies || []).join('·')}
              </span>
            ))}
          </span>
        </div>
      )}

      {memoRows.length > 0 && (
        <div className="mt-1.5 border border-black px-2 py-1 text-[11px]">
          <span className="font-black">메모</span>
          <span className="ml-1.5">
            {memoRows.map((o, i) => <span key={i} className="mr-3">{o.baby_name}: {o.memo}</span>)}
          </span>
        </div>
      )}

      {orders.length === 0 && (
        <div className="py-16 text-center text-stone-400 border-2 border-dashed border-stone-300">
          이 날짜에 조리할 주문이 없습니다
        </div>
      )}
    </div>
  );
}
