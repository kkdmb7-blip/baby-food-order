import { redirect } from 'next/navigation';
import { isAdminAuthed } from '@/lib/auth';
import { supabaseService } from '@/lib/supabase';
import { kstToday, thisWeekMonday } from '@/lib/dates';
import { orderDates, shiftDate } from '@/lib/orderItems';
import AdminShell from './AdminShell';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  if (!isAdminAuthed()) redirect('/admin/login');

  const today = kstToday();
  const weekStart = thisWeekMonday();
  const sb = supabaseService();

  const [ordersRes, customersRes, menusRes] = await Promise.all([
    // ⚠️ 복합주문은 여러 날짜분이 한 행에 들어있고 delivery_date엔 첫 날짜만 저장됨 —
    // delivery_date로만 조회하면 "월+목" 주문이 목요일 대시보드에서 통째로 사라졌음
    // (인쇄용 조리표·주소록에서 고쳤던 것과 같은 문제가 화면에도 있었음).
    sb.from('baby_food_orders').select('*')
      .gte('delivery_date', shiftDate(today, -21))
      .lte('delivery_date', shiftDate(today, 21))
      .neq('status', '취소')
      .order('created_at', { ascending: false })
      .limit(500),
    sb.from('baby_food_customers').select('*').order('baby_name'),
    sb.from('baby_food_weekly_menus').select('*').eq('week_start', weekStart)
  ]);

  const todaysOrders = (ordersRes.data || []).filter(o => orderDates(o as any).includes(today));

  return (
    <AdminShell
      initialOrders={todaysOrders}
      customers={customersRes.data || []}
      weeklyMenus={menusRes.data || []}
      today={today}
      weekStart={weekStart}
    />
  );
}
