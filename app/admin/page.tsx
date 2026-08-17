import { redirect } from 'next/navigation';
import { isAdminAuthed } from '@/lib/auth';
import { supabaseService } from '@/lib/supabase';
import { kstToday, thisWeekMonday } from '@/lib/dates';
import { orderDates, shiftDate } from '@/lib/orderItems';
import AdminShell from './AdminShell';

export const dynamic = 'force-dynamic';

export default async function AdminPage({ searchParams }: { searchParams: { date?: string } }) {
  if (!isAdminAuthed()) redirect('/admin/login');

  const today = kstToday();
  // 주문은 항상 "내일 이후" 조리분이라, 조리일이 오늘인 주문은 대개 없음 —
  // 접수 당일엔 대시보드가 전부 0으로 보여서 새 주문을 확인할 방법이 없었다.
  // 그래서 날짜를 직접 고를 수 있게 하고(?date=), 기본값도 "조리할 주문이 있는 가장 가까운 날"로 잡는다.
  const requested = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.date || '') ? searchParams.date! : null;
  const weekStart = thisWeekMonday();
  const sb = supabaseService();

  const [ordersRes, customersRes, menusRes] = await Promise.all([
    // ⚠️ 복합주문은 여러 날짜분이 한 행에 들어있고 delivery_date엔 첫 날짜만 저장됨 —
    // delivery_date로만 조회하면 "월+목" 주문이 목요일 대시보드에서 통째로 사라졌음.
    // 취소된 주문도 가져온다 — 예전엔 조회에서 빼버려서 "취소된 게 있었는지"조차 알 수 없었음
    // (화면에서 필터로 걸러 보여줌)
    sb.from('baby_food_orders').select('*')
      .gte('delivery_date', shiftDate(today, -21))
      .lte('delivery_date', shiftDate(today, 28))
      .order('created_at', { ascending: false })
      .limit(500),
    sb.from('baby_food_customers').select('*').order('baby_name'),
    sb.from('baby_food_weekly_menus').select('*').eq('week_start', weekStart)
  ]);

  const all = ordersRes.data || [];

  // 기본은 항상 오늘. 다른 날은 사장님이 날짜를 직접 골라서 본다.
  const selectedDate = requested || today;
  const onDate = all.filter(o => orderDates(o as any).includes(selectedDate));
  // ⚠️ 조리표·주소록·배송 탭은 취소분이 섞이면 취소된 주문을 조리·배송하게 되므로 반드시 제외.
  // 취소분은 "취소된 게 있었는지" 확인용으로만 따로 넘긴다.
  const selectedOrders = onDate.filter(o => o.status !== '취소');
  const cancelledOrders = onDate.filter(o => o.status === '취소');

  return (
    <AdminShell
      initialOrders={selectedOrders}
      cancelledOrders={cancelledOrders}
      customers={customersRes.data || []}
      weeklyMenus={menusRes.data || []}
      today={today}
      selectedDate={selectedDate}
      weekStart={weekStart}
    />
  );
}
