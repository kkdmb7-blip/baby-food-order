'use client';
import { useEffect, useRef, useState } from 'react';
import { MENU_TYPES, STAGES, menuLabel } from '@/lib/supabase';
import { BIG_VOLUME, SMALL_VOLUME } from '@/lib/cookingSheet';

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

export function AddRow({ stage, date, onAdded, cols }: {
  stage: string;              // '중기1단계' … 또는 '반찬'
  date: string;
  onAdded: (row: any) => void;
  cols: number;               // 표 칸 수 (메모 줄 colSpan)
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
    let h = hit;
    if (!h) {
      const exact = hits.filter(x => x.babyName.replace(/\s/g, '') === name.trim().replace(/\s/g, ''));
      if (exact.length === 1) h = exact[0];
      else { setMsg({ ok: false, t: hits.length ? '아래 목록에서 아이를 골라 주세요' : '지난 주문이 없는 손님은 주문 탭에서 넣어 주세요' }); return; }
    }
    if (total < 1) { setMsg({ ok: false, t: '팩 수를 넣어 주세요' }); return; }
    const months = h.guessMonths || h.lastMonths;
    if (!months) { setMsg({ ok: false, t: '개월수를 몰라요 — 주문 탭에서 넣어 주세요' }); return; }
    const volume = banchan ? null : (big ? BIG_VOLUME[stage] : SMALL_VOLUME[stage]);
    const sets = banchan
      ? [{ stage: '반찬세트', volume: null, simple: true, menus: [], qty: total }]
      : [{ stage, volume, simple: false, qty: total,
           menus: MENU_TYPES.filter(m => Number(qty[m]) > 0).map(m => ({ menu: m, qty: Number(qty[m]) })) }];
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          admin_manual: true, baby_name: h.babyName, months, customer_phone: h.phone,
          address: h.address, address_detail: h.addressDetail, door_password: h.doorPassword,
          stage: banchan ? null : stage, volume, delivery_date: date, order_type: '일반',
          receive_method: h.receiveMethod === '픽업' ? '픽업' : '배송',
          delivery_method: h.receiveMethod === '픽업' ? '직배송' : (h.deliveryMethod || (/강서구|양천구/.test(h.address) ? '직배송' : '당일배송')),
          postal_code: h.postalCode, total_qty: total,
          items: [{ delivery_date: date, sets, date_qty: total }],
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) { setMsg({ ok: false, t: j.error || `못 넣었어요 (${res.status})` }); return; }
      if (j.row) onAdded(j.row);
      setMsg({ ok: true, t: `${h.babyName} ${total}${banchan ? '세트' : '팩'} 넣었어요` });
      setName(''); setHit(null); setHits([]); setQty({}); setBig(false);
      setTimeout(() => nameRef.current?.focus(), 0);
    } catch (e: any) {
      setMsg({ ok: false, t: e?.message || '네트워크 오류' });
    } finally { setBusy(false); }
  }

  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
  const numCls = 'w-full text-center bg-white outline-none font-black py-[2px] text-[13px] focus:bg-amber-100 disabled:opacity-40';
  return (
    <>
      <tr className="no-print bg-amber-50">
        <td className="border border-dashed border-amber-400 p-0 relative">
          <input ref={nameRef} value={name} onChange={e => setName(e.target.value)} onKeyDown={onKey} disabled={busy}
            placeholder="＋ 이름" className="w-full px-0.5 py-[2px] text-[13px] font-bold text-center bg-transparent outline-none placeholder:text-amber-600 focus:bg-white" />
          {hits.length > 0 && !hit && (
            // 위로 펼친다 — 표 상자가 가로 스크롤(overflow)이라 아래로 펼치면 맨 긴 블록에서 잘린다
            <div className="absolute left-0 bottom-full z-30 w-[190px] bg-white border border-amber-300 rounded shadow-lg text-left">
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

/** 그날 주문이 하나도 없는 단계 — 단추를 누르면 그 단계의 빈 표(추가 줄만)가 열린다. 넣으면 진짜 블록이 생기고 이건 닫힌다 */
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
