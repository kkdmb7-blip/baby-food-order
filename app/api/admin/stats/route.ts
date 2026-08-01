import { NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';
import { kstToday } from '@/lib/dates';

// KST 기준 YYYY-MM-DD / YYYY-MM 추출 (created_at은 UTC timestamptz로 저장돼 있음)
function kstDate(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
// GET /api/admin/stats — 매출·신규고객·재구매율 요약 (마케팅 성과 확인용)
export async function GET() {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const sb = supabaseService();

  const { data: orders, error } = await sb
    .from('baby_food_orders')
    .select('created_at, total_price, customer_phone, acquisition_source')
    .neq('status', '취소')
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const today = kstToday();
  const thisMonth = today.slice(0, 7);

  let todayRevenue = 0, todayOrders = 0, monthRevenue = 0, monthOrders = 0;
  const monthly: Record<string, { revenue: number; orders: number }> = {};
  const firstOrderMonthByPhone: Record<string, string> = {};
  const orderCountByPhone: Record<string, number> = {};
  const bySource: Record<string, { revenue: number; orders: number }> = {};

  for (const o of orders || []) {
    const day = kstDate(o.created_at);
    const month = day.slice(0, 7);
    if (day === today) { todayRevenue += o.total_price; todayOrders++; }
    if (month === thisMonth) { monthRevenue += o.total_price; monthOrders++; }
    if (!monthly[month]) monthly[month] = { revenue: 0, orders: 0 };
    monthly[month].revenue += o.total_price;
    monthly[month].orders++;
    orderCountByPhone[o.customer_phone] = (orderCountByPhone[o.customer_phone] || 0) + 1;
    if (!firstOrderMonthByPhone[o.customer_phone] || month < firstOrderMonthByPhone[o.customer_phone]) {
      firstOrderMonthByPhone[o.customer_phone] = month;
    }
    if (o.acquisition_source) {
      if (!bySource[o.acquisition_source]) bySource[o.acquisition_source] = { revenue: 0, orders: 0 };
      bySource[o.acquisition_source].revenue += o.total_price;
      bySource[o.acquisition_source].orders++;
    }
  }

  const newCustomersThisMonth = Object.values(firstOrderMonthByPhone).filter(m => m === thisMonth).length;
  const totalCustomers = Object.keys(orderCountByPhone).length;
  const repeatCustomers = Object.values(orderCountByPhone).filter(c => c >= 2).length;
  const repeatRate = totalCustomers > 0 ? Math.round((repeatCustomers / totalCustomers) * 1000) / 10 : 0;

  // 최근 12개월(이번 달 포함) 월별 매출 — 데이터 없는 달도 0으로 채움
  const monthlyList: { month: string; revenue: number; orders: number }[] = [];
  const base = new Date(thisMonth + '-01T00:00:00Z');
  for (let i = 11; i >= 0; i--) {
    const d = new Date(base.getTime());
    d.setUTCMonth(d.getUTCMonth() - i);
    const m = d.toISOString().slice(0, 7);
    monthlyList.push({ month: m, revenue: monthly[m]?.revenue || 0, orders: monthly[m]?.orders || 0 });
  }

  const sourceList = Object.entries(bySource)
    .map(([source, v]) => ({ source, ...v }))
    .sort((a, b) => b.orders - a.orders);

  return NextResponse.json({
    ok: true,
    today: { revenue: todayRevenue, orders: todayOrders },
    thisMonth: { revenue: monthRevenue, orders: monthOrders, newCustomers: newCustomersThisMonth },
    totalCustomers, repeatRate,
    monthly: monthlyList,
    bySource: sourceList,
  });
}
