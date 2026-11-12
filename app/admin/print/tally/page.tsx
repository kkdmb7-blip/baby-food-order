import { redirect } from 'next/navigation';
import { isAdminAuthed } from '@/lib/auth';
import {
  supabaseService, STAGES, STAGE_OPTIONS, MENU_TYPES, menuLabel,
  isBanchanStage, isBanchanSingle, type Order,
} from '@/lib/supabase';
import { kstToday } from '@/lib/dates';
import { orderDates, slicesOn, shiftDate } from '@/lib/orderItems';
import PrintAuto from '../PrintAuto';
import PrintBar from '../PrintBar';

export const dynamic = 'force-dynamic';

/*
  담는 쪽(포장대)에서 쓰는 총갯수 종이.

  왜 조리표와 따로 뽑는가
    조리실은 "누가 뭘 먹는지"가 필요하고, 담는 쪽은 "단계·용량별로 몇 개"만 필요하다.
    전에 쓰시던 엑셀도 그래서 '이유식' 시트와 '조리갯수' 시트가 따로 있었고,
    조리갯수 시트를 담는 쪽에서 쓰고 계셨다. 둘 다 필요하다.

  숫자가 조리표와 어긋나면 안 된다
    그래서 조리표와 똑같은 경로로 읽는다 — 같은 조회 조건, 같은 slicesOn,
    취소분 제외까지 동일. 한쪽만 고치면 두 종이가 다른 말을 하게 되므로
    조리표 쪽 집계를 손보면 여기도 같이 봐야 한다.

  메뉴 미지정
    팩수는 있는데 한우/닭/기타가 안 정해진 주문이 있다. 조리표는 이름 옆에 따로 적는데,
    여기서 빼버리면 담는 쪽 합계가 조리표보다 적게 나온다. 칸을 따로 둔다.
*/

const DOW_KOR = ['일', '월', '화', '수', '목', '금', '토'];

export default async function TallyPrint({ searchParams }: { searchParams: { date?: string } }) {
  if (!isAdminAuthed()) redirect('/admin/login');
  const date = searchParams.date || kstToday();

  const sb = supabaseService();
  const { data } = await sb.from('baby_food_orders').select('*')
    .gte('delivery_date', shiftDate(date, -21))
    .lte('delivery_date', shiftDate(date, 21))
    .neq('status', '취소').order('created_at').limit(500);
  const orders: Order[] = (data || []).filter(o => orderDates(o as any).includes(date));

  // 단계(용량)별 × 메뉴별 집계
  type Cell = { menus: Record<string, number>; unspec: number; people: number };
  const key = (s: string, v: number) => `${s}|${v}`;
  const grid = new Map<string, Cell>();
  for (const s of STAGES) {
    for (const o of STAGE_OPTIONS[s]) {
      const c: Cell = { menus: {}, unspec: 0, people: 0 };
      for (const m of MENU_TYPES) c.menus[m] = 0;
      grid.set(key(s, o.volume), c);
    }
  }

  let banchanQty = 0;
  let banchanSingleQty = 0;
  let banchanPeople = 0;
  const peopleSet = new Set<string>();

  for (const o of orders) {
    for (const sl of slicesOn(o as any, date)) {
      // 낱개(개수)와 세트(세트 수)는 단위가 달라 따로 센다
      if (isBanchanSingle(sl.stage)) { banchanSingleQty += sl.qty; banchanPeople++; continue; }
      if (isBanchanStage(sl.stage)) { banchanQty += sl.qty; banchanPeople++; continue; }
      const stage = String(sl.stage || '');
      if (!STAGES.includes(stage as any)) continue;
      const cell = grid.get(key(stage, Number(sl.volume)));
      if (!cell) continue;   // 그 단계에 없는 용량이면 집계에서 빠진다 — 아래 '맞지 않는 줄'로 센다
      let named = 0;
      for (const m of MENU_TYPES) { const n = sl.menus[m] || 0; cell.menus[m] += n; named += n; }
      cell.unspec += Math.max(0, sl.qty - named);
      cell.people++;
      peopleSet.add(o.id);
    }
  }

  // 단계에 없는 용량으로 들어온 줄 — 조용히 빠지면 담는 쪽 수가 모자란다
  let orphan = 0;
  for (const o of orders) {
    for (const sl of slicesOn(o as any, date)) {
      if (isBanchanStage(sl.stage)) continue;
      const stage = String(sl.stage || '');
      if (!STAGES.includes(stage as any) || !grid.get(key(stage, Number(sl.volume)))) orphan += sl.qty;
    }
  }

  const rows = STAGES.flatMap(s =>
    STAGE_OPTIONS[s].map(o => {
      const c = grid.get(key(s, o.volume))!;
      const sum = MENU_TYPES.reduce((a, m) => a + c.menus[m], 0) + c.unspec;
      const isBig = o.volume === Math.max(...STAGE_OPTIONS[s].map(x => x.volume));
      return { stage: s, volume: o.volume, isBig, cell: c, sum };
    })
  );

  const colTotal = (m: string) => rows.reduce((a, r) => a + r.cell.menus[m], 0);
  const unspecTotal = rows.reduce((a, r) => a + r.cell.unspec, 0);
  const grand = rows.reduce((a, r) => a + r.sum, 0);
  const dow = DOW_KOR[new Date(date + 'T00:00:00Z').getUTCDay()];

  const n = (v: number, red = false) =>
    v ? <span className={red ? 'text-red-600' : ''}>{v}</span> : <span className="text-stone-200">·</span>;

  return (
    <div className="bg-white min-h-screen p-4 text-black print:p-0">
      <PrintAuto />
      {/* 담는 대 앞에 집게로 걸어두므로 위쪽을 비운다 (조리표와 같은 여백) */}
      <style>{`@media print { @page { size: A4 portrait; margin: 20mm 10mm 10mm 10mm; } }`}</style>

      <div className="flex justify-between items-baseline mb-3 border-b-2 border-black pb-1.5">
        <div className="flex items-baseline gap-3 flex-wrap">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-sm.png" alt="까꿍디미방" width={38} height={38} className="w-[38px] h-[38px] object-contain self-center" />
          <span className="text-2xl font-black">담는 수량 {date} ({dow})</span>
          <span className="text-[15px] font-bold">
            {peopleSet.size}명 · {grand}팩
            {banchanQty > 0 && ` · 반찬 ${banchanQty}세트`}
            {banchanSingleQty > 0 && ` · 낱개 ${banchanSingleQty}개`}
          </span>
          <span className="text-[13px] text-stone-500"><span className="text-red-600 font-bold">빨강=큰용량</span></span>
        </div>
        <PrintBar date={date} kind="tally" />
      </div>

      <table className="w-full border-collapse text-[20px]">
        <thead>
          <tr className="bg-stone-100">
            <th className="border-2 border-black px-3 py-2 text-left text-[16px] font-black">단계 (용량)</th>
            {MENU_TYPES.map(m => (
              <th key={m} className="border-2 border-black px-2 py-2 text-[16px] font-black w-[15%]">{menuLabel(m)}</th>
            ))}
            {unspecTotal > 0 && (
              <th className="border-2 border-black px-2 py-2 text-[16px] font-black w-[14%]">미지정</th>
            )}
            <th className="border-2 border-black px-2 py-2 text-[16px] font-black w-[14%]">합</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            // 챙기는 순서가 "중기 쭉 → 후기 → 완료기" 라서 단계가 바뀌는 자리를 굵게 끊는다.
            // 한 단계를 끝내고 다음으로 넘어가는 지점이 눈에 바로 들어와야 한다.
            <tr key={`${r.stage}${r.volume}`}
                className={`${r.sum ? '' : 'text-stone-300'} ${i > 0 && rows[i - 1].stage !== r.stage ? 'border-t-[6px] border-t-black' : ''}`}>
              <td className="border-2 border-black px-3 py-2 text-[17px] font-bold">
                {r.stage}
                <span className={`ml-1.5 text-[15px] ${r.isBig ? 'text-red-600 font-black' : 'font-bold'}`}>
                  {r.volume}g
                </span>
                {r.cell.people > 0 && (
                  <span className="ml-2 text-[12px] font-normal text-stone-500">{r.cell.people}집</span>
                )}
              </td>
              {MENU_TYPES.map(m => (
                <td key={m} className="border-2 border-black text-center py-2 font-black">
                  {n(r.cell.menus[m], r.isBig)}
                </td>
              ))}
              {unspecTotal > 0 && (
                <td className="border-2 border-black text-center py-2 font-black">{n(r.cell.unspec)}</td>
              )}
              <td className="border-2 border-black text-center py-2 font-black bg-stone-50">{n(r.sum, r.isBig)}</td>
            </tr>
          ))}
          <tr className="bg-stone-100">
            <td className="border-2 border-black px-3 py-2 text-right text-[17px] font-black">합계</td>
            {MENU_TYPES.map(m => (
              <td key={m} className="border-2 border-black text-center py-2 font-black">{n(colTotal(m))}</td>
            ))}
            {unspecTotal > 0 && (
              <td className="border-2 border-black text-center py-2 font-black">{n(unspecTotal)}</td>
            )}
            <td className="border-2 border-black text-center py-2 font-black text-[22px]">{grand}</td>
          </tr>
        </tbody>
      </table>

      {(banchanQty > 0 || banchanSingleQty > 0) && (
        <table className="w-full border-collapse text-[20px] mt-4">
          <tbody>
            {banchanQty > 0 && (
            <tr>
              <td className="border-2 border-black px-3 py-2 text-[17px] font-black bg-stone-100">
                유아식(반찬) 세트
                <span className="ml-2 text-[12px] font-normal text-stone-500">{banchanPeople}집</span>
              </td>
              <td className="border-2 border-black text-center py-2 font-black w-[14%]">{banchanQty}</td>
            </tr>
            )}
            {/* 낱개는 픽업만 나간다 — 배송차에 실으면 안 되니 따로 적는다 */}
            {banchanSingleQty > 0 && (
            <tr>
              <td className="border-2 border-black px-3 py-2 text-[17px] font-black bg-amber-50">
                유아식(반찬) 낱개
                <span className="ml-2 text-[12px] font-normal text-amber-700">픽업</span>
              </td>
              <td className="border-2 border-black text-center py-2 font-black w-[14%]">{banchanSingleQty}개</td>
            </tr>
            )}
          </tbody>
        </table>
      )}

      {unspecTotal > 0 && (
        <p className="mt-3 text-[13px] font-bold">
          미지정 {unspecTotal}팩 — 팩수만 있고 한우·닭·기타가 안 정해진 주문입니다. 조리표에서 누구 것인지 확인하세요.
        </p>
      )}
      {orphan > 0 && (
        <p className="mt-2 text-[13px] font-bold text-red-600">
          ⚠ 표에 못 넣은 {orphan}팩이 있습니다 — 그 단계에 없는 용량으로 들어온 주문입니다. 조리표를 확인하세요.
        </p>
      )}
      {grand === 0 && banchanQty === 0 && banchanSingleQty === 0 && (
        <p className="mt-6 text-center text-[16px] text-stone-400">{date}에 담을 것이 없습니다.</p>
      )}
    </div>
  );
}
