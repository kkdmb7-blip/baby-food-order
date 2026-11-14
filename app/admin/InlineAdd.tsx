'use client';
import { useEffect, useRef, useState } from 'react';
import { MENU_TYPES, STAGES, menuLabel } from '@/lib/supabase';
import { BIG_VOLUME, SMALL_VOLUME } from '@/lib/cookingSheet';
import { parseKakaoInfo } from '@/lib/kakaoInfo';

/*
  조리표·입금 표 단계 블록 맨 아래 한 줄 — 프린트 뒤 종이에 손으로 적은 아이를 그 자리에서 넣는다.
  2026-11-14 사장님: "펼쳐서 복잡하게 말고, 중기·후기·완료기 각 단계 아래에 이름 치고 230인지 300인지만
  간단하게 추가할 수 있게 바로 그 자리에 칸을. 입금 탭에도 똑같이, 어디서 넣든 연동되게"

  이름을 치면 지난 주문에서 그 집(연락처·주소·개월수)을 찾는다(/api/admin/order-lookup).
  골라지면 지난번 메뉴 수를 미리 채워 둔다 — 대개 같은 양을 시키신다. 용량은 칸 눌러 230↔300.
  Enter 로 넣는다. 들어간 줄은 그 단계 맨 아래('추가')에 붙고 조리표·입금 탭 둘 다 같은 주문이라 같이 보인다.
  처음 오는 손님(지난 주문 없음)은 연락처·주소가 없어 여기서 못 넣는다 — 주문 탭에서.
*/
type Hit = {
  babyName: string; phone: string; address: string; addressDetail: string | null; doorPassword: string | null;
  stage: string | null; volume: number | null; lastMenus: Record<string, number>;
  postalCode: string | null; deliveryMethod: string | null; receiveMethod: string | null;
  lastDate: string; lastMonths: number; guessMonths: number;
};

export function AddRow({ stage, date, onAdded, cols, extra = 0 }: {
  stage: string;              // '중기1단계' … 또는 '반찬'
  date: string;
  onAdded: (row: any) => void;
  cols: number;               // 표 칸 수 (메모 줄 colSpan)
  extra?: number;             // 오른쪽 빈 칸 수 (입금 탭 '받을' 칸)
}) {
  const banchan = stage === '반찬';
  const [name, setName] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [hit, setHit] = useState<Hit | null>(null);
  const [big, setBig] = useState(false);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const q = name.trim();
    if (hit && hit.babyName === q) return;
    setHit(null);
    if (q.length < 1) { setHits([]); return; }
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const d = await fetch(`/api/admin/order-lookup?q=${encodeURIComponent(q)}`).then(r => r.json());
        if (alive && d.ok) setHits((d.hits || []).slice(0, 6));
      } catch { /* 못 찾으면 목록 없이 */ }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  function pick(h: Hit) {
    setHit(h); setName(h.babyName); setHits([]); setMsg(null);
    if (!banchan) {
      if (h.stage === stage && h.volume) setBig(Number(h.volume) === BIG_VOLUME[stage]);
      // 지난번과 같은 단계였으면 그때 메뉴 수를 미리 (비어 있을 때만)
      if (h.stage === stage && Object.values(qty).every(v => !v)) {
        setQty(Object.fromEntries(MENU_TYPES.map(m => [m, h.lastMenus?.[m] ? String(h.lastMenus[m]) : ''])));
      }
    }
  }

  const keys = banchan ? ['세트'] : MENU_TYPES as readonly string[];
  const total = keys.reduce((a, k) => a + (Number(qty[k]) || 0), 0);

  async function save() {
    if (busy) return;
    const typed = name.trim();
    if (!typed) { setMsg({ ok: false, t: '이름을 넣어 주세요' }); return; }
    if (total < 1) { setMsg({ ok: false, t: '팩 수를 넣어 주세요' }); return; }
    let h = hit;
    if (!h) {
      // 목록이 늦게 와서(빨리 치고 Enter) 있는 손님을 새 아이로 넣지 않게 — 넣기 직전에 한 번 더 찾는다
      let list = hits;
      try {
        const d = await fetch(`/api/admin/order-lookup?q=${encodeURIComponent(typed)}`).then(r => r.json());
        if (d.ok) list = d.hits || [];
      } catch { /* 못 찾으면 지금 목록으로 */ }
      const exact = list.filter(x => x.babyName.replace(/\s/g, '') === typed.replace(/\s/g, ''));
      if (exact.length === 1) h = exact[0];
      else if (exact.length > 1) { setHits(list.slice(0, 6)); setMsg({ ok: false, t: '같은 이름이 여럿이에요 — 목록에서 골라 주세요' }); return; }
      // 같은 이름이 없으면 새 아이 — 이름·팩수만 먼저 넣고 연락처·주소는 나중에 (사장님 2026-11-14)
    }
    const months = h ? (h.guessMonths || h.lastMonths) : 0;
    const volume = banchan ? null : (big ? BIG_VOLUME[stage] : SMALL_VOLUME[stage]);
    const sets = banchan
      ? [{ stage: '반찬세트', volume: null, simple: true, menus: [], qty: total }]
      : [{ stage, volume, simple: false, qty: total,
           menus: MENU_TYPES.filter(m => Number(qty[m]) > 0).map(m => ({ menu: m, qty: Number(qty[m]) })) }];
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(h ? {
          admin_manual: true, baby_name: h.babyName, months, customer_phone: h.phone,
          address: h.address, address_detail: h.addressDetail, door_password: h.doorPassword,
          stage: banchan ? null : stage, volume, delivery_date: date, order_type: '일반',
          receive_method: h.receiveMethod === '픽업' ? '픽업' : '배송',
          delivery_method: h.receiveMethod === '픽업' ? '직배송' : (h.deliveryMethod || (/강서구|양천구/.test(h.address) ? '직배송' : '당일배송')),
          postal_code: h.postalCode, total_qty: total,
          // 개월수를 모르는 손님(옛 기록에 없음)도 일단 넣는다 — 정보 넣을 때 고친다
          ...(months ? {} : { later_info: true }),
          items: [{ delivery_date: date, sets, date_qty: total }],
        } : {
          admin_manual: true, later_info: true, baby_name: typed, months: 0, customer_phone: '', address: '',
          stage: banchan ? null : stage, volume, delivery_date: date, order_type: '일반',
          receive_method: '배송', delivery_method: '직배송', total_qty: total,
          items: [{ delivery_date: date, sets, date_qty: total }],
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) { setMsg({ ok: false, t: j.error || `못 넣었어요 (${res.status})` }); return; }
      if (j.row) onAdded(j.row);
      const paidTxt = j.row?.paid ? ' · 은행 입금과 맞아서 입금확인까지 했어요' : '';
      setMsg({ ok: true, t: h ? `${h.babyName} ${total}${banchan ? '세트' : '팩'} 넣었어요${paidTxt}`
        : `${typed} ${total}${banchan ? '세트' : '팩'} 넣었어요 — 새 아이라 연락처·주소는 나중에 (이름 눌러 넣기)` });
      setName(''); setHit(null); setHits([]); setQty({}); setBig(false);
      setTimeout(() => nameRef.current?.focus(), 0);
    } catch (e: any) {
      setMsg({ ok: false, t: e?.message || '네트워크 오류' });
    } finally { setBusy(false); }
  }

  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
  /* ←/→ 로 옆 칸 — 사장님 2026-11-14 "아래 추가할 때 옆으로 방향키로도 이동". 이름 칸은 글자 맨 앞·맨 끝에서만 넘어간다 */
  const rowRef = useRef<HTMLTableRowElement>(null);
  const onNav = (e: React.KeyboardEvent) => {
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || (e.nativeEvent as any).isComposing) return;
    const t = e.target as HTMLElement;
    if (t === nameRef.current) {
      const i = nameRef.current!;
      if (e.key === 'ArrowLeft' && !(i.selectionStart === 0 && i.selectionEnd === 0)) return;
      if (e.key === 'ArrowRight' && i.selectionStart !== i.value.length) return;
    }
    const els = Array.from(rowRef.current?.querySelectorAll<HTMLElement>('input, button') || [])
      .filter(x => !x.closest('[data-hits]') && !(x as HTMLInputElement).disabled);
    const at = els.indexOf(t);
    const next = els[at + (e.key === 'ArrowRight' ? 1 : -1)];
    if (at < 0 || !next) return;
    e.preventDefault();
    next.focus();
    if (next instanceof HTMLInputElement) setTimeout(() => next.select(), 0);
  };
  const numCls = 'w-full text-center bg-white outline-none font-black py-[2px] text-[13px] focus:bg-amber-100 disabled:opacity-40';
  return (
    <>
      <tr ref={rowRef} onKeyDown={onNav} className="no-print bg-amber-50">
        <td className="border border-dashed border-amber-400 p-0 relative">
          <input ref={nameRef} value={name} onChange={e => setName(e.target.value)} onKeyDown={onKey} disabled={busy}
            placeholder="＋ 이름" className="w-full px-0.5 py-[2px] text-[13px] font-bold text-center bg-transparent outline-none placeholder:text-amber-600 focus:bg-white" />
          {hits.length > 0 && !hit && (
            // 위로 펼친다 — 표 상자가 가로 스크롤(overflow)이라 아래로 펼치면 맨 긴 블록에서 잘린다
            <div data-hits className="absolute left-0 bottom-full z-30 w-[190px] bg-white border border-amber-300 rounded shadow-lg text-left">
              {hits.map(h => (
                <button key={h.phone} onMouseDown={e => { e.preventDefault(); pick(h); }}
                  className="block w-full px-2 py-1 text-left hover:bg-amber-50 border-b border-stone-100 last:border-0">
                  <span className="text-[12px] font-bold text-stone-900">{h.babyName}</span>
                  <span className="ml-1 text-[10px] text-stone-400">{String(h.stage || '').replace('단계', '')} {h.volume || ''} · {h.lastDate.slice(5)}</span>
                  <span className="block text-[10px] text-stone-400 truncate">{h.address}</span>
                </button>
              ))}
            </div>
          )}
        </td>
        <td className="border border-dashed border-amber-400 p-0">
          {banchan ? null : (
            <button onClick={() => setBig(b => !b)} disabled={busy} title="눌러서 230 ↔ 300"
              className={`w-full py-[2px] text-[10px] font-black ${big ? 'text-red-600' : 'text-stone-700'}`}>
              {big ? BIG_VOLUME[stage] : SMALL_VOLUME[stage]}
            </button>
          )}
        </td>
        {keys.map(k => (
          <td key={k} className="border border-dashed border-amber-400 p-0">
            <input value={qty[k] || ''} inputMode="numeric" disabled={busy} title={banchan ? '세트 수' : menuLabel(k as any)}
              onChange={e => setQty(q => ({ ...q, [k]: e.target.value.replace(/\D/g, '').slice(0, 2) }))} onKeyDown={onKey}
              className={`${numCls} ${big ? 'text-red-600' : ''}`} />
          </td>
        ))}
        {Array.from({ length: extra }, (_, i) => <td key={`x${i}`} className="border border-dashed border-amber-400" />)}
      </tr>
      {(msg || hit) && (
        <tr className="no-print">
          <td colSpan={cols} className={`px-1 py-0.5 text-[10px] leading-tight ${msg && !msg.ok ? 'text-rose-700' : 'text-emerald-700'}`}>
            {msg ? msg.t : hit ? `${hit.address.slice(0, 18)} · 숫자 넣고 Enter` : ''}
          </td>
        </tr>
      )}
    </>
  );
}

/** 정보 나중에 넣기 — 이름·팩수만 먼저 넣은 아이의 연락처·주소·개월수·배송 방법.
    저장하면 그 연락처의 손님 카드에 이어지고(없으면 새로), 배송 방법에 맞춰 값이 다시 계산된다. */
export function LaterInfo({ order, onSaved, onClose }: {
  order: { id: string; baby_name: string; customer_phone?: string | null; address?: string | null; months?: number | null };
  onSaved: (row: any) => void; onClose?: () => void;
}) {
  const [phone, setPhone] = useState(order.customer_phone || '');
  const [address, setAddress] = useState(order.address || '');
  const [detail, setDetail] = useState('');
  const [door, setDoor] = useState('');
  const [months, setMonths] = useState('');
  const [receive, setReceive] = useState<'배송' | '픽업'>('배송');
  const [zone, setZone] = useState<'직배송' | '당일배송' | '택배익일배송'>('직배송');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (/강서구|양천구/.test(address)) setZone('직배송'); }, [address]);
  // 카톡 붙여넣기 → 읽힌 칸만 채운다 (못 읽은 칸은 그대로). lib/kakaoInfo
  const [paste, setPaste] = useState('');
  const [got, setGot] = useState<string | null>(null);
  function fromKakao(text: string) {
    setPaste(text);
    const k = parseKakaoInfo(text);
    if (k.phone) setPhone(k.phone);
    if (k.months) setMonths(k.months);
    if (k.address) setAddress(k.address);
    if (k.detail) setDetail(k.detail);
    if (k.door) setDoor(k.door);
    if (k.receive) setReceive(k.receive);
    if (k.zone) setZone(k.zone);
    const n = ['phone', 'months', 'address', 'detail', 'door', 'receive'].filter(x => (k as any)[x]).length;
    setGot(text.trim() ? (n ? `카톡에서 ${n}칸 읽었어요 — 맞는지 보고 '정보 넣기'` : '읽은 칸이 없어요 — 직접 적어 주세요') : null);
  }
  async function save() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/orders/${order.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ info: { customer_phone: phone, address, address_detail: detail, door_password: door, months, receive_method: receive, delivery_method: zone } }),
      }).then(x => x.json()).catch(e => ({ ok: false, error: e?.message }));
      if (!r.ok) { setMsg(r.error || '못 넣었어요'); return; }
      onSaved(r.row);
    } finally { setBusy(false); }
  }
  const inp = 'px-2 py-1 border border-stone-300 rounded text-[13px] outline-none focus:border-amber-400';
  return (
    <div className="mb-3 border-2 border-yellow-300 bg-yellow-50 rounded-xl p-3 text-[12px] space-y-2 no-print">
      <div className="flex items-center gap-2">
        <b className="text-[14px] text-stone-900">{order.baby_name}</b>
        <span className="text-stone-600">정보 넣기 — 이름·팩수만 먼저 넣은 아이예요</span>
        {onClose && <button onClick={onClose} className="ml-auto text-stone-500 underline">닫기</button>}
      </div>
      <textarea value={paste} onChange={e => fromKakao(e.target.value)} rows={2}
        placeholder="카톡 내용을 그대로 붙여넣으면 연락처·주소·동호수·현관 비번·개월을 읽어 채워요"
        className={` w-full resize-y text-[12px]`} />
      {got && <p className="text-[11px] font-bold text-amber-800">{got}</p>}
      <div className="flex gap-1.5 flex-wrap">
        <input value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="연락처" className={`${inp} w-32`} />
        <input value={months} onChange={e => setMonths(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="개월" className={`${inp} w-14`} />
        <select value={receive} onChange={e => setReceive(e.target.value as any)} className={inp}><option>배송</option><option>픽업</option></select>
        {receive === '배송' && (
          <select value={zone} onChange={e => setZone(e.target.value as any)} className={inp}>
            <option value="직배송">직배송 (강서·양천)</option><option value="당일배송">당일배송 (그 외)</option><option value="택배익일배송">택배</option>
          </select>
        )}
      </div>
      {receive === '배송' && (
        <div className="flex gap-1.5 flex-wrap">
          <input value={address} onChange={e => setAddress(e.target.value)} placeholder="주소" className={`${inp} flex-1 min-w-[200px]`} />
          <input value={detail} onChange={e => setDetail(e.target.value)} placeholder="동·호수" className={`${inp} w-28`} />
          <input value={door} onChange={e => setDoor(e.target.value)} placeholder="현관 비번" className={`${inp} w-24`} />
        </div>
      )}
      <div className="flex items-center gap-2">
        <button onClick={save} disabled={busy} className="px-4 py-1.5 rounded-lg border-2 border-yellow-400 bg-yellow-200 text-stone-900 text-[13px] font-black disabled:opacity-40">
          {busy ? '넣는 중…' : '정보 넣기'}
        </button>
        {msg && <span className="text-rose-700 font-bold">{msg}</span>}
      </div>
    </div>
  );
}

/** 그날 주문이 하나도 없는 단계 —단추를 누르면 그 단계의 빈 표(추가 줄만)가 열린다. 넣으면 진짜 블록이 생기고 이건 닫힌다 */
export function AddMissing({ sheet, date, onAdded }: { sheet: { sections: { stage: string }[]; banchan: unknown[] }; date: string; onAdded: (row: any) => void }) {
  const [open, setOpen] = useState<string[]>([]);
  const missing = [...STAGES.filter(s => !sheet.sections.some(sec => sec.stage === s)), ...(sheet.banchan.length ? [] : ['반찬'])];
  if (!missing.length) return null;
  return (
    <div className="mt-2 no-print">
      <div className="flex gap-1.5 flex-wrap items-center text-[11px] text-stone-400">
        오늘 없는 단계에 넣기:
        {missing.filter(s => !open.includes(s)).map(s => (
          <button key={s} onClick={() => setOpen(o => [...o, s])}
            className="px-2 py-0.5 rounded-lg border border-dashed border-amber-400 bg-amber-50 text-amber-800 text-[12px] font-bold">
            ＋ {s === '반찬' ? '반찬 세트' : s.replace('단계', '')}
          </button>
        ))}
      </div>
      {open.some(s => missing.includes(s)) && (
        <div className="mt-2 flex gap-2 flex-wrap items-start">
          {open.filter(s => missing.includes(s)).map(s => (
            <AddBlock key={s} stage={s} date={date} onAdded={r => { onAdded(r); setOpen(o => o.filter(x => x !== s)); }}
              onClose={() => setOpen(o => o.filter(x => x !== s))} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 그날 주문이 하나도 없는 단계에 넣을 때 — 머리와 추가 줄만 있는 작은 표 */
export function AddBlock({ stage, date, onAdded, onClose }: { stage: string; date: string; onAdded: (row: any) => void; onClose: () => void }) {
  const banchan = stage === '반찬';
  const cols = banchan ? 3 : MENU_TYPES.length + 2;
  return (
    <div className="break-inside-avoid no-print">
      <table className="table-fixed border-collapse text-[14px] leading-tight">
        <colgroup>
          <col style={{ width: 78 }} /><col style={{ width: 22 }} />
          {(banchan ? ['세트'] : MENU_TYPES).map(m => <col key={m} style={{ width: banchan ? 26 : 22 }} />)}
        </colgroup>
        <thead>
          <tr>
            <th colSpan={cols} className="border border-black px-0.5 py-[2px] text-[13px] text-center whitespace-nowrap">
              {banchan ? '반찬 세트' : stage.replace('단계', '')}
              <button onClick={onClose} className="ml-1 text-[10px] font-normal text-stone-400">닫기</button>
            </th>
          </tr>
          <tr className="bg-stone-200">
            <th className="border border-black px-0 py-[2px] text-[11px]">이 름</th>
            <th className="border border-black px-0 py-[2px] text-[10px]">{banchan ? '배송' : '용량'}</th>
            {(banchan ? ['수'] : MENU_TYPES.map(m => menuLabel(m))).map(m => <th key={m} className="border border-black px-0 py-[2px] text-[10px]">{m}</th>)}
          </tr>
        </thead>
        <tbody><AddRow stage={stage} date={date} onAdded={onAdded} cols={cols} /></tbody>
      </table>
    </div>
  );
}
