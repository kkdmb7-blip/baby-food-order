import { NextRequest, NextResponse } from 'next/server';
import { supabaseService, type Order } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';
import * as XLSX from 'xlsx';
import { formatPhone, fmtDateTime } from '@/lib/dates';

export async function GET(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const p = new URL(req.url).searchParams;
  const from = p.get('from');
  const to = p.get('to');

  const sb = supabaseService();
  let q = sb.from('baby_food_orders').select('*').order('delivery_date').order('created_at');
  if (from) q = q.gte('delivery_date', from);
  if (to) q = q.lte('delivery_date', to);
  const { data, error } = await q.limit(2000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data as Order[]).map(o => {
    const items = Array.isArray(o.items) ? o.items : [];
    const getQty = (menu: string) => items.find((i: any) => i.menu === menu)?.qty || 0;
    return {
      조리일: o.delivery_date,
      상태: o.status,
      아기이름: o.baby_name,
      개월수: o.months,
      단계: o.stage,
      용량: o.volume,
      한우: getQty('한우'),
      닭: getQty('닭'),
      기타단백질: getQty('기타단백질'),
      총팩수: o.total_qty,
      총금액: o.total_price,
      주소: o.address,
      상세주소: o.address_detail || '',
      현관비번: o.door_password || '',
      연락처: formatPhone(o.customer_phone),
      종류: o.order_type,
      메모: o.memo || '',
      주문일시: fmtDateTime(o.created_at),
      주문ID: o.id
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    {wch:12},{wch:8},{wch:10},{wch:6},{wch:10},{wch:6},
    {wch:6},{wch:6},{wch:8},{wch:6},{wch:8},
    {wch:30},{wch:20},{wch:12},{wch:14},{wch:8},{wch:20},{wch:18},{wch:36}
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '주문내역');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="orders_${from||'all'}_${to||'all'}.xlsx"`
    }
  });
}
