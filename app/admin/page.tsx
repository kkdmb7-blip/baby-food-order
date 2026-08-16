import { redirect } from 'next/navigation';
import { isAdminAuthed } from '@/lib/auth';
import { supabaseService } from '@/lib/supabase';
import { kstToday, thisWeekMonday } from '@/lib/dates';
import { orderDates, qtyOn, shiftDate } from '@/lib/orderItems';
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
    sb.from('baby_food_orders').select('*')
      .gte('delivery_date', shiftDate(today, -21))
      .lte('delivery_date', shiftDate(today, 28))
      .neq('status', '취소')
      .order('created_at', { ascending: false })
      .limit(500),
    sb.from('baby_food_customers').select('*').order('baby_name'),
    sb.from('baby_food_weekly_menus').select('*').eq('week_start', weekStart)
  ]);

  const all = ordersRes.data || [];

  // 앞으로 조리할 날짜별 요약 (오늘 포함) — 접수된 주문이 언제 조리되는지 한눈에
  const upcomingMap = new Map<string, { count: number; qty: number }>();
  for (const o of all) {
    for (const d of orderDates(o as any)) {
      if (d < today) continue;
      const cur = upcomingMap.get(d) || { count: 0, qty: 0 };
      cur.count++; cur.qty += qtyOn(o as any, d);
      upcomingMap.set(d, cur);
    }
  }
  const upcoming = [...upcomingMap.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // 요청 날짜가 없으면 오늘 → 없으면 가장 가까운 조리 예정일
  const selectedDate = requested || (upcomingMap.has(today) ? today : (upcoming[0]?.date || today));
  const selectedOrders = all.filter(o => orderDates(o as any).includes(selectedDate));

  // 최근 접수분 (조리일과 무관하게 "방금 들어온 주문" 확인용)
  const recentOrders = [...all]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 15);

  return (
    <AdminShell
      initialOrders={selectedOrders}
      customers={customersRes.data || []}
      weeklyMenus={menusRes.data || []}
      today={today}
      selectedDate={selectedDate}
      upcoming={upcoming}
      recentOrders={recentOrders}
      weekStart={weekStart}
    />
  );
}
