'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MENU_TYPES, STAGES, STAGE_OPTIONS, menuLabel, type StageType, type MenuType } from '@/lib/supabase';

/*
  엑셀처럼 줄줄이 치는 입력판.

  왜 또 만드는가
    CookingEntry(조리표에 줄 넣기)는 한 번에 한 명이다. 폼을 열고, 찾고, 저장하고,
    비우고, 다시. 전에 쓰시던 엑셀은 그게 아니라 격자였다 — 행이 손님이고 열이
    단계·메뉴라서, 한 화면에 수십 줄이 보이고 숫자만 쳐 내려가면 됐다.
    오전에 쳐야 할 양이 하루 200팩 가까이 되는데 한 명씩 여닫으면 그 속도가 안 난다.

  엑셀과 다르게 한 것
    엑셀은 단계 4개를 열로 펼쳐 두고(중1/중2/후기/완료기 × 한우·닭·야채 = 12칸)
    손님마다 해당 칸에만 숫자를 넣었다. 아기 하나는 보통 한 단계만 먹으니
    12칸 중 11칸이 늘 비어 있다. 여기서는 단계·용량을 드롭다운 한 칸으로 줄이고
    메뉴 3칸만 숫자로 받는다. 치는 횟수가 줄고 화면도 좁아진다.

    그리고 엑셀은 조리갯수를 보려면 시트를 옮겨야 했다. 여기서는 치는 즉시
    아래에 집계가 바뀐다.

  단골 전용이다
    저장에는 연락처·주소·개월수가 있어야 한다. 이름을 골라 지난 주문에서
    집을 끌어와야 그게 채워진다. 처음 오는 손님은 이 화면에서 못 넣는다 —
    '조리표에 줄 넣기'(CookingEntry)로 가야 한다. 화면에 그렇게 적어 둔다.

  저장은 줄 단위다
    한 줄 실패가 다른 줄을 막지 않게 한 줄씩 보내고, 성공한 줄만 잠근다.
    중간에 끊겨도 어디까지 들어갔는지 줄마다 보인다.
*/

type Hit = {
  babyName: string; phone: string; address: string; addressDetail: string | null;
  doorPassword: string | null; stage: string | null; volume: number | null;
  postalCode: string | null; deliveryMethod: string | null; receiveMethod: string | null;
  lastDate: string; lastMonths: number; guessMonths: number; orders: number; orderType: string | null;
};

type Row = {
  key: number;
  q: string;                       // 이름 칸에 친 글자
  hit: Hit | null;                 // 골라서 붙은 집
  stage: StageType | '';
  volume: string;
  qty: Record<string, string>;     // 메뉴별 팩수
  state: 'edit' | 'saving' | 'saved' | 'error';
  error?: string;
};

let SEQ = 1;
const blankRow = (): Row => ({
  key: SEQ++, q: '', hit: null, stage: '', volume: '',
  qty: {}, state: 'edit',
});

const BLANK_ROWS = 10;

export default function GridEntry({ date, onSaved }: { date: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [deliveryDate, setDeliveryDate] = useState(date);
  const [rows, setRows] = useState<Row[]>(() => Array.from({ length: BLANK_ROWS }, blankRow));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // 이름 자동완성 — 지금 타이핑 중인 줄에서만 뜬다
  const [openRow, setOpenRow] = useState<number | null>(null);   // 열려 있는 줄 key
  const [hits, setHits] = useState<Hit[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => { setDeliveryDate(date); }, [date]);

  const activeRow = rows.find(r => r.key === openRow);
  const term = (activeRow?.q || '').trim();

  useEffect(() => {
    if (!openRow || term.length < 1) { setHits([]); return; }
    let alive = true;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const d = await fetch(`/api/admin/order-lookup?q=${encodeURIComponent(term)}`).then(r => r.json());
        if (alive && d.ok) setHits(d.hits || []);
      } catch { /* 못 찾아도 다른 줄은 쳐야 하니 조용히 */ }
      if (alive) setSearching(false);
    }, 220);
    return () => { alive = false; clearTimeout(t); };
  }, [term, openRow]);

  function patch(key: number, p: Partial<Row>) {
    setRows(rs => rs.map(r => (r.key === key ? { ...r, ...p } : r)));
  }

  // 마지막 줄을 건드리면 아래에 한 줄 더 — 줄이 모자라 멈추는 일이 없게
  function ensureTail() {
    setRows(rs => {
      const last = rs[rs.length - 1];
      const touched = last && (last.q || last.stage || Object.values(last.qty).some(Boolean));
      return touched ? [...rs, blankRow()] : rs;
    });
  }

  function pick(key: number, h: Hit) {
    const stage = h.stage && (STAGES as string[]).includes(h.stage) ? (h.stage as StageType) : '';
    // 지난 주문의 용량이 그 단계에 없는 값이면(단계가 바뀐 경우) 비워 둔다
    const okVol = stage && h.volume
      ? STAGE_OPTIONS[stage].some(o => o.volume === h.volume) : false;
    patch(key, {
      q: h.babyName, hit: h, stage,
      volume: okVol ? String(h.volume) : '',
      state: 'edit', error: undefined,
    });
    setOpenRow(null); setHits([]);
    ensureTail();
  }

  const rowTotal = (r: Row) => MENU_TYPES.reduce((a, m) => a + (Number(r.qty[m]) || 0), 0);
  const filled = rows.filter(r => rowTotal(r) > 0);
  const ready = filled.filter(r => r.hit && r.stage && r.volume && r.state !== 'saved');
  const blocked = filled.filter(r => !(r.hit && r.stage && r.volume) && r.state !== 'saved');

  // 조리갯수 — 엑셀 '조리갯수' 시트와 같은 모양 (단계 × 용량 × 메뉴)
  const tally = useMemo(() => {
    const out: { label: string; stage: StageType; volume: number; counts: Record<string, number>; sum: number }[] = [];
    for (const s of STAGES) {
      for (const o of STAGE_OPTIONS[s]) {
        const counts: Record<string, number> = {};
        let sum = 0;
        for (const m of MENU_TYPES) {
          const n = rows
            .filter(r => r.stage === s && Number(r.volume) === o.volume)
            .reduce((a, r) => a + (Number(r.qty[m]) || 0), 0);
          counts[m] = n; sum += n;
        }
        out.push({ label: `${s}(${o.volume})`, stage: s, volume: o.volume, counts, sum });
      }
    }
    return out;
  }, [rows]);

  const grand = tally.reduce((a, t) => a + t.sum, 0);
  const perMenu = MENU_TYPES.map(m => ({ m, n: tally.reduce((a, t) => a + t.counts[m], 0) }));

  async function saveAll() {
    if (!ready.length) return;
    setBusy(true); setNote(null);
    let ok = 0, fail = 0;

    for (const r of ready) {
      patch(r.key, { state: 'saving', error: undefined });
      const h = r.hit!;
      const total = rowTotal(r);
      const addr = h.address + (h.addressDetail ? ' ' + h.addressDetail : '');
      const zone =
        h.deliveryMethod === '직배송' || h.deliveryMethod === '당일배송' || h.deliveryMethod === '택배익일배송'
          ? h.deliveryMethod
          : (/강서구|양천구/.test(addr) ? '직배송' : '당일배송');
      const receive = h.receiveMethod === '픽업' ? '픽업' : '배송';

      try {
        const res = await fetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            admin_manual: true,
            baby_name: h.babyName,
            months: h.guessMonths || h.lastMonths,
            customer_phone: h.phone.replace(/\D/g, ''),
            address: addr,
            door_password: h.doorPassword || null,
            stage: r.stage,
            volume: Number(r.volume),
            delivery_date: deliveryDate,
            order_type: h.orderType === '선결제' ? '선결제' : '일반',
            receive_method: receive,
            delivery_method: receive === '픽업' ? '직배송' : zone,
            postal_code: h.postalCode || null,
            total_qty: total,
            items: [{
              delivery_date: deliveryDate,
              sets: [{
                stage: r.stage, volume: Number(r.volume), simple: false, qty: total,
                menus: MENU_TYPES.filter(m => (Number(r.qty[m]) || 0) > 0)
                  .map(m => ({ menu: m, qty: Number(r.qty[m]) })),
              }],
              date_qty: total,
            }],
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || j.ok === false) {
          patch(r.key, { state: 'error', error: j.error || `실패 (${res.status})` });
          fail++;
        } else {
          patch(r.key, { state: 'saved' });
          ok++;
        }
      } catch (e: any) {
        patch(r.key, { state: 'error', error: e?.message || '네트워크 오류' });
        fail++;
      }
    }

    setBusy(false);
    setNote(fail ? `${ok}줄 넣었고 ${fail}줄 실패했어요. 실패한 줄은 그대로 남아 있습니다.` : `${ok}줄 넣었어요.`);
    if (ok) onSaved();
  }

  function clearSaved() {
    setRows(rs => {
      const rest = rs.filter(r => r.state !== 'saved');
      const need = Math.max(0, BLANK_ROWS - rest.length);
      return [...rest, ...Array.from({ length: need }, blankRow)];
    });
    setNote(null);
  }

  const cell = 'w-full rounded border border-stone-300 px-2 py-1.5 text-sm focus:border-amber-500 focus:outline-none';
  const num = cell + ' text-center';

  return (
    <div className="bg-white rounded-xl border border-amber-200 overflow-hidden no-print mb-4">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-4 py-3 text-left">
        <span className="font-bold text-stone-900 text-sm">
          엑셀처럼 줄줄이 넣기
          {grand > 0 && <span className="ml-2 font-normal text-amber-700">{grand}팩</span>}
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
            <p className="text-xs text-stone-500">
              이름을 치고 <b>아래 뜨는 집을 고르면</b> 연락처·주소가 붙습니다. 처음 오는 손님은 아래 <b>조리표에 줄 넣기</b>로 넣어주세요.
            </p>
          </div>

          {/* 격자 */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ minWidth: 640 }}>
              <thead>
                <tr className="text-xs text-stone-500">
                  <th className="text-left font-medium pb-1 w-8"></th>
                  <th className="text-left font-medium pb-1" style={{ minWidth: 150 }}>이름</th>
                  <th className="text-left font-medium pb-1" style={{ minWidth: 110 }}>단계</th>
                  <th className="text-left font-medium pb-1" style={{ minWidth: 90 }}>용량</th>
                  {MENU_TYPES.map(m => (
                    <th key={m} className="font-medium pb-1" style={{ minWidth: 56 }}>{menuLabel(m)}</th>
                  ))}
                  <th className="font-medium pb-1 w-12">합</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const t = rowTotal(r);
                  const locked = r.state === 'saved' || r.state === 'saving';
                  const vols = r.stage ? STAGE_OPTIONS[r.stage].map(o => o.volume) : [];
                  return (
                    <tr key={r.key} className={r.state === 'saved' ? 'opacity-50' : ''}>
                      <td className="pr-1 text-[11px] text-stone-400 text-right align-middle">{i + 1}</td>

                      {/* 이름 + 자동완성 */}
                      <td className="pr-1 py-0.5 relative">
                        <input
                          value={r.q} disabled={locked}
                          onChange={e => { patch(r.key, { q: e.target.value, hit: null }); setOpenRow(r.key); ensureTail(); }}
                          onFocus={() => setOpenRow(r.key)}
                          placeholder="이름"
                          className={cell + (r.hit ? ' border-emerald-400 bg-emerald-50/40' : '')}
                        />
                        {openRow === r.key && r.q.trim() && !r.hit && (
                          <div className="absolute z-30 left-0 right-0 mt-0.5 bg-white border border-stone-200 rounded-lg shadow-lg max-h-56 overflow-auto">
                            {searching && <p className="px-2 py-1.5 text-xs text-stone-400">찾는 중…</p>}
                            {!searching && hits.length === 0 && (
                              <p className="px-2 py-1.5 text-xs text-stone-400">지난 주문에 없는 이름이에요</p>
                            )}
                            {hits.map(h => (
                              <button key={h.phone} onClick={() => pick(r.key, h)}
                                className="block w-full text-left px-2 py-1.5 hover:bg-amber-50 border-b border-stone-50 last:border-0">
                                <span className="text-sm font-bold text-stone-900">{h.babyName}</span>
                                {h.orderType === '선결제' && <span className="ml-1 text-[10px] text-sky-700">선결제</span>}
                                <span className="block text-[11px] text-stone-400 truncate">
                                  {h.lastDate} · {h.stage || '-'}{h.volume ? ` ${h.volume}g` : ''} · {h.address}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </td>

                      <td className="pr-1 py-0.5">
                        <select value={r.stage} disabled={locked}
                          onChange={e => patch(r.key, { stage: e.target.value as StageType, volume: '' })}
                          className={cell}>
                          <option value=""></option>
                          {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </td>

                      <td className="pr-1 py-0.5">
                        <select value={r.volume} disabled={locked || !r.stage}
                          onChange={e => patch(r.key, { volume: e.target.value })} className={cell}>
                          <option value=""></option>
                          {vols.map(v => <option key={v} value={v}>{v}g</option>)}
                        </select>
                      </td>

                      {MENU_TYPES.map(m => (
                        <td key={m} className="pr-1 py-0.5">
                          <input inputMode="numeric" value={r.qty[m] || ''} disabled={locked}
                            onChange={e => {
                              const v = e.target.value.replace(/\D/g, '').slice(0, 2);
                              patch(r.key, { qty: { ...r.qty, [m]: v } });
                              ensureTail();
                            }}
                            className={num} />
                        </td>
                      ))}

                      <td className="text-center text-sm font-semibold text-stone-700">
                        {t || ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 줄 상태 */}
          {blocked.length > 0 && (
            <p className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              팩수는 넣었는데 <b>집·단계·용량이 안 붙은 줄이 {blocked.length}개</b> 있어요. 그 줄은 저장되지 않습니다.
            </p>
          )}
          {rows.some(r => r.state === 'error') && (
            <div className="mt-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 space-y-0.5">
              {rows.filter(r => r.state === 'error').map(r => (
                <p key={r.key}>{r.q || '이름 없음'} — {r.error}</p>
              ))}
            </div>
          )}

          {/* 조리갯수 — 엑셀 '조리갯수' 시트 자리 */}
          <div className="mt-4 rounded-lg border border-stone-200 overflow-hidden">
            <div className="px-3 py-2 bg-stone-50 border-b border-stone-200 flex items-baseline justify-between">
              <span className="text-sm font-bold text-stone-800">조리갯수</span>
              <span className="text-xs text-stone-500">치는 대로 바뀝니다</span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-stone-500">
                  <th className="text-left font-medium px-3 py-1.5">단계(용량)</th>
                  {MENU_TYPES.map(m => <th key={m} className="font-medium px-2 py-1.5 w-16">{menuLabel(m)}</th>)}
                  <th className="font-medium px-2 py-1.5 w-16">합</th>
                </tr>
              </thead>
              <tbody>
                {tally.map(t => (
                  <tr key={t.label} className={t.sum ? 'border-t border-stone-100' : 'border-t border-stone-100 text-stone-300'}>
                    <td className="px-3 py-1 text-stone-700">{t.label}</td>
                    {MENU_TYPES.map(m => (
                      <td key={m} className="px-2 py-1 text-center">{t.counts[m] || ''}</td>
                    ))}
                    <td className="px-2 py-1 text-center font-semibold">{t.sum || ''}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-stone-300 bg-stone-50 font-bold">
                  <td className="px-3 py-1.5 text-stone-800">합계</td>
                  {perMenu.map(({ m, n }) => <td key={m} className="px-2 py-1.5 text-center">{n || ''}</td>)}
                  <td className="px-2 py-1.5 text-center text-amber-700">{grand || ''}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {note && <p className="mt-2 text-sm text-stone-700 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2">{note}</p>}

          <div className="mt-3 flex gap-2">
            <button onClick={saveAll} disabled={busy || !ready.length}
              className="flex-1 rounded-xl bg-amber-500 py-3 text-sm font-semibold text-white disabled:bg-stone-200 disabled:text-stone-400">
              {busy ? '넣는 중…' : ready.length ? `${ready.length}줄 조리표에 넣기` : '넣을 줄이 없어요'}
            </button>
            {rows.some(r => r.state === 'saved') && (
              <button onClick={clearSaved} disabled={busy}
                className="px-4 rounded-xl border border-stone-300 text-sm text-stone-600">
                넣은 줄 치우기
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
