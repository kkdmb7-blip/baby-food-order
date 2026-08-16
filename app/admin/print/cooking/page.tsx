import { redirect } from 'next/navigation';
import { isAdminAuthed } from '@/lib/auth';
import { supabaseService, MENU_TYPES, type Order, type MenuType } from '@/lib/supabase';
import { kstToday } from '@/lib/dates';
import { orderDates, slicesOn, qtyOn, shiftDate } from '@/lib/orderItems';
import PrintAuto from '../PrintAuto';
import PrintBar from '../PrintBar';

export const dynamic = 'force-dynamic';

const DOW_KOR = ['일', '월', '화', '수', '목', '금', '토'];

export default async function CookingPrint({ searchParams }: { searchParams: { date?: string } }) {
  if (!isAdminAuthed()) redirect('/admin/login');
  const date = searchParams.date || kstToday();

  const sb = supabaseService();
  // ⚠️ 복합주문은 여러 날짜분이 한 행에 들어있고 delivery_date 칸엔 그중 첫 날짜만 저장됨 —
  // delivery_date로만 조회하면 "월+목" 주문의 목요일분이 목요일 조리표에서 통째로 사라졌음.
  // 앞뒤 3주를 넉넉히 가져와서 items 안의 실제 조리일로 다시 걸러낸다.
  const { data } = await sb.from('baby_food_orders').select('*')
    .gte('delivery_date', shiftDate(date, -21))
    .lte('delivery_date', shiftDate(date, 21))
    .neq('status', '취소').order('created_at').limit(500);
  const orders: Order[] = (data || []).filter(o => orderDates(o as any).includes(date));

  // 그 날짜분 세트만 뽑아서 단계·용량별로 묶음 — 복합주문(stage='mixed')도 세트 단위로는
  // 실제 단계/용량을 갖고 있어서 이렇게 하면 정상적으로 조리표에 잡힌다.
  type Row = { order: Order; menus: Record<string, number>; qty: number };
  const totals: Record<MenuType, number> = { 한우: 0, 닭: 0, 기타단백질: 0 };
  const groupMap = new Map<string, { stage: string; volume: number; rows: Row[] }>();
  const banchanRows: Row[] = [];
  for (const o of orders) {
    for (const s of slicesOn(o as any, date)) {
      if (s.stage === '반찬세트') { banchanRows.push({ order: o, menus: s.menus, qty: s.qty }); continue; }
      for (const m of MENU_TYPES) totals[m] += s.menus[m] || 0;
      const key = `${s.stage ?? '-'}|${s.volume ?? 0}`;
      if (!groupMap.has(key)) groupMap.set(key, { stage: String(s.stage ?? '-'), volume: Number(s.volume ?? 0), rows: [] });
      groupMap.get(key)!.rows.push({ order: o, menus: s.menus, qty: s.qty });
    }
  }
  const STAGE_ORDER = ['중기1단계', '중기2단계', '후기', '완료기'];
  const groups = [...groupMap.values()].sort((a, b) => {
    const ai = STAGE_ORDER.indexOf(a.stage), bi = STAGE_ORDER.indexOf(b.stage);
    if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    return a.volume - b.volume;
  });
  const totalPacks = orders.reduce((sum, o) => sum + qtyOn(o as any, date), 0);
  const banchanTotal = banchanRows.reduce((s, r) => s + r.qty, 0);
  // 조리는 "단계+용량"이 다르면 완전히 다른 작업이라(중기1단계 240g 한우와 310g 한우는 따로 만듦),
  // 메뉴별 총합만 적어두면 실제로 몇 개씩 만들지 알 수 없음 — 단계·용량별 × 메뉴별로 쪼개서 보여준다.
  const matrix = groups.map(g => {
    const menus: Record<string, number> = {};
    let sum = 0, unspec = 0;
    for (const r of g.rows) {
      for (const m of MENU_TYPES) menus[m] = (menus[m] || 0) + (r.menus[m] || 0);
      sum += r.qty;
      unspec += Math.max(0, r.qty - MENU_TYPES.reduce((s, m) => s + (r.menus[m] || 0), 0));
    }
    return { stage: g.stage, volume: g.volume, menus, sum, unspec, people: g.rows.length };
  });
  // 주문 팩수보다 메뉴 지정 수가 적은 경우가 실제로 있음(간단주문 등) — 메뉴 합계만 보고
  // 조리하면 그만큼 덜 만들게 되므로 "미지정"으로 따로 드러낸다.
  const menuSpecified = Object.values(totals).reduce((a, b) => a + b, 0);
  const unspecified = Math.max(0, (totalPacks - banchanTotal) - menuSpecified);
  const rowUnspecified = (r: Row) => Math.max(0, r.qty - MENU_TYPES.reduce((s, m) => s + (r.menus[m] || 0), 0));
  // 알레르기 있는 주문은 조리 중 반드시 눈에 띄어야 해서 상단에 따로 모아 보여줌
  const allergyOrders = orders.filter(o => (o.allergies || []).length > 0);
  const dow = DOW_KOR[new Date(date + 'T00:00:00Z').getUTCDay()];

  return (
    <div className="bg-white min-h-screen p-8 max-w-2xl mx-auto text-black print:p-4">
      <PrintAuto />
      <div className="flex justify-between items-start mb-5 border-b-[3px] border-black pb-3 gap-4">
        <div>
          <div className="text-[10px] tracking-[0.2em] text-stone-500 mb-0.5">COOKING SHEET</div>
          <h1 className="text-2xl font-black">이유식 조리표</h1>
          <div className="text-base font-bold mt-1">{date} ({dow})</div>
          <div className="text-sm text-stone-600">
            총 {orders.length}명 · 이유식 {totalPacks - banchanTotal}팩
            {banchanTotal > 0 && ` · 반찬 ${banchanTotal}세트`}
          </div>
        </div>
        <PrintBar date={date} kind="cooking" />
      </div>

      {/* ① 먼저 얼마나 만들지 — 조리 시작 전에 보는 숫자라 맨 위로 */}
      <div className="mb-5">
        <div className="font-black text-sm mb-2">■ 오늘 만들 총량 (단계·용량별)</div>
        <table className="w-full border-2 border-black text-sm">
          <thead>
            <tr className="bg-stone-200">
              <th className="border border-black py-1.5 px-2 text-left">단계 · 용량</th>
              {MENU_TYPES.map(m => (
                <th key={m} className="border border-black py-1.5 px-1 w-16">{m.replace('기타단백질', '기타')}</th>
              ))}
              <th className="border border-black py-1.5 px-1 w-16">합계</th>
            </tr>
          </thead>
          <tbody>
            {matrix.map(r => (
              <tr key={`${r.stage}-${r.volume}`}>
                <td className="border border-black py-2 px-2 font-black">
                  {r.stage}{r.volume ? ` ${r.volume}g` : ''}
                  <span className="ml-1 text-[11px] font-normal text-stone-600">({r.people}명)</span>
                </td>
                {MENU_TYPES.map(m => (
                  <td key={m} className="border border-black py-2 px-1 text-center text-xl font-black">
                    {r.menus[m] ? r.menus[m] : <span className="text-stone-300 text-base">·</span>}
                  </td>
                ))}
                <td className="border border-black py-2 px-1 text-center text-xl font-black bg-stone-100">
                  {r.sum}
                  {r.unspec > 0 && <div className="text-[10px] font-bold leading-tight">미지정 {r.unspec}</div>}
                </td>
              </tr>
            ))}
            {matrix.length > 0 && (
              <tr className="bg-stone-200">
                <td className="border border-black py-1.5 px-2 font-black text-right">이유식 합계</td>
                {MENU_TYPES.map(m => (
                  <td key={m} className="border border-black py-1.5 px-1 text-center font-black">{totals[m]}</td>
                ))}
                <td className="border border-black py-1.5 px-1 text-center font-black">{totalPacks - banchanTotal}</td>
              </tr>
            )}
          </tbody>
        </table>
        {unspecified > 0 && (
          <div className="mt-2 border-2 border-black rounded p-2 text-sm font-bold">
            ⚠ 메뉴 미지정 {unspecified}팩 — 주문 팩수보다 메뉴 지정이 적어요. 손님께 확인 후 조리해주세요
          </div>
        )}
        {banchanTotal > 0 && (
          <div className="mt-2 border-2 border-black rounded p-2 flex items-center justify-between">
            <span className="font-bold text-sm">반찬 세트 (반찬5 + 국1)</span>
            <span className="text-2xl font-black">{banchanTotal}<span className="text-sm font-normal ml-1">세트</span></span>
          </div>
        )}
      </div>

      {/* ② 알레르기 — 안전 문제라 조리 전에 반드시 확인 */}
      {allergyOrders.length > 0 && (
        <div className="mb-5 border-[3px] border-black rounded p-3">
          <div className="font-black text-sm mb-1.5">⚠ 알레르기 주의 — 아래 아기는 해당 재료를 반드시 빼주세요</div>
          <table className="w-full text-sm">
            <tbody>
              {allergyOrders.map(o => (
                <tr key={o.id} className="border-b border-stone-300 last:border-0">
                  <td className="py-1 font-bold w-28 align-top">{o.baby_name}</td>
                  <td className="py-1 font-bold">{(o.allergies || []).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ③ 단계·용량별 조리 목록 — 실제 조리 단위 */}
      <div className="space-y-4">
        {groups.map(g => (
          <section key={`${g.stage}-${g.volume}`} className="break-inside-avoid">
            <div className="font-black text-sm border-b-2 border-black pb-1 mb-1.5 flex justify-between">
              <span>■ {g.stage}{g.volume ? ` ${g.volume}g` : ''}</span>
              <span>{g.rows.length}명 / {g.rows.reduce((s, r) => s + r.qty, 0)}팩</span>
            </div>
            <table className="w-full text-sm">
              <tbody>
                {g.rows.map((row, ri) => (
                  <tr key={`${row.order.id}-${ri}`} className="border-b border-stone-200">
                    <td className="py-1.5 w-6 align-top text-lg leading-none">☐</td>
                    <td className="py-1.5 font-bold w-24 pr-2 align-top">
                      {row.order.baby_name}
                      {(row.order.allergies || []).length > 0 && <span className="ml-1 text-[10px] font-black">⚠</span>}
                    </td>
                    <td className="py-1.5 align-top">
                      {MENU_TYPES.filter(m => (row.menus[m] || 0) > 0)
                        .map(m => `${m.replace('기타단백질', '기타')} ${row.menus[m]}팩`)
                        .join(' · ')}
                      {rowUnspecified(row) > 0 && (
                        <span className="font-black"> {MENU_TYPES.some(m => (row.menus[m] || 0) > 0) ? '+ ' : ''}메뉴 미지정 {rowUnspecified(row)}팩 ⚠</span>
                      )}
                      {(row.order.allergies || []).length > 0 && (
                        <div className="text-[11px] font-bold mt-0.5">⚠ {(row.order.allergies || []).join(', ')} 제외</div>
                      )}
                      {row.order.memo && <div className="text-[11px] text-stone-600 mt-0.5">메모: {row.order.memo}</div>}
                    </td>
                    <td className="py-1.5 text-right text-stone-600 text-xs w-12 align-top">{row.qty}팩</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}

        {banchanRows.length > 0 && (
          <section className="break-inside-avoid">
            <div className="font-black text-sm border-b-2 border-black pb-1 mb-1.5 flex justify-between">
              <span>■ 반찬 세트</span>
              <span>{banchanRows.length}명 / {banchanTotal}세트</span>
            </div>
            <table className="w-full text-sm">
              <tbody>
                {banchanRows.map((row, ri) => (
                  <tr key={`b-${row.order.id}-${ri}`} className="border-b border-stone-200">
                    <td className="py-1.5 w-6 align-top text-lg leading-none">☐</td>
                    <td className="py-1.5 font-bold w-24 pr-2 align-top">
                      {row.order.baby_name}
                      {(row.order.allergies || []).length > 0 && <span className="ml-1 text-[10px] font-black">⚠</span>}
                    </td>
                    <td className="py-1.5 align-top">
                      반찬 세트 {row.qty}세트
                      {(row.order.allergies || []).length > 0 && (
                        <div className="text-[11px] font-bold mt-0.5">⚠ {(row.order.allergies || []).join(', ')} 제외</div>
                      )}
                      {row.order.memo && <div className="text-[11px] text-stone-600 mt-0.5">메모: {row.order.memo}</div>}
                    </td>
                    <td className="py-1.5 text-right text-stone-600 text-xs w-12 align-top">{row.qty}세트</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {orders.length === 0 && (
          <div className="py-16 text-center text-stone-400 border-2 border-dashed border-stone-300 rounded">
            이 날짜에 조리할 주문이 없습니다
          </div>
        )}
      </div>

      <div className="mt-6 pt-2 border-t border-stone-300 text-[10px] text-stone-400 flex justify-between">
        <span>{date} 조리표 · 총 {orders.length}명</span>
        <span>출력 시각 {new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')} KST</span>
      </div>
    </div>
  );
}
