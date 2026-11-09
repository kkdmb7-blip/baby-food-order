'use client';
import { useMemo, useState } from 'react';
import { STAGES, MENU_TYPES, menuLabel, type StageType } from '@/lib/supabase';
import { parseKakaoOrder, missingFields, FIELD_LABEL, EMPTY_PARSED, type ParsedKakaoOrder } from '@/lib/parseKakaoOrder';

const VOLUMES = ['230', '240', '300', '310'] as const;

/**
 * 카톡으로 받은 주문을 옮겨 적는 화면.
 *
 * 그동안은 카톡 주문서를 보고 엑셀에 손으로 옮기셨다. 여기에 붙여넣으면
 * 칸이 자동으로 채워지고, 팩수만 넣으면 주문이 된다. 그러면 조리표·주소록·
 * 배송 탭이 전부 따라 움직이고 선결제 차감도 자동으로 된다.
 *
 * 못 읽은 칸은 비워서 보여준다. 멋대로 채우면 틀린 걸 모르고 넘어간다.
 */
export default function KakaoOrderEntry({ today, onDone }: { today: string; onDone: () => void }) {
  const [raw, setRaw] = useState('');
  const [f, setF] = useState<ParsedKakaoOrder>(EMPTY_PARSED);
  const [touched, setTouched] = useState(false);

  const [orderType, setOrderType] = useState<'일반' | '선결제'>('일반');
  const [receive, setReceive] = useState<'배송' | '픽업'>('배송');
  const [menuQty, setMenuQty] = useState<Record<string, string>>({});
  const [banchanQty, setBanchanQty] = useState('');
  const [memo, setMemo] = useState('');

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const totalQty = useMemo(() => {
    if (f.isBanchan) return Number(banchanQty) || 0;
    return MENU_TYPES.reduce((a, m) => a + (Number(menuQty[m]) || 0), 0);
  }, [f.isBanchan, banchanQty, menuQty]);

  const missing = useMemo(() => missingFields(f), [f]);
  const canSubmit = touched && missing.length === 0 && totalQty > 0 && !busy;

  function applyPaste(text: string) {
    setRaw(text);
    setF(parseKakaoOrder(text, today));
    setTouched(true);
    setMsg(null);
  }

  function set<K extends keyof ParsedKakaoOrder>(k: K, v: ParsedKakaoOrder[K]) {
    setF(p => ({ ...p, [k]: v }));
  }

  function reset() {
    setRaw(''); setF(EMPTY_PARSED); setTouched(false);
    setMenuQty({}); setBanchanQty(''); setMemo('');
    setOrderType('일반'); setReceive('배송'); setMsg(null);
  }

  async function submit() {
    setBusy(true); setMsg(null);
    try {
      const sets = f.isBanchan
        ? [{ stage: '반찬세트', volume: null, simple: true, menus: [], qty: totalQty }]
        : [{
            stage: f.stage, volume: Number(f.volume), simple: false, qty: totalQty,
            menus: MENU_TYPES
              .filter(m => (Number(menuQty[m]) || 0) > 0)
              .map(m => ({ menu: m, qty: Number(menuQty[m]) })),
          }];

      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          admin_manual: true,
          baby_name: f.baby_name,
          months: Number(f.months),
          customer_phone: f.customer_phone,
          address: f.address,
          door_password: f.door_password || null,
          stage: f.isBanchan ? null : f.stage,
          volume: f.isBanchan ? null : Number(f.volume),
          delivery_date: f.delivery_date,
          order_type: orderType,
          receive_method: receive,
          // 주소만 있고 우편번호는 카톡 주문서에 없다. 지역 판정은 서버가
          // delivery_method 로 폴백한다 — 강서·양천이면 직배송을 골라주세요.
          delivery_method: receive === '픽업' ? '직배송' : '당일배송',
          total_qty: totalQty,
          // memo 는 insert 대상이 아니라 보내도 조용히 버려진다 —
          // 실제로 저장되는 자유 입력칸은 customer_request(60자).
          customer_request: memo || null,
          items: [{
            delivery_date: f.delivery_date,
            sets,
            date_qty: totalQty,
          }],
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) {
        setMsg({ ok: false, text: j.error || `등록 실패 (${res.status})` });
      } else {
        setMsg({ ok: true, text: `${f.baby_name} ${f.delivery_date} ${totalQty}팩 등록했어요` });
        reset();
        onDone();
      }
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || '네트워크 오류' });
    } finally {
      setBusy(false);
    }
  }

  const input = 'w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none';
  const label = 'block text-xs font-medium text-stone-500 mb-1';

  return (
    <div className="space-y-5">
      {/* 붙여넣기 */}
      <div className="rounded-xl border border-stone-200 bg-white p-4">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold text-stone-700">카톡 주문서 붙여넣기</h3>
          {raw && (
            <button onClick={reset} className="text-xs text-stone-400 hover:text-stone-600">
              지우기
            </button>
          )}
        </div>
        <textarea
          value={raw}
          onChange={e => applyPaste(e.target.value)}
          onPaste={e => {
            const t = e.clipboardData.getData('text');
            if (t) { e.preventDefault(); applyPaste(t); }
          }}
          rows={5}
          placeholder={'받으신 주문서를 통째로 붙여넣으세요.\n1️⃣ 조리일 : 11월9일\n2️⃣ 아기이름 : …'}
          className={input + ' font-mono text-xs leading-relaxed'}
        />
        {touched && (
          <p className={`mt-2 text-xs ${missing.length ? 'text-amber-700' : 'text-emerald-700'}`}>
            {missing.length
              ? `못 읽은 칸이 있어요 — ${missing.map(k => FIELD_LABEL[k]).join(', ')}. 아래에서 직접 넣어주세요.`
              : '전부 읽었어요. 팩수만 넣으면 됩니다.'}
          </p>
        )}
      </div>

      {/* 읽어낸 값 */}
      <div className="rounded-xl border border-stone-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold text-stone-700">주문 내용</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>
            <span className={label}>조리일</span>
            <input type="date" value={f.delivery_date} onChange={e => set('delivery_date', e.target.value)} className={input} />
          </div>
          <div>
            <span className={label}>아기 이름</span>
            <input value={f.baby_name} onChange={e => set('baby_name', e.target.value)} className={input} />
          </div>
          <div>
            <span className={label}>개월수</span>
            <input inputMode="numeric" value={f.months} onChange={e => set('months', e.target.value.replace(/\D/g, ''))} className={input} />
          </div>
          <div className="col-span-2 sm:col-span-3">
            <span className={label}>주소</span>
            <input value={f.address} onChange={e => set('address', e.target.value)} className={input} />
          </div>
          <div>
            <span className={label}>현관 비번</span>
            <input value={f.door_password} onChange={e => set('door_password', e.target.value)} className={input} />
          </div>
          <div>
            <span className={label}>연락처</span>
            <input inputMode="numeric" value={f.customer_phone} onChange={e => set('customer_phone', e.target.value.replace(/\D/g, ''))} className={input} />
          </div>
          <div>
            <span className={label}>받는 방법</span>
            <select value={receive} onChange={e => setReceive(e.target.value as any)} className={input}>
              <option value="배송">배송</option>
              <option value="픽업">픽업</option>
            </select>
          </div>
        </div>

        <label className="mt-4 flex items-center gap-2 text-sm text-stone-700">
          <input type="checkbox" checked={f.isBanchan} onChange={e => set('isBanchan', e.target.checked)} className="h-4 w-4 accent-amber-500" />
          유아식(반찬) 주문
        </label>

        {!f.isBanchan && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <span className={label}>단계</span>
              <select value={f.stage} onChange={e => set('stage', e.target.value as StageType)} className={input}>
                <option value="">고르기</option>
                {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <span className={label}>용량</span>
              <select value={f.volume} onChange={e => set('volume', e.target.value)} className={input}>
                <option value="">고르기</option>
                {VOLUMES.map(v => <option key={v} value={v}>{v}g</option>)}
              </select>
            </div>
          </div>
        )}
      </div>

      {/* 팩수 */}
      <div className="rounded-xl border border-stone-200 bg-white p-4">
        <h3 className="mb-1 text-sm font-semibold text-stone-700">팩수</h3>
        <p className="mb-3 text-xs text-stone-400">주문서에 없는 값이라 직접 넣어주세요. 조리표가 이 숫자로 찍힙니다.</p>
        {f.isBanchan ? (
          <div className="w-32">
            <span className={label}>반찬 세트</span>
            <input inputMode="numeric" value={banchanQty}
              onChange={e => setBanchanQty(e.target.value.replace(/\D/g, ''))} className={input} />
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {MENU_TYPES.map(m => (
              <div key={m}>
                <span className={label}>{menuLabel(m)}</span>
                <input inputMode="numeric" value={menuQty[m] || ''}
                  onChange={e => setMenuQty(q => ({ ...q, [m]: e.target.value.replace(/\D/g, '') }))}
                  className={input} />
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-sm font-semibold text-stone-700">합계 {totalQty}팩</p>
      </div>

      {/* 결제·메모 */}
      <div className="rounded-xl border border-stone-200 bg-white p-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className={label}>주문 유형</span>
            <select value={orderType} onChange={e => setOrderType(e.target.value as any)} className={input}>
              <option value="일반">일반 (입금 확인)</option>
              <option value="선결제">선결제 (잔여 팩 차감)</option>
            </select>
          </div>
          <div>
            <span className={label}>요청사항</span>
            <input value={memo} onChange={e => setMemo(e.target.value.slice(0, 60))} placeholder="보냉가방 등" className={input} />
          </div>
        </div>
        {orderType === '선결제' && (
          <p className="mt-2 text-xs text-stone-500">
            연락처와 아기 이름이 등록된 선결제 고객과 맞아야 합니다. {totalQty}팩이 잔여에서 빠집니다.
          </p>
        )}
      </div>

      {msg && (
        <p className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'}`}>
          {msg.text}
        </p>
      )}

      <button
        onClick={submit}
        disabled={!canSubmit}
        className="w-full rounded-xl bg-amber-500 py-3 text-sm font-semibold text-white disabled:bg-stone-200 disabled:text-stone-400">
        {busy ? '등록 중…' : '주문 등록'}
      </button>
    </div>
  );
}
