import { redirect } from 'next/navigation';
import { isAdminAuthed } from '@/lib/auth';
import { supabaseService, STAGES, STAGE_OPTIONS, MENU_TYPES, type Order, type MenuType, type StageType } from '@/lib/supabase';
import { kstToday } from '@/lib/dates';
import { orderDates, slicesOn, shiftDate } from '@/lib/orderItems';
import PrintAuto from '../PrintAuto';
import PrintBar from '../PrintBar';

export const dynamic = 'force-dynamic';

const DOW_KOR = ['일', '월', '화', '수', '목', '금', '토'];
const STAGE_SHORT: Record<string, string> = {
  '중기1단계': '중1', '중기2단계': '중2', '후기': '후기', '완료기': '완료',
};
// 단계마다 용량이 2가지 — 큰 쪽(310/300)은 빨간색으로 구분해서 한 칸에 같이 적는다.
// (사장님이 쓰던 엑셀 조리표와 같은 방식: 검정=작은 용량, 빨강=큰 용량)
const BIG_VOLUME: Record<string, number> = Object.fromEntries(
  STAGES.map(s => [s, Math.max(...STAGE_OPTIONS[s].map(o => o.volume))])
);
const SMALL_VOLUME: Record<string, number> = Object.fromEntries(
  STAGES.map(s => [s, Math.min(...STAGE_OPTIONS[s].map(o => o.volume))])
);

type Cell = { small: number; big: number };
type PersonRow = {
  name: string;
  allergies: string[];
  memo: string | null;
  // stage → menu → { 작은용량, 큰용량 }
  cells: Record<string, Record<string, Cell>>;
  banchan: number;
};

function emptyCells(): Record<string, Record<string, Cell>> {
  const out: Record<string, Record<string, Cell>> = {};
  for (const s of STAGES) {
    out[s] = {};
    for (const m of MENU_TYPES) out[s][m] = { small: 0, big: 0 };
  }
  return out;
}

export default async function CookingPrint({ searchParams }: { searchParams: { date?: string } }) {
  if (!isAdminAuthed()) redirect('/admin/login');
  const date = searchParams.date || kstToday();

  const sb = supabaseService();
  // 복합주문은 delivery_date에 첫 날짜만 저장되므로 items 안의 실제 조리일로 다시 거른다.
  const { data } = await sb.from('baby_food_orders').select('*')
    .gte('delivery_date', shiftDate(date, -21))
    .lte('delivery_date', shiftDate(date, 21))
    .neq('status', '취소').order('created_at').limit(500);
  const orders: Order[] = (data || []).filter(o => orderDates(o as any).includes(date));

  // 한 사람 = 한 줄. 여러 세트를 주문했어도 같은 줄에 합쳐서 적는다.
  const rows: PersonRow[] = [];
  for (const o of orders) {
    const slices = slicesOn(o as any, date);
    if (slices.length === 0) continue;
    const row: PersonRow = {
      name: o.baby_name, allergies: o.allergies || [], memo: o.memo,
      cells: emptyCells(), banchan: 0,
    };
    for (const s of slices) {
      if (s.stage === '반찬세트') { row.banchan += s.qty; continue; }
      const stage = String(s.stage || '');
      if (!row.cells[stage]) continue;
      const isBig = Number(s.volume) === BIG_VOLUME[stage];
      for (const m of MENU_TYPES) {
        const q = s.menus[m] || 0;
        if (!q) continue;
        if (isBig) row.cells[stage][m].big += q;
        else row.cells[stage][m].small += q;
      }
    }
    rows.push(row);
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  // 하단 합계 — 단계·메뉴별로 작은용량/큰용량 각각
  const totals = emptyCells();
  for (const r of rows) {
    for (const s of STAGES) for (const m of MENU_TYPES) {
      totals[s][m].small += r.cells[s][m].small;
      totals[s][m].big += r.cells[s][m].big;
    }
  }
  const banchanTotal = rows.reduce((s, r) => s + r.banchan, 0);
  const grand = STAGES.reduce((sum, s) =>
    sum + MENU_TYPES.reduce((a, m) => a + totals[s][m].small + totals[s][m].big, 0), 0);

  // 한 장에 최대한 담기게 좌우 블록으로 나눔 (엑셀처럼 3열)
  const PER_BLOCK = Math.max(12, Math.ceil(rows.length / 3));
  const blocks: PersonRow[][] = [];
  for (let i = 0; i < rows.length; i += PER_BLOCK) blocks.push(rows.slice(i, i + PER_BLOCK));
  if (blocks.length === 0) blocks.push([]);

  const allergyRows = rows.filter(r => r.allergies.length > 0);
  const memoRows = rows.filter(r => r.memo);
  const dow = DOW_KOR[new Date(date + 'T00:00:00Z').getUTCDay()];

  const num = (v: number, red: boolean) =>
    v ? <span className={red ? 'text-red-600 font-black' : 'font-black'}>{v}</span> : <span className="text-stone-200">·</span>;

  const Block = ({ list }: { list: PersonRow[] }) => (
    <table className="border-collapse text-[11px] leading-none">
      <thead>
        <tr>
          <th className="border border-black px-1 py-0.5 w-[52px] bg-stone-200">이 름</th>
          {STAGES.map(s => (
            <th key={s} colSpan={3} className="border border-black px-0.5 py-0.5 bg-stone-200 text-[10px]">
              {STAGE_SHORT[s]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {list.map((r, i) => (
          <tr key={i}>
            <td className="border border-black px-1 py-[3px] font-bold whitespace-nowrap overflow-hidden max-w-[52px]">
              {r.name}{r.allergies.length > 0 && <span className="text-red-600">*</span>}
            </td>
            {STAGES.map(s => MENU_TYPES.map(m => (
              <td key={s + m} className="border border-black text-center w-[15px] py-[3px]">
                {r.cells[s][m].big
                  ? num(r.cells[s][m].big, true)
                  : num(r.cells[s][m].small, false)}
              </td>
            )))}
          </tr>
        ))}
        {/* 블록 높이를 맞춰 표가 들쭉날쭉해 보이지 않게 */}
        {Array.from({ length: Math.max(0, PER_BLOCK - list.length) }).map((_, i) => (
          <tr key={`e${i}`}>
            <td className="border border-black px-1 py-[3px]">&nbsp;</td>
            {STAGES.map(s => MENU_TYPES.map(m => (
              <td key={s + m + i} className="border border-black w-[15px] py-[3px]" />
            )))}
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="bg-white min-h-screen p-4 text-black print:p-0">
      <PrintAuto />
      <style>{`@media print { @page { size: A4 landscape; margin: 6mm; } }`}</style>

      <div className="flex justify-between items-end mb-2 border-b-2 border-black pb-1.5">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-black">조리표</h1>
          <span className="text-base font-bold">{date} ({dow})</span>
          <span className="text-sm">총 {rows.length}명 · {grand}팩{banchanTotal > 0 && ` · 반찬 ${banchanTotal}세트`}</span>
          <span className="text-[11px] text-stone-600">
            검정 = {SMALL_VOLUME['중기2단계']}g대 · <span className="text-red-600 font-bold">빨강 = {BIG_VOLUME['중기2단계']}g대</span>
            {' '}· 칸 순서 한우/닭/기타
          </span>
        </div>
        <PrintBar date={date} kind="cooking" />
      </div>

      {/* 사람 목록 — 좌우 블록으로 나눠 한 장에 담음 */}
      <div className="flex gap-2 items-start">
        {blocks.map((b, i) => <Block key={i} list={b} />)}
      </div>

      {/* 하단 합계 — 이만큼 만들면 됨 */}
      <table className="border-collapse text-[11px] mt-2">
        <tbody>
          <tr>
            <td className="border-2 border-black px-1.5 py-1 font-black bg-stone-200 w-[52px]">합계</td>
            {STAGES.map(s => MENU_TYPES.map(m => (
              <td key={s + m} className="border border-black text-center w-[15px] py-1">
                {totals[s][m].big
                  ? <span className="text-red-600 font-black">{totals[s][m].big}</span>
                  : <span className="text-stone-200">·</span>}
              </td>
            )))}
            <td className="px-2 text-[10px] text-red-600 font-bold">← {BIG_VOLUME['중기2단계']}g대</td>
          </tr>
          <tr>
            <td className="border-2 border-black px-1.5 py-1 font-black bg-stone-200"></td>
            {STAGES.map(s => MENU_TYPES.map(m => (
              <td key={s + m} className="border border-black text-center w-[15px] py-1">
                {totals[s][m].small ? <span className="font-black">{totals[s][m].small}</span> : <span className="text-stone-200">·</span>}
              </td>
            )))}
            <td className="px-2 text-[10px] font-bold">← {SMALL_VOLUME['중기2단계']}g대</td>
          </tr>
          <tr>
            <td className="border-2 border-black px-1.5 py-0.5 text-[9px] bg-stone-100"></td>
            {STAGES.map(s => (
              <td key={s} colSpan={3} className="border border-black text-center text-[9px] py-0.5 bg-stone-100 font-bold">
                {STAGE_SHORT[s]}
              </td>
            ))}
            <td />
          </tr>
        </tbody>
      </table>

      {/* 알레르기 — 재료를 빼드리는 게 아니라(그건 불가) 교차오염 주의용 표시 */}
      {allergyRows.length > 0 && (
        <div className="mt-2 border-2 border-black px-2 py-1 text-[11px]">
          <span className="font-black">알레르기 주의</span>
          <span className="text-[10px] text-stone-600 ml-1">(재료 제거는 불가 — 조리도구·교차오염 주의)</span>
          <span className="ml-2">
            {allergyRows.map((r, i) => (
              <span key={i} className="mr-3">
                <span className="font-black text-red-600">{r.name}</span> {r.allergies.join('·')}
              </span>
            ))}
          </span>
        </div>
      )}

      {(banchanTotal > 0 || memoRows.length > 0) && (
        <div className="mt-1.5 flex gap-3 text-[11px]">
          {banchanTotal > 0 && (
            <div className="border-2 border-black px-2 py-1">
              <span className="font-black">반찬 세트 {banchanTotal}세트</span>
              <span className="ml-1.5">
                {rows.filter(r => r.banchan > 0).map((r, i) => <span key={i} className="mr-2">{r.name} {r.banchan}</span>)}
              </span>
            </div>
          )}
          {memoRows.length > 0 && (
            <div className="border border-black px-2 py-1">
              <span className="font-black">메모</span>
              <span className="ml-1.5">
                {memoRows.map((r, i) => <span key={i} className="mr-2">{r.name}: {r.memo}</span>)}
              </span>
            </div>
          )}
        </div>
      )}

      {rows.length === 0 && (
        <div className="py-16 text-center text-stone-400 border-2 border-dashed border-stone-300">
          이 날짜에 조리할 주문이 없습니다
        </div>
      )}
    </div>
  );
}
