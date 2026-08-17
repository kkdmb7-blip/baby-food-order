import { redirect } from 'next/navigation';
import { isAdminAuthed } from '@/lib/auth';
import { supabaseService, STAGES, STAGE_OPTIONS, MENU_TYPES, menuLabel, type Order } from '@/lib/supabase';
import { kstToday } from '@/lib/dates';
import { orderDates, slicesOn, shiftDate, disambiguateNames } from '@/lib/orderItems';
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
  orderId: string;
  name: string;
  volume: number;
  isBig: boolean;
  menus: Record<string, number>;
  allergy: boolean;
  multi: boolean; // 같은 사람이 다른 단계도 주문했는지 (포장 시 합쳐야 함)
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

  // 그날 세 가지 메뉴가 뭔지 조리표에서 바로 보이게 — 예전엔 주간 메뉴표를 따로 봐야 했음
  const TYPE_KOR: Record<string, string> = { hanwoo: '한우', chicken: '닭', p3: '기타', other: '기타' };
  let dayMenus: { type: string; name: string; ingredients: string }[] = [];
  try {
    const monday = shiftDate(date, -((new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7));
    const { data: hist } = await sb.from('kkakung_history').select('yusik').eq('id', monday).maybeSingle();
    const day = ((hist as any)?.yusik?.schedule || []).find((d: any) => d.date === date);
    dayMenus = (day?.menus || []).map((m: any) => ({
      type: TYPE_KOR[m.type] || m.type, name: m.name || '', ingredients: m.ingredients || '',
    }));
  } catch { /* 메뉴를 못 불러와도 조리표 자체는 나와야 함 */ }

  // ⚠️ 조리는 "중기 다 챙기고 → 후기 다 챙기고" 순서로 진행하므로, 사람을 한 줄에 놓고
  // 단계를 가로로 늘어놓으면 빈 칸 사이를 계속 왔다갔다 해야 함.
  // 그래서 단계별로 사람을 따로 모아 블록을 만든다(기존 엑셀도 블록마다 한 단계씩 쓰고 있었음).
  const dispName = disambiguateNames(orders as any);
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
        orderId: o.id,
        name: (dispName.get(o.id) || o.baby_name) + (unspec > 0 ? ` (미지정${unspec})` : ''),
        volume: Number(s.volume) || 0,
        isBig: Number(s.volume) === BIG_VOLUME[stage],
        menus,
        allergy: (o.allergies || []).length > 0,
        multi: false,
      });
    }
  }

  // ⚠️ 한 사람이 중기1+중기2, 중기+완료기처럼 여러 단계를 같이 시키는 경우가 있음.
  // 단계별 블록으로 나눠 놓으면 같은 사람이 여러 블록에 흩어져서, 표시가 없으면
  // 포장할 때 각각 다른 손님으로 보고 따로 담게 됨 — 합쳐야 한다는 표시를 남긴다.
  const stagesByOrder = new Map<string, string[]>();
  for (const [stage, list] of byStage) {
    for (const p of list) {
      const arr = stagesByOrder.get(p.orderId) || [];
      if (!arr.includes(stage)) arr.push(stage);
      stagesByOrder.set(p.orderId, arr);
    }
  }
  const multiOrders = [...stagesByOrder.entries()].filter(([, st]) => st.length > 1);
  const multiIds = new Set(multiOrders.map(([id]) => id));
  for (const list of byStage.values()) {
    for (const p of list) p.multi = multiIds.has(p.orderId);
  }
  const nameOf = (id: string) => dispName.get(id) || orders.find(o => o.id === id)?.baby_name || '';
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
      {/* 인쇄물을 집게로 집어 조리대 앞에 걸어두므로 위쪽 20mm는 비워둔다 — 안 그러면 집게가 글자를 가림 */}
      <style>{`@media print { @page { size: A4 landscape; margin: 20mm 8mm 8mm 8mm; } }`}</style>

      <div className="flex justify-between items-baseline mb-1.5 border-b border-black pb-1">
        <div className="flex items-baseline gap-2 flex-wrap text-[14px]">
          <span className="text-xl font-black">조리 {date} ({dow})</span>
          <span className="font-bold">{orders.length}명 · {totalPacks}팩{banchanTotal > 0 && ` · 반찬 ${banchanTotal}`}</span>
          <span className="text-[13px] text-stone-500">
            한우/닭/기타 · <span className="text-red-600 font-bold">빨강=큰용량</span>
          </span>
        </div>
        <PrintBar date={date} kind="cooking" />
      </div>

      {/* 오늘 메뉴 — 어떤 재료로 만드는지 조리표 안에서 바로 확인 */}
      {dayMenus.length > 0 && (
        <div className="mb-2 flex gap-2 flex-wrap text-[13px]">
          {dayMenus.map((m, i) => (
            <div key={i} className="border border-black px-2 py-1">
              <span className="font-black">{m.type}</span>
              <span className="font-bold ml-1">{m.name}</span>
              {m.ingredients && <span className="text-stone-600 ml-1">{m.ingredients}</span>}
            </div>
          ))}
        </div>
      )}

      {/* 단계별 블록 — 한 블록을 다 챙기고 다음 블록으로 넘어가면 됨 */}
      <div className="flex gap-3 items-start flex-wrap">
        {sections.map(sec => (
          <table key={sec.stage} className="border-collapse text-[17px] leading-tight break-inside-avoid">
            <thead>
              <tr>
                <th colSpan={4} className="border border-black px-2 py-1 text-[17px] text-left">
                  {sec.stage}
                  <span className="ml-1.5 font-normal text-[13px] text-stone-600">
                    {SMALL_VOLUME[sec.stage]}/<span className="text-red-600">{BIG_VOLUME[sec.stage]}</span>g · {sec.list.length}명
                  </span>
                </th>
              </tr>
              <tr className="bg-stone-200">
                <th className="border border-black px-2 py-1 w-[104px] text-[15px]">이 름</th>
                {MENU_TYPES.map(m => (
                  <th key={m} className="border border-black px-1 py-1 w-[42px] text-[14px]">
                    {menuLabel(m)}
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
                    <td className="border border-black px-2 py-[7px] font-bold whitespace-nowrap max-w-[104px] overflow-hidden">
                      {p.multi && <span className="text-blue-700 font-black mr-0.5">+</span>}
                      {p.name}{p.allergy && <span className="text-red-600">*</span>}
                    </td>
                    {MENU_TYPES.map(m => (
                      <td key={m} className="border border-black text-center py-[7px]">
                        {cell(p.menus[m], p.isBig)}
                      </td>
                    ))}
                  </tr>
                );
              })}
              {/* 단계별 합계 — 이만큼 만들면 됨 */}
              <tr className="bg-stone-100">
                <td className="border-2 border-black px-2 py-1.5 text-right font-black text-[13px]">
                  {SMALL_VOLUME[sec.stage]}g
                </td>
                {MENU_TYPES.map(m => (
                  <td key={m} className="border-2 border-black text-center py-1.5 font-black">
                    {sec.tot[m].small || <span className="text-stone-300">·</span>}
                  </td>
                ))}
              </tr>
              <tr className="bg-stone-100">
                <td className="border-2 border-black px-2 py-1.5 text-right font-black text-[13px] text-red-600">
                  {BIG_VOLUME[sec.stage]}g
                </td>
                {MENU_TYPES.map(m => (
                  <td key={m} className="border-2 border-black text-center py-1.5 font-black text-red-600">
                    {sec.tot[m].big || <span className="text-stone-300">·</span>}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        ))}

        {banchan.length > 0 && (
          <table className="border-collapse text-[17px] leading-tight break-inside-avoid">
            <thead>
              <tr>
                <th colSpan={2} className="border border-black px-2 py-1 text-[17px] text-left">
                  반찬 세트<span className="ml-1.5 font-normal text-[13px] text-stone-600">{banchan.length}명</span>
                </th>
              </tr>
              <tr className="bg-stone-200">
                <th className="border border-black px-2 py-1 w-[104px] text-[15px]">이 름</th>
                <th className="border border-black px-1 py-1 w-[42px] text-[14px]">세트</th>
              </tr>
            </thead>
            <tbody>
              {banchan.map((b, i) => (
                <tr key={i}>
                  <td className="border border-black px-2 py-[7px] font-bold whitespace-nowrap">{b.name}</td>
                  <td className="border border-black text-center py-[7px] font-black">{b.qty}</td>
                </tr>
              ))}
              <tr className="bg-stone-100">
                <td className="border-2 border-black px-2 py-1.5 text-right font-black text-[13px]">합계</td>
                <td className="border-2 border-black text-center py-1.5 font-black">{banchanTotal}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      {/* 여러 단계를 같이 시킨 사람 — 블록이 나뉘어 있어서 포장할 때 합쳐야 함 */}
      {multiOrders.length > 0 && (
        <div className="mt-3 border-2 border-blue-700 px-2.5 py-1.5 text-[14px]">
          <span className="font-black text-blue-700">+ 여러 단계 함께 주문 — 포장할 때 한 봉투로 합쳐주세요</span>
          <span className="ml-2">
            {multiOrders.map(([id, st], i) => (
              <span key={i} className="mr-3">
                <span className="font-black">{nameOf(id)}</span> {st.join(' + ')}
              </span>
            ))}
          </span>
        </div>
      )}

      {/* 알레르기 — 재료를 빼드리는 게 아니라(불가) 교차오염 주의용 */}
      {allergyRows.length > 0 && (
        <div className="mt-2 border-2 border-black px-2.5 py-1.5 text-[14px]">
          <span className="font-black">알레르기 주의</span>
          <span className="text-[12px] text-stone-600 ml-1">(재료 제거 불가 — 조리도구·교차오염 주의)</span>
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
        <div className="mt-2 border border-black px-2.5 py-1.5 text-[14px]">
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
