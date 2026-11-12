import { redirect } from 'next/navigation';
import { isAdminAuthed } from '@/lib/auth';
import { supabaseService, MENU_TYPES, type Order } from '@/lib/supabase';
import { kstToday } from '@/lib/dates';
import { orderDates, shiftDate } from '@/lib/orderItems';
import { buildCookingSheet, shortIngredients } from '@/lib/cookingSheet';
import CookingTable from '../../CookingTable';
import PrintAuto from '../PrintAuto';
import PrintBar from '../PrintBar';

export const dynamic = 'force-dynamic';

const DOW_KOR = ['일', '월', '화', '수', '목', '금', '토'];

/*
  종이 조리표.

  표 자체는 CookingTable 로 옮겼다 — 관리자 화면의 조리표와 같은 모양을 쓰기 위한 것이다.
  전에는 화면과 종이가 서로 다른 코드로 그려져서, 담는 사람이 보는 숫자가 두 모양이었다.
  여기 남는 것은 종이에만 필요한 것들: 조회, 추가분 거르기, 그날 메뉴, 머리말, 인쇄 설정.
*/

export default async function CookingPrint({ searchParams }: { searchParams: { date?: string; only?: string } }) {
  if (!isAdminAuthed()) redirect('/admin/login');
  const date = searchParams.date || kstToday();
  // only=new — 조리표를 뽑은 뒤에 들어온 줄만. 그 줄들을 지금까지 종이에 손으로 적으셨다.
  const onlyNew = searchParams.only === 'new';

  const sb = supabaseService();
  const { data } = await sb.from('baby_food_orders').select('*')
    .gte('delivery_date', shiftDate(date, -21))
    .lte('delivery_date', shiftDate(date, 21))
    .neq('status', '취소').order('created_at').limit(500);
  let orders: Order[] = (data || []).filter(o => orderDates(o as any).includes(date));

  // 전체 프린트 시각. 추가분만 뽑을 때 기준이 된다.
  let printedAt: string | null = null;
  try {
    const { data: mark } = await sb.from('baby_food_cooking_prints')
      .select('printed_at').eq('delivery_date', date).maybeSingle();
    printedAt = mark?.printed_at ?? null;
  } catch { /* 기준을 못 읽어도 전체 조리표는 나와야 한다 */ }

  // 기준 시각이 없는데 추가분을 요청하면 전부가 '추가' 가 되어버린다 — 그건 거짓말이다.
  // 그래서 기준이 있을 때만 거른다. 없으면 전체를 그대로 보여주고 머리말에 적는다.
  const canFilterNew = onlyNew && !!printedAt;
  if (canFilterNew) orders = orders.filter(o => o.created_at > printedAt!);

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

  const sheet = buildCookingSheet(orders as any, date);
  const dow = DOW_KOR[new Date(date + 'T00:00:00Z').getUTCDay()];

  return (
    <div className="bg-white min-h-screen p-4 text-black print:p-0">
      <PrintAuto />
      {/* 인쇄물을 집게로 집어 조리대 앞에 걸어두므로 위쪽 20mm는 비워둔다 — 안 그러면 집게가 글자를 가림 */}
      <style>{`@media print { @page { size: A4 landscape; margin: 20mm 8mm 8mm 8mm; } }`}</style>

      {/* 머리말은 한 줄로 낮게 — 세로 688px 중 머리말이 크면 20명짜리 블록이 밀려 두 장이 된다 */}
      <div className="flex justify-between items-baseline mb-1 border-b border-black pb-0.5">
        <div className="flex items-baseline gap-2 flex-wrap text-[13px]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-sm.png" alt="까꿍디미방" width={26} height={26} className="w-[26px] h-[26px] object-contain self-center" />
          <span className="text-lg font-black">
            조리 {date} ({dow})
            {canFilterNew && <span className="ml-1.5 text-red-600">추가분</span>}
          </span>
          <span className="font-bold">
            {sheet.people}명 · {sheet.totalPacks}팩
            {sheet.banchanTotal > 0 && ` · 반찬 ${sheet.banchanTotal}세트`}
            {sheet.banchanSingleTotal > 0 && ` · 낱개 ${sheet.banchanSingleTotal}개`}
          </span>
          {/* 메뉴별 합계 — 담는 대에서 마지막으로 맞춰보는 숫자. 아래 줄에 두었더니 그 한 줄
              때문에 두 장이 되어 머리말로 올렸다 (가로는 남고 세로가 모자란 종이다). */}
          {orders.length > 0 && (
            <span className="text-[13px]">
              {MENU_TYPES.map(m => (
                <span key={m} className="ml-2"><span className="text-stone-600">{m === '기타단백질' ? '기타' : m}</span> <strong>{sheet.menuTotals[m]}</strong></span>
              ))}
              {sheet.unspecTotal > 0 && (
                <span className="ml-2 text-red-600">미지정 <strong>{sheet.unspecTotal}</strong></span>
              )}
            </span>
          )}
          {canFilterNew && (
            <span className="text-[13px] font-bold">
              {new Date(printedAt!).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' })} 이후 들어온 것만
            </span>
          )}
          {onlyNew && !printedAt && (
            <span className="text-[13px] font-bold text-red-600">전체 프린트 기록이 없어 전부 나옵니다</span>
          )}
          <span className="text-[13px] text-stone-500">
            한우/닭/기타 · <span className="text-red-600 font-bold">빨강=큰용량</span>
          </span>
          {sheet.unspecTotal > 0 && (
            <span className="text-[13px] font-bold text-red-600">미지정 {sheet.unspecTotal}팩</span>
          )}
        </div>
        <PrintBar date={date} kind="cooking" />
      </div>

      {/* 오늘 메뉴 — 이름 + 이름에 없는 재료만. 늘 들어가는 것(한우·닭·육수·채소상탕·양파)과
          이름에 이미 있는 재료는 뺀다. 종류 꼬리표('한우'·'닭')도 뺐다 — 이름 첫 글자와 겹쳐
          "한우 한우 콜리플라워" 로 보였다. */}
      {dayMenus.length > 0 && (
        <div className="mb-1 flex gap-1.5 flex-wrap text-[12px]">
          {dayMenus.map((m, i) => {
            const extra = shortIngredients(m.ingredients, m.name);
            return (
              <div key={i} className="border border-black px-1.5 py-0.5">
                <span className="font-bold">{m.name}</span>
                {extra && <span className="text-stone-600 ml-1">{extra}</span>}
              </div>
            );
          })}
        </div>
      )}

      <CookingTable sheet={sheet} />

      {orders.length === 0 && (
        <div className="py-16 text-center text-stone-400 border-2 border-dashed border-stone-300">
          {canFilterNew ? '프린트하신 뒤로 새로 들어온 주문이 없습니다' : '이 날짜에 조리할 주문이 없습니다'}
        </div>
      )}
    </div>
  );
}
