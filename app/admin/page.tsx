import { redirect } from 'next/navigation';
import { isAdminAuthed } from '@/lib/auth';
import { supabaseService } from '@/lib/supabase';
import { kstToday, thisWeekMonday } from '@/lib/dates';
import AdminShell from './AdminShell';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  if (!isAdminAuthed()) redirect('/admin/login');

  const today = kstToday();
  const weekStart = thisWeekMonday();
  const sb = supabaseService();

  const [ordersRes, customersRes, menusRes] = await Promise.all([
    sb.from('baby_food_orders').select('*')
      .eq('delivery_date', today)
      .neq('status', '취소')
      .order('created_at', { ascending: false }),
    sb.from('baby_food_customers').select('*').order('baby_name'),
    sb.from('baby_food_weekly_menus').select('*').eq('week_start', weekStart)
  ]);

  return (
    <AdminShell
      initialOrders={ordersRes.data || []}
      customers={customersRes.data || []}
      weeklyMenus={menusRes.data || []}
      today={today}
      weekStart={weekStart}
    />
  );
}
