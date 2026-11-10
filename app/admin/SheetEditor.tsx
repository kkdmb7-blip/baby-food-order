'use client';
import { useState } from 'react';
import { MENU_TYPES, menuLabel, type Order, type Customer } from '@/lib/supabase';
import { SLOTS, slotKey } from '@/lib/slots';
import { slicesOn, orderDates } from '@/lib/orderItems';

/*
  조리표에서 한 사람 것을 고친다.

  왜 사람 단위인가
    한 사람이 중기와 후기를 같이 시키기도 한다. 줄 하나만 고치게 하면 그런 손님은
    두 번 열어 고쳐야 하고, "원래 없던 단계를 추가" 하는 건 아예 못 한다.
    그래서 주문접수와 똑같은 여덟 칸을 띄우고, 그 사람의 그날 주문 전체를 맞춘다.

  저장할 때 칸마다 하는 일
    원래 있고 숫자가 바뀌었으면   → 그 주문을 고친다(/api/admin/order-edit)
    원래 있고 0이 되었으면        → 그 주문을 취소한다(상태 '취소')
    원래 없고 숫자가 들어왔으면   → 새 주문으로 넣는다(/api/orders, admin_manual)

    선결제 손님은 이 셋 모두에서 잔여 팩이 맞춰진다 —
    고치면 차이만큼, 취소하면 돌려받고, 새로 넣으면 그만큼 빠진다.
    (잔여 계산은 서버가 한다. 화면이 계산해서 보내면 틀어진다.)

  못 고치는 것은 못 고친다고 적는다
    여러 날짜가 묶인 주문, 한 칸에 주문이 두 줄 들어간 경우, 반찬세트.
    조용히 한쪽만 고치면 장부가 어긋난다.
*/

type Qty = Record<string, Record<string, string>>;

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const dowOf = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? DOW[new Date(d + 'T00:00:00Z').getUTCDay()] : '');

export default function SheetEditor({ date, orders, customers, onClose, onChanged }: {
  date: string;
  /** 그 사람(같은 연락처)의 그날 주문 전부 */
  orders: Order[];
  customers: Customer[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const base = orders[0];
  const phone = base?.customer_phone || '';
  const cust = customers.find(c => c.phone === phone) || null;
  const prepaid = base?.order_type === '선결제';

  // 칸마다 그 사람의 주문 줄을 모은다. 한 칸에 두 줄이면 고치지 않는다(어느 쪽인지 알 수 없다).
  const bySlot = new Map<string, { order: Order; qty: number; menus: Record<string, number> }[]>();
  const others: { order: Order; label: string; qty: number }[] = [];   // 반찬세트처럼 여덟 칸에 없는 것
  let multiDate = false;
  for (const o of orders) {
    if (orderDates(o as any).length > 1) { multiDate = true; continue; }
    for (const s of slicesOn(o as any, date)) {
      const key = slotKey(s.stage, s.volume);
      if (!SLOTS.some(x => x.key === key)) {
        others.push({ order: o, label: `${s.stage ?? '-'}${s.volume ? ` ${s.volume}g` : ''}`, qty: s.qty });
        continue;
      }
      const arr = bySlot.get(key) || [];
      arr.push({ order: o, qty: s.qty, menus: s.menus });
      bySlot.set(key, arr);
    }
  }

  const [qty, setQty] = useState<Qty>(() => {
    const init: Qty = {};
    for (const [key, arr] of bySlot) {
      if (arr.length !== 1) continue;
      const row: Record<string, string> = {};
      for (const m of MENU_TYPES) {
        const n = arr[0].menus[m] || 0;
        if (n) row[m] = String(n);
      }
      // 메뉴를 안 적고 팩수만 들어간 줄도 있다 — 그건 숫자를 못 보여주니 합계로만 알린다
      init[key] = row;
    }
    return init;
  });

  // 손댄 칸만 저장한다.
  // ⚠️ 이게 없으면: 메뉴를 안 적고 팩수만 들어간 줄(카톡에 "300g 3팩" 만 적혀 온 경우)은
  //    화면에 숫자가 비어 있어서, 아무것도 안 고치고 저장만 눌러도 '0팩 → 취소' 가 된다.
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const touch = (k: string) => setTouched(prev => (prev.has(k) ? prev : new Set(prev).add(k)));

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const slotTotal = (k: string) => MENU_TYPES.reduce((a, m) => a + (Number(qty[k]?.[m]) || 0), 0);
  const wasTotal = (k: string) => (bySlot.get(k)?.reduce((a, r) => a + r.qty, 0) || 0);
  const wasAll = SLOTS.reduce((a, s) => a + wasTotal(s.key), 0);
  // 저장하면 몇 팩이 되는지 — 손대지 않은 칸은 지금 값 그대로다(화면이 비어 있어도 0이 아니다)
  const nowAll = SLOTS.reduce((a, s) => a + (touched.has(s.key) ? slotTotal(s.key) : wasTotal(s.key)), 0);
  const diff = nowAll - wasAll;

  const inp = 'w-full text-center rounded border border-stone-300 px-1 py-0.5 text-sm focus:border-amber-500 focus:outline-none';

  async function save() {
    setBusy(true); setErr(null); setMsg(null);
    const done: string[] = [];
    const failed: string[] = [];

    for (const slot of SLOTS) {
      const rows = bySlot.get(slot.key) || [];
      if (rows.length > 1) continue;                       // 두 줄짜리는 손대지 않는다
      if (!touched.has(slot.key)) continue;                // 손대지 않은 칸은 그대로 둔다
      const now = slotTotal(slot.key);
      const was = rows[0]?.qty ?? 0;
      const sameMenus = rows[0]
        ? MENU_TYPES.every(m => (Number(qty[slot.key]?.[m]) || 0) === (rows[0].menus[m] || 0))
        : now === 0;
      if (sameMenus && now === was) continue;              // 숫자가 그대로인 칸

      const menus: Record<string, number> = {};
      for (const m of MENU_TYPES) {
        const n = Number(qty[slot.key]?.[m]) || 0;
        if (n > 0) menus[m] = n;
      }

      try {
        if (rows[0] && now === 0) {
          // 0팩 — 그 줄을 취소한다(선결제면 서버가 잔여를 돌려준다)
          const r = await fetch(`/api/orders/${rows[0].order.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: '취소' }),
          });
          if (!r.ok) throw new Error(`취소 실패 (${r.status})`);
          done.push(`${slot.label} 취소`);
        } else if (rows[0]) {
          const r = await fetch('/api/admin/order-edit', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: rows[0].order.id, date, menus }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || j.ok === false) throw new Error(j.error || `고치기 실패 (${r.status})`);
          done.push(`${slot.label} ${was}→${now}팩`);
        } else {
          // 원래 없던 칸 — 새 주문으로 넣는다. 사람 정보는 그날 주문에서 그대로 가져온다.
          const r = await fetch('/api/orders', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              admin_manual: true,
              baby_name: base.baby_name,
              months: base.months,
              customer_phone: phone,
              address: base.address,
              address_detail: base.address_detail || null,
              door_password: base.door_password || null,
              stage: slot.stage,
              volume: slot.volume,
              delivery_date: date,
              order_type: base.order_type === '선결제' ? '선결제' : '일반',
              receive_method: (base as any).receive_method === '픽업' ? '픽업' : '배송',
              delivery_method: base.delivery_method || '당일배송',
              postal_code: base.postal_code || null,
              total_qty: now,
              items: [{
                delivery_date: date,
                sets: [{
                  stage: slot.stage, volume: slot.volume, simple: false, qty: now,
                  menus: Object.entries(menus).map(([menu, q]) => ({ menu, qty: q })),
                }],
                date_qty: now,
              }],
            }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || j.ok === false) throw new Error(j.error || `넣기 실패 (${r.status})`);
          done.push(`${slot.label} ${now}팩 새로 넣음`);
        }
      } catch (e: any) {
        failed.push(`${slot.label} — ${e?.message || '실패'}`);
      }
    }

    setBusy(false);
    if (!done.length && !failed.length) { setMsg('바뀐 게 없어요'); return; }
    if (failed.length) setErr(failed.join(' / '));
    if (done.length) {
      setMsg(done.join(' · '));
      onChanged();
      if (!failed.length) onClose();
    }
  }

  if (!base) return null;

  return (
    <div className="rounded-lg border-2 border-amber-400 bg-amber-50/40 p-3 my-2">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-sm font-black text-stone-900">
          {base.baby_name} 고치기
          <span className="ml-2 text-[11px] font-normal text-stone-500">
            {date}({dowOf(date)}) · 지금 {wasAll}팩
          </span>
        </div>
        <button onClick={onClose} className="text-[11px] text-stone-500 underline">닫기</button>
      </div>

      {multiDate && (
        <p className="mb-2 text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1">
          이 손님은 여러 날짜가 묶인 주문이 있어요 — 그 줄은 여기서 못 고칩니다.
          주문 탭에서 취소하고 다시 넣어주세요.
        </p>
      )}

      <table className="w-full text-sm bg-white rounded border border-stone-200">
        <thead>
          <tr className="bg-stone-50 text-[10px] text-stone-500">
            <th className="text-left font-medium pl-2 py-1 w-[84px]">칸</th>
            {MENU_TYPES.map(m => <th key={m} className="font-medium py-1 w-12">{menuLabel(m)}</th>)}
            <th className="font-medium py-1 w-9">합</th>
            <th className="font-medium py-1 w-16">지금</th>
          </tr>
        </thead>
        <tbody>
          {SLOTS.map((s, i) => {
            const rows = bySlot.get(s.key) || [];
            const dup = rows.length > 1;
            const was = wasTotal(s.key);
            const now = slotTotal(s.key);
            const newStage = i > 0 && SLOTS[i - 1].stage !== s.stage;
            return (
              <tr key={s.key}
                  className={`${newStage ? 'border-t-4 border-t-stone-300' : 'border-t border-stone-100'} ${now ? 'bg-amber-50/50' : ''}`}>
                <td className="pl-2 py-0.5 font-bold text-stone-700 whitespace-nowrap text-[12px]">
                  {s.stage.replace('단계', '')}
                  <span className={`ml-1 ${s.isBig ? 'text-red-600' : 'text-stone-500'}`}>{s.volume}</span>
                </td>
                {MENU_TYPES.map(m => (
                  <td key={m} className="py-0.5 px-0.5">
                    <input inputMode="numeric" disabled={busy || dup}
                      value={qty[s.key]?.[m] || ''}
                      onChange={e => {
                        touch(s.key);
                        setQty(v => ({
                          ...v, [s.key]: { ...(v[s.key] || {}), [m]: e.target.value.replace(/\D/g, '').slice(0, 2) },
                        }));
                      }}
                      className={`${inp} ${dup ? 'bg-stone-100' : ''}`} />
                  </td>
                ))}
                <td className="text-center font-bold text-stone-700">{now || ''}</td>
                <td className="text-center text-[11px] text-stone-400">
                  {dup ? <span className="text-rose-600 font-bold">두 줄</span> : (was || '·')}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {[...bySlot.values()].some(a => a.length > 1) && (
        <p className="mt-1.5 text-[11px] text-rose-700">
          '두 줄' 칸은 같은 칸에 주문이 두 건 들어가 있어요 — 주문 탭에서 한 건을 취소한 뒤 고쳐주세요.
        </p>
      )}
      {others.length > 0 && (
        <p className="mt-1.5 text-[11px] text-stone-500">
          여기서 못 고치는 줄: {others.map(o => `${o.label} ${o.qty}팩`).join(', ')}
        </p>
      )}

      {/* 선결제는 돈이 걸린다 — 저장하면 몇 팩이 어떻게 되는지 미리 적어 둔다 */}
      {prepaid && (
        <p className="mt-2 text-[12px] font-bold text-sky-900 bg-sky-50 border border-sky-200 rounded px-2 py-1">
          선결제 · 잔여 {cust ? `${cust.prepaid_balance}팩` : '(목록에 없음)'}
          {diff !== 0 && (
            <span className="ml-1">
              → 저장하면 {diff > 0 ? `${diff}팩 더 빠집니다` : `${-diff}팩 돌아옵니다`}
              {cust && ` (잔여 ${Math.max(0, cust.prepaid_balance - diff)}팩)`}
            </span>
          )}
          {diff === 0 && <span className="ml-1 font-normal">팩수 합계가 그대로라 잔여는 안 바뀝니다</span>}
        </p>
      )}

      {err && <p className="mt-2 text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1">{err}</p>}
      {msg && <p className="mt-2 text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">{msg}</p>}

      <div className="mt-2 flex items-center gap-2">
        <button onClick={save} disabled={busy}
          className="px-4 py-1.5 rounded-lg bg-amber-500 text-white text-sm font-bold disabled:bg-stone-200 disabled:text-stone-400">
          {busy ? '고치는 중…' : `저장 — ${nowAll}팩${diff !== 0 ? ` (${diff > 0 ? '+' : ''}${diff})` : ''}`}
        </button>
        <span className="text-[11px] text-stone-500">
          <b>손댄 칸만</b> 저장돼요. 0으로 비우면 그 칸은 취소되고,
          빈 칸에 숫자를 넣으면 주문이 하나 더 들어갑니다.
        </span>
      </div>
    </div>
  );
}
