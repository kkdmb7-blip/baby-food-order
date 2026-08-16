import { NextRequest, NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase';
import { isAdminAuthed } from '@/lib/auth';
import { addrKey } from '@/lib/routeCode';

// 배송 순번 저장/수정 (admin 전용)
// 엑셀에서 가져온 기본 매핑(lib/routeCodes.json)은 읽기 전용이라, 새 손님 순번을 정하거나
// 기존 순번을 바꾸려면 여기에 저장한다. 조회 시 이 표가 항상 우선.
export async function GET() {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const sb = supabaseService();
  const { data, error } = await sb.from('baby_food_route_codes').select('*').order('code');
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, rows: data || [] });
}

export async function POST(req: NextRequest) {
  if (!isAdminAuthed()) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const b = await req.json().catch(() => ({}));

  // 주소를 그대로 받아 서버에서 키로 정규화 — 화면마다 키 만드는 규칙이 어긋나지 않게
  const key = String(b.addr_key || '').trim() || addrKey(String(b.address || ''));
  if (!key) return NextResponse.json({ ok: false, error: '주소를 알아볼 수 없어요' }, { status: 400 });

  const sb = supabaseService();

  // 빈 값으로 저장하면 지정 해제 (기본 매핑으로 되돌아감)
  if (b.code === null || b.code === '' || b.code === undefined) {
    const { error } = await sb.from('baby_food_route_codes').delete().eq('addr_key', key);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, addr_key: key, code: null });
  }

  const code = Number(b.code);
  if (!Number.isFinite(code) || code < 0 || code > 999) {
    return NextResponse.json({ ok: false, error: '순번은 0~999 사이 숫자로 입력해주세요' }, { status: 400 });
  }

  const { error } = await sb.from('baby_food_route_codes').upsert({
    addr_key: key, code, memo: String(b.memo || '').slice(0, 100) || null, updated_at: new Date().toISOString(),
  }, { onConflict: 'addr_key' });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, addr_key: key, code });
}
