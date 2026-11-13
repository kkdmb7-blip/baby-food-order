import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';
import { shiftDate } from '@/lib/orderItems';
import { sortBanchanItems } from '@/lib/banchanOrder';

/*
  GET /api/admin/banchan-menu?date=YYYY-MM-DD — 그날 유아식 반찬 다섯 가지와 국

  왜 필요한가
    사장님 엑셀('수반찬 주문내역')을 보니 반찬은 '세트 한 덩어리'가 아니었다.
    칸이 여섯 개(반찬 5 + 국 1)이고 손님마다 개수가 다르다.

        이름    소단치 한숙볶 닭크조 청김무 한잡채 국  합계
        곽원      1     0     1     1     1    2    6
        김우주    2     2     1     0     1    1    7

    대부분은 1·1·1·1·1·1 이지만, '주문변경' 시트에 있는 분들은 종류별로 바꿔 담는다.
    그러니 주문접수 화면도 여섯 칸이어야 한다. 그 칸 이름이 매주 바뀌므로 여기서 가져온다.

  어디에 있나
    kkakung_history.yusik.schedule[] 의 그날 칸. 반찬 날은 type:'yusik' 이고
    items[] 에 반찬 다섯 가지, soup 에 국이 들어 있다. (이유식 날은 menus[] 를 쓴다)
*/

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const date = (req.nextUrl.searchParams.get('date') || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: 'invalid date' }, { status: 400 });

  const sb = supabaseService();
  // 주간 식단은 그 주 월요일 행에 들어 있다
  const monday = shiftDate(date, -((new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7));

  try {
    const { data } = await sb.from('kkakung_history').select('yusik').eq('id', monday).maybeSingle();
    const day = (((data as any)?.yusik?.schedule) || []).find((d: any) => d?.date === date);

    // 손님이 받는 메뉴표 인쇄와 같은 순서·번호로 준다 (lib/banchanOrder)
    const items: { name: string; ingredients: string }[] =
      sortBanchanItems(day?.items || []).map((x: any) => ({
        name: String(x?.name || '').trim(),
        ingredients: String(x?.ingredients || '').trim(),
      })).filter((x: any) => x.name);

    const soup = day?.soup?.name
      ? { name: String(day.soup.name).trim(), ingredients: String(day.soup.ingredients || '').trim() }
      : null;

    return NextResponse.json({ ok: true, date, monday, items, soup, isBanchanDay: items.length > 0 });
  } catch (e: any) {
    console.error('[admin/banchan-menu]', e);
    // 메뉴를 못 읽어도 주문은 넣을 수 있어야 한다 — 칸 이름만 비워서 돌려준다
    return NextResponse.json({ ok: true, date, items: [], soup: null, isBanchanDay: false, warn: e?.message });
  }
}
