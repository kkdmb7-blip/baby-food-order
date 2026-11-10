'use client';
import { useEffect, useRef, useState } from 'react';
import { MENU_TYPES, STAGES, STAGE_OPTIONS, menuLabel, type StageType } from '@/lib/supabase';

/*
  한 사람씩, 이름 한 번 치고 칸만 체크하는 입력판.

  어떻게 쓰나
    ① 이름을 한 번 친다 → 뜨는 집을 엔터로 고른다 (연락처·주소가 따라온다)
    ② 여덟 칸(중기1 240·310, 중기2 230·300, 후기 230·300, 완료기 230·300)에
       해당하는 자리에 한우·닭·기타 팩수를 넣는다
    ③ 엔터나 '확인' → 저장되고 아래로 쌓인다. 입력칸은 비워져 다음 사람 차례.

  왜 여덟 칸을 다 열어두나
    한 사람이 같은 단계를 다른 용량으로 시키기도 하고(중기2 230 + 중기2 300),
    다른 단계를 같은 용량으로 시키기도 한다(후기 230 + 완료기 230).
    칸을 하나만 고르게 만들면 그런 주문을 못 넣는다. 그래서 다 열어둔다.

  왜 이름을 한 번만 치나
    한 사람이 칸 두세 개에 걸려도 그 사람은 한 사람이다. 칸마다 이름을 다시 치게 하면
    같은 이름을 세 번 치게 된다. 이름은 위에 한 번, 아래 칸은 숫자만.

  저장은 칸마다 한 건
    주문은 단계·용량 단위로 들어가므로, 칸 두 개를 채우면 주문 두 건이 된다.
    조리표에서는 같은 사람으로 묶여 '합쳐 담기' 표시가 붙는다.
    한 칸이 실패해도 나머지는 들어가고, 어느 칸이 실패했는지 아래에 적힌다.

  단골 전용이다
    저장에 연락처·주소·개월수가 필요한데 그건 이름을 골라야 채워진다.
    처음 오는 손님은 아래 '조리표에 줄 넣기'로 넣어야 한다.
*/

type Hit = {
  babyName: string; phone: string; address: string; addressDetail: string | null;
  doorPassword: string | null; stage: string | null; volume: number | null;
  lastMenus?: Record<string, number>;
  postalCode: string | null; deliveryMethod: string | null; receiveMethod: string | null;
  lastDate: string; lastMonths: number; guessMonths: number; orders: number; orderType: string | null;
};

type Slot = { stage: StageType; volume: number; key: string; label: string; isBig: boolean };

const SLOTS: Slot[] = STAGES.flatMap(s => {
  const vols = STAGE_OPTIONS[s].map(o => o.volume);
  const big = Math.max(...vols);
  return vols.map(v => ({
    stage: s, volume: v, key: `${s}|${v}`,
    label: `${s.replace('단계', '')} ${v}g`, isBig: v === big,
  }));
});

type Qty = Record<string, Record<string, string>>;   // slotKey → menu → 팩수

/** 넣고 난 줄 — 아래로 쌓인다 */
type Done = {
  key: number;
  name: string;
  lines: { slot: Slot; menus: Record<string, number>; total: number; ok: boolean; error?: string }[];
};

let SEQ = 1;

export default function GridEntry({ date, onSaved }: { date: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [deliveryDate, setDeliveryDate] = useState(date);

  // 지금 치고 있는 한 사람
  const [q, setQ] = useState('');
  const [hit, setHit] = useState<Hit | null>(null);
  const [qty, setQty] = useState<Qty>({});
  const [hits, setHits] = useState<Hit[]>([]);
  const [finding, setFinding] = useState(false);
  const [listOpen, setListOpen] = useState(false);

  // 처음 오는 손님 — 지난 주문이 없으니 연락처·주소·개월수를 여기서 받는다.
  // 전에는 이 화면이 단골 전용이라 신규는 아래 긴 폼으로 가야 했다. 아침에 화면을
  // 옮겨다니는 게 결국 느린 쪽이라, 그 자리에서 받고 주문과 함께 고객으로 저장한다.
  const [isNew, setIsNew] = useState(false);
  const [nc, setNc] = useState({ phone: '', address: '', months: '', door: '' });
  const ncPhone = nc.phone.replace(/\D/g, '');
  const ncValid = /^\d{10,11}$/.test(ncPhone) && nc.address.trim().length > 3 && Number(nc.months) > 0;

  const [done, setDone] = useState<Done[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setDeliveryDate(date); }, [date]);

  // 이름 찾기
  useEffect(() => {
    const term = q.trim();
    if (!listOpen || hit || term.length < 1) { setHits([]); return; }
    let alive = true;
    const t = setTimeout(async () => {
      setFinding(true);
      try {
        const d = await fetch(`/api/admin/order-lookup?q=${encodeURIComponent(term)}`).then(r => r.json());
        if (alive && d.ok) setHits(d.hits || []);
      } catch { /* 못 찾아도 직접 치시면 된다 */ }
      if (alive) setFinding(false);
    }, 220);
    return () => { alive = false; clearTimeout(t); };
  }, [q, hit, listOpen]);

  function pick(h: Hit) {
    setHit(h); setQ(h.babyName); setHits([]); setListOpen(false); setIsNew(false);
    // 지난번 시키던 칸에 지난번 팩수를 미리 넣어둔다 — 대개 그대로 이어가신다
    const slot = SLOTS.find(s => s.stage === h.stage && s.volume === Number(h.volume));
    if (slot && h.lastMenus) {
      const row: Record<string, string> = {};
      for (const m of MENU_TYPES) {
        const n = Number(h.lastMenus[m] || 0);
        if (n > 0) row[m] = String(n);
      }
      if (Object.keys(row).length) setQty({ [slot.key]: row });
    }
  }

  function reset() {
    setQ(''); setHit(null); setQty({}); setHits([]); setListOpen(false); setErr(null);
    setIsNew(false); setNc({ phone: '', address: '', months: '', door: '' });
    setTimeout(() => nameRef.current?.focus(), 0);
  }

  const slotTotal = (k: string) => MENU_TYPES.reduce((a, m) => a + (Number(qty[k]?.[m]) || 0), 0);
  const usedSlots = SLOTS.filter(s => slotTotal(s.key) > 0);
  const currentTotal = usedSlots.reduce((a, s) => a + slotTotal(s.key), 0);
  const whoOk = hit ? true : (isNew && ncValid);
  const canConfirm = whoOk && currentTotal > 0 && !busy;

  async function confirm() {
    if (!canConfirm) {
      if (!whoOk) {
        setErr(isNew
          ? '연락처(10~11자리)·주소·개월수를 넣어주세요'
          : '이름을 쳐서 뜨는 집을 고르거나, 처음 오는 손님이면 "새 손님"을 눌러주세요');
      } else if (currentTotal === 0) setErr('팩수를 넣어주세요');
      return;
    }
    setBusy(true); setErr(null);

    // 단골이면 지난 주문에서, 처음이면 지금 치신 값에서
    const name = hit ? hit.babyName : q.trim();
    const addr = hit
      ? hit.address + (hit.addressDetail ? ' ' + hit.addressDetail : '')
      : nc.address.trim();
    const phone = (hit ? hit.phone : ncPhone).replace(/\D/g, '');
    const months = hit ? (hit.guessMonths || hit.lastMonths) : Number(nc.months);
    const door = (hit ? hit.doorPassword : nc.door.trim()) || null;
    const postal = hit ? hit.postalCode : null;
    const orderType = hit?.orderType === '선결제' ? '선결제' : '일반';
    // 우편번호가 없으면 서버가 이 값으로 권역을 판정한다 (팩당 500원이 걸린다)
    const zone =
      hit && (hit.deliveryMethod === '직배송' || hit.deliveryMethod === '당일배송' || hit.deliveryMethod === '택배익일배송')
        ? hit.deliveryMethod
        : (/강서구|양천구/.test(addr) ? '직배송' : '당일배송');
    const receive = hit?.receiveMethod === '픽업' ? '픽업' : '배송';

    const lines: Done['lines'] = [];
    for (const slot of usedSlots) {
      const menus: Record<string, number> = {};
      for (const m of MENU_TYPES) {
        const n = Number(qty[slot.key]?.[m]) || 0;
        if (n > 0) menus[m] = n;
      }
      const total = slotTotal(slot.key);
      try {
        const res = await fetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            admin_manual: true,
            baby_name: name,
            months,
            customer_phone: phone,
            address: addr,
            door_password: door,
            stage: slot.stage,
            volume: slot.volume,
            delivery_date: deliveryDate,
            order_type: orderType,
            receive_method: receive,
            delivery_method: receive === '픽업' ? '직배송' : zone,
            postal_code: postal || null,
            total_qty: total,
            items: [{
              delivery_date: deliveryDate,
              sets: [{
                stage: slot.stage, volume: slot.volume, simple: false, qty: total,
                menus: Object.entries(menus).map(([menu, n]) => ({ menu, qty: n })),
              }],
              date_qty: total,
            }],
          }),
        });
        const j = await res.json().catch(() => ({}));
        const ok = res.ok && j.ok !== false;
        lines.push({ slot, menus, total, ok, error: ok ? undefined : (j.error || `실패 (${res.status})`) });
      } catch (e: any) {
        lines.push({ slot, menus, total, ok: false, error: e?.message || '네트워크 오류' });
      }
    }

    setDone(d => [{ key: SEQ++, name, lines }, ...d]);
    setBusy(false);
    if (lines.some(l => l.ok)) onSaved();
    if (lines.every(l => l.ok)) reset();
    else setErr('일부 칸이 안 들어갔어요 — 아래에서 확인해주세요');
  }

  // 넣은 것들의 조리갯수 (엑셀 '조리갯수' 시트 자리)
  const tally = SLOTS.map(s => {
    const counts: Record<string, number> = {};
    for (const m of MENU_TYPES) counts[m] = 0;
    for (const d of done) for (const l of d.lines) {
      if (l.ok && l.slot.key === s.key) for (const m of MENU_TYPES) counts[m] += l.menus[m] || 0;
    }
    return { slot: s, counts, sum: MENU_TYPES.reduce((a, m) => a + counts[m], 0) };
  });
  const grand = tally.reduce((a, t) => a + t.sum, 0);

  const inp = 'rounded border border-stone-300 px-1.5 py-1 text-sm focus:border-amber-500 focus:outline-none';
  const onEnterConfirm = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); confirm(); }
  };

  return (
    <div className="bg-white rounded-xl border border-amber-200 overflow-hidden no-print mb-4">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-4 py-3 text-left">
        <span className="font-bold text-stone-900 text-sm">
          이름 한 번 치고 칸 체크하기
          {grand > 0 && <span className="ml-2 font-normal text-amber-700">{grand}팩 넣음</span>}
        </span>
        <span className="text-stone-400 text-xs">{open ? '접기' : '열기'}</span>
      </button>

      {open && (
        <div className="px-3 pb-4 border-t border-stone-100 pt-3">
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <label className="flex items-center gap-2">
              <span className="text-xs font-medium text-stone-500">조리일</span>
              <input type="date" value={deliveryDate} onChange={e => setDeliveryDate(e.target.value)}
                className="rounded border border-stone-300 px-2 py-1 text-sm" />
            </label>
            <p className="text-[11px] text-stone-500 leading-snug">
              이름 → <b>엔터</b>로 집 고르기 → 칸에 팩수 → <b>엔터</b>면 저장. 칸 여러 개 같이 됩니다.
              처음 오는 손님은 아래 <b>조리표에 줄 넣기</b>로.
            </p>
          </div>

          {/* 치는 곳(왼쪽)과 확인하는 곳(오른쪽)을 나란히 — 스크롤해야 합계가 보이면
              엔터를 칠 때마다 눈이 아래로 내려갔다 와야 한다 */}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_330px] items-start">
          <div>

          {/* ① 이름 */}
          <div className="relative mb-2">
            <div className="flex gap-2 items-center">
              <input
                ref={nameRef}
                value={q}
                onChange={e => { setQ(e.target.value); setHit(null); setListOpen(true); }}
                onFocus={() => { if (!hit) setListOpen(true); }}
                onKeyDown={e => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  if (!hit && !isNew && hits.length) pick(hits[0]);
                  else confirm();
                }}
                placeholder="아기 이름"
                className={`${inp} flex-1 text-base font-bold ${hit ? 'border-emerald-400 bg-emerald-50/50' : ''}`}
              />
              {(hit || isNew) && (
                <button onClick={reset} className="px-3 py-1.5 rounded border border-stone-300 text-xs text-stone-600">
                  지우기
                </button>
              )}
            </div>
            {hit && (
              <p className="mt-1 text-[11px] text-stone-500 truncate">
                {hit.address} · 지난 주문 {hit.lastDate}
                {hit.stage ? ` · ${hit.stage.replace('단계', '')} ${hit.volume ?? ''}g` : ''}
                {hit.orderType === '선결제' && <span className="ml-1 text-sky-700 font-bold">선결제</span>}
              </p>
            )}
            {listOpen && !hit && q.trim() && (
              <div className="absolute z-30 left-0 right-0 mt-0.5 bg-white border border-stone-200 rounded-lg shadow-lg max-h-56 overflow-auto">
                {finding && <p className="px-2 py-1.5 text-xs text-stone-400">찾는 중…</p>}
                {!finding && hits.length === 0 && (
                  <button onMouseDown={e => { e.preventDefault(); setIsNew(true); setListOpen(false); }}
                    className="block w-full text-left px-2 py-2 hover:bg-amber-50">
                    <span className="text-sm font-bold text-amber-700">+ 처음 오는 손님으로 넣기</span>
                    <span className="block text-[11px] text-stone-400">지난 주문에 없는 이름이에요 — 연락처·주소를 여기서 받습니다</span>
                  </button>
                )}
                {!finding && hits.length > 0 && (
                  <button onMouseDown={e => { e.preventDefault(); setIsNew(true); setListOpen(false); }}
                    className="block w-full text-left px-2 py-1.5 border-t border-stone-200 hover:bg-amber-50">
                    <span className="text-[12px] font-bold text-amber-700">+ 처음 오는 손님</span>
                    <span className="ml-1 text-[11px] text-stone-400">위에 없으면</span>
                  </button>
                )}
                {hits.map(h => (
                  <button key={h.phone} onMouseDown={e => { e.preventDefault(); pick(h); }}
                    className="block w-full text-left px-2 py-1.5 hover:bg-amber-50 border-b border-stone-50 last:border-0">
                    <span className="text-sm font-bold text-stone-900">{h.babyName}</span>
                    {h.orderType === '선결제' && <span className="ml-1 text-[10px] text-sky-700">선결제</span>}
                    <span className="block text-[11px] text-stone-400 truncate">
                      {h.lastDate} · {h.stage?.replace('단계', '') || '-'}{h.volume ? ` ${h.volume}g` : ''} · {h.address}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 처음 오는 손님 — 지난 주문이 없으니 여기서 받는다. 주문과 함께 고객으로도 저장된다 */}
          {isNew && !hit && (
            <div className="mb-2 rounded-lg border border-amber-300 bg-amber-50/60 p-2">
              <p className="text-[11px] font-bold text-amber-800 mb-1.5">
                처음 오는 손님 — 넣으면 <b>고객관리에도 같이 저장</b>됩니다
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                <input inputMode="numeric" value={nc.phone}
                  onChange={e => setNc(v => ({ ...v, phone: e.target.value.replace(/[^\d-]/g, '').slice(0, 13) }))}
                  onKeyDown={onEnterConfirm} placeholder="연락처"
                  className={`${inp} ${ncPhone && !/^\d{10,11}$/.test(ncPhone) ? 'border-rose-400' : ''}`} />
                <input inputMode="numeric" value={nc.months}
                  onChange={e => setNc(v => ({ ...v, months: e.target.value.replace(/\D/g, '').slice(0, 2) }))}
                  onKeyDown={onEnterConfirm} placeholder="개월수" className={inp} />
                <input value={nc.door}
                  onChange={e => setNc(v => ({ ...v, door: e.target.value.slice(0, 20) }))}
                  onKeyDown={onEnterConfirm} placeholder="현관비번 (선택)" className={inp} />
                <input value={nc.address}
                  onChange={e => setNc(v => ({ ...v, address: e.target.value }))}
                  onKeyDown={onEnterConfirm} placeholder="주소"
                  className={`${inp} col-span-3`} />
              </div>
              <p className="mt-1 text-[11px] text-stone-500 leading-snug">
                주소에 <b>강서구·양천구</b>가 있으면 직배송(기본가), 아니면 당일배송(팩당 +500원)으로 잡힙니다.
                우편번호가 없으면 이 판정이 값을 정하니 구 이름을 꼭 넣어주세요.
              </p>
            </div>
          )}

          {/* ② 여덟 칸 */}
          <div className="rounded-lg border border-stone-300 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-stone-50 text-[11px] text-stone-500">
                  <th className="text-left font-medium px-2 py-1">칸</th>
                  {MENU_TYPES.map(m => <th key={m} className="font-medium py-1 w-14">{menuLabel(m)}</th>)}
                  <th className="font-medium py-1 w-10">합</th>
                </tr>
              </thead>
              <tbody>
                {SLOTS.map((s, i) => {
                  const t = slotTotal(s.key);
                  const newStage = i > 0 && SLOTS[i - 1].stage !== s.stage;
                  return (
                    <tr key={s.key}
                        className={`${newStage ? 'border-t-4 border-t-stone-300' : 'border-t border-stone-100'} ${t ? 'bg-amber-50/50' : ''}`}>
                      <td className="px-2 py-0.5 font-bold text-stone-700 whitespace-nowrap">
                        {s.stage.replace('단계', '')}
                        <span className={`ml-1 text-[12px] ${s.isBig ? 'text-red-600' : 'text-stone-500'}`}>{s.volume}g</span>
                      </td>
                      {MENU_TYPES.map(m => (
                        <td key={m} className="py-0.5 px-0.5">
                          <input inputMode="numeric" disabled={busy}
                            value={qty[s.key]?.[m] || ''}
                            onChange={e => setQty(v => ({
                              ...v, [s.key]: { ...(v[s.key] || {}), [m]: e.target.value.replace(/\D/g, '').slice(0, 2) },
                            }))}
                            onKeyDown={onEnterConfirm}
                            className={`${inp} w-full text-center`} />
                        </td>
                      ))}
                      <td className="text-center font-bold text-stone-700">{t || ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {err && <p className="mt-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{err}</p>}

          <button onClick={confirm} disabled={!canConfirm}
            className="mt-2 w-full rounded-lg bg-amber-500 py-2.5 text-sm font-semibold text-white disabled:bg-stone-200 disabled:text-stone-400">
            {busy ? '넣는 중…'
              : canConfirm ? `확인 — ${hit ? hit.babyName : q.trim()} ${currentTotal}팩 (칸 ${usedSlots.length}개)  ⏎`
              : isNew ? '연락처·주소·개월수와 팩수를 넣어주세요'
              : '이름 고르고 팩수를 넣어주세요'}
          </button>

          </div>

          {/* 오른쪽 — 치면서 바로 보는 곳. 붙여 두어서 스크롤 없이 확인된다 */}
          <div className="lg:sticky lg:top-3 space-y-2">
            {/* 조리갯수 — 비어 있어도 자리를 지킨다. 칸이 움직이면 눈이 다시 찾아야 한다 */}
            <div className="rounded-lg border border-stone-300 overflow-hidden">
              <div className="px-2.5 py-1 bg-stone-100 border-b border-stone-200 flex items-baseline justify-between">
                <span className="text-[13px] font-black text-stone-800">조리갯수</span>
                <span className="text-[11px] text-stone-500">넣은 것 {done.length}명</span>
              </div>
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-[10px] text-stone-400 bg-stone-50">
                    <th className="text-left font-medium px-2 py-0.5">칸</th>
                    {MENU_TYPES.map(m => <th key={m} className="font-medium py-0.5 w-9">{menuLabel(m)}</th>)}
                    <th className="font-medium py-0.5 w-9">합</th>
                  </tr>
                </thead>
                <tbody>
                  {tally.map((t, i) => {
                    const newStage = i > 0 && tally[i - 1].slot.stage !== t.slot.stage;
                    return (
                      <tr key={t.slot.key}
                          className={`${newStage ? 'border-t-2 border-t-stone-300' : 'border-t border-stone-100'} ${t.sum ? '' : 'text-stone-300'}`}>
                        <td className="px-2 py-0.5 whitespace-nowrap">
                          {t.slot.stage.replace('단계', '')}
                          <span className={`ml-1 ${t.slot.isBig && t.sum ? 'text-red-600' : ''}`}>{t.slot.volume}</span>
                        </td>
                        {MENU_TYPES.map(m => (
                          <td key={m} className="py-0.5 text-center">{t.counts[m] || '·'}</td>
                        ))}
                        <td className="py-0.5 text-center font-bold">{t.sum || '·'}</td>
                      </tr>
                    );
                  })}
                  <tr className="border-t-2 border-stone-400 bg-stone-50 font-black">
                    <td className="px-2 py-1">합계</td>
                    {MENU_TYPES.map(m => (
                      <td key={m} className="py-1 text-center">{tally.reduce((a, t) => a + t.counts[m], 0) || '·'}</td>
                    ))}
                    <td className="py-1 text-center text-amber-700">{grand || '·'}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* 방금 넣은 것들 — 최근 것이 위로 */}
            {done.length > 0 && (
              <div className="rounded-lg border border-stone-200 overflow-hidden">
                <div className="px-2.5 py-1 bg-stone-50 border-b border-stone-200 flex items-baseline justify-between">
                  <span className="text-[12px] font-bold text-stone-700">방금 넣은 것</span>
                  <button onClick={() => setDone([])} className="text-[10px] text-stone-400 underline">비우기</button>
                </div>
                <div className="divide-y divide-stone-100 max-h-44 overflow-auto">
                  {done.map(d => (
                    <div key={d.key} className="px-2.5 py-1 text-[12px] leading-snug">
                      <span className="font-bold text-stone-900">{d.name}</span>
                      {d.lines.map((l, i) => (
                        <span key={i} className={`ml-1.5 ${l.ok ? 'text-stone-500' : 'text-rose-700 font-bold'}`}>
                          {l.slot.label} {MENU_TYPES.filter(m => l.menus[m]).map(m => `${menuLabel(m)}${l.menus[m]}`).join('·')}
                          {!l.ok && ` — ${l.error}`}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          </div>
        </div>
      )}
    </div>
  );
}
