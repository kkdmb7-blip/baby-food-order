'use client';
import { useEffect, useRef, useState } from 'react';
import { MENU_TYPES, STAGES, STAGE_OPTIONS, HANWOO_MAX_RATIO, menuLabel, type StageType } from '@/lib/supabase';

/*
  조리표에 줄을 직접 넣는 칸.

  왜 파싱이 아니라 이것인가
    카톡 주문서를 통째로 붙여넣어 읽는 방식을 전에 시도하셨고, 양식이 일정하지
    않아서 잘 안 됐다. 손님이 손으로 쓰는 글이라 양식을 강제할 수 없고,
    10년 단골에게 "양식 지켜주세요" 라고 할 수도 없다. 읽어주는 쪽을 고치는 대신
    치는 쪽을 빠르게 만든다.

  빠르게 만드는 방법
    오전 7시에 실제로 쳐야 하는 건 이름과 팩수뿐이다. 연락처·주소·현관비번·
    단계·용량은 단골이면 지난 주문에 이미 있다. 이름 두 글자를 치면 지난 주문에서
    그 집을 찾아 전부 끌어온다(/api/admin/order-lookup).
    저장하면 이름·팩수만 비우고 조리일과 단계·용량은 남긴다 — 같은 날 여러 줄을
    연달아 치시기 때문이다.

  왜 주문 DB 로 넣는가
    따로 저장하면 배송·주소록·엑셀·선결제·입금 대조가 전부 다시 수동이 된다.
    같은 경로(/api/orders, admin_manual)로 넣으면 그 전부가 따라 움직인다.
    대신 관리자 주문이므로 최소 팩수·한우 비율·조리 요일 제한은 서버가 비켜준다.

  멋대로 채우지 않는다
    개월수는 지난 주문 때의 값에 그동안 지난 달수를 더한 '짐작값' 이다.
    무엇을 근거로 짐작했는지 화면에 적어둔다. 날짜까지는 보지 않으니 한 달 틀릴 수 있다.
*/

type Hit = {
  babyName: string; phone: string; address: string; addressDetail: string | null;
  doorPassword: string | null; stage: string | null; volume: number | null;
  postalCode: string | null; deliveryMethod: string | null; receiveMethod: string | null;
  lastDate: string; lastMonths: number; guessMonths: number; orders: number; orderType: string | null;
};

const VOL_ALL = [230, 240, 300, 310];

export default function CookingEntry({ date, onSaved }: { date: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);

  // 손님 찾기
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [picked, setPicked] = useState<Hit | null>(null);
  const [searching, setSearching] = useState(false);

  // 칸
  const [deliveryDate, setDeliveryDate] = useState(date);
  const [babyName, setBabyName] = useState('');
  const [months, setMonths] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [doorPassword, setDoorPassword] = useState('');
  const [isBanchan, setIsBanchan] = useState(false);
  const [stage, setStage] = useState<StageType | ''>('');
  const [volume, setVolume] = useState('');
  const [menuQty, setMenuQty] = useState<Record<string, string>>({});
  const [banchanQty, setBanchanQty] = useState('');
  const [receive, setReceive] = useState<'배송' | '픽업'>('배송');
  const [zone, setZone] = useState<'직배송' | '당일배송' | '택배익일배송'>('직배송');
  const [orderType, setOrderType] = useState<'일반' | '선결제'>('일반');
  const [request, setRequest] = useState('');

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [addedCount, setAddedCount] = useState(0);
  const nameRef = useRef<HTMLInputElement>(null);

  // 날짜를 바꿔 보시면 넣을 조리일도 따라간다 (아직 아무것도 안 쳤을 때만)
  useEffect(() => { if (!babyName && !q) setDeliveryDate(date); }, [date, babyName, q]);

  // 이름 찾기 — 글자마다 부르지 않고 잠깐 멈추면 부른다
  useEffect(() => {
    const term = q.trim();
    if (term.length < 1) { setHits([]); return; }
    let alive = true;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const d = await fetch(`/api/admin/order-lookup?q=${encodeURIComponent(term)}`).then(r => r.json());
        if (alive && d.ok) setHits(d.hits || []);
      } catch { /* 찾기 실패는 조용히 — 직접 치시면 된다 */ }
      if (alive) setSearching(false);
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);

  function pick(h: Hit) {
    setPicked(h);
    setQ('');
    setHits([]);
    setBabyName(h.babyName);
    setMonths(h.guessMonths ? String(h.guessMonths) : '');
    setPhone(h.phone);
    setAddress(h.address + (h.addressDetail ? ' ' + h.addressDetail : ''));
    setDoorPassword(h.doorPassword || '');
    if (h.stage && (STAGES as string[]).includes(h.stage)) setStage(h.stage as StageType);
    if (h.volume) setVolume(String(h.volume));
    setReceive(h.receiveMethod === '픽업' ? '픽업' : '배송');
    if (h.deliveryMethod === '직배송' || h.deliveryMethod === '당일배송' || h.deliveryMethod === '택배익일배송') {
      setZone(h.deliveryMethod);
    } else {
      setZone(/강서구|양천구/.test(h.address) ? '직배송' : '당일배송');
    }
    setOrderType(h.orderType === '선결제' ? '선결제' : '일반');
  }

  const totalQty = isBanchan
    ? (Number(banchanQty) || 0)
    : MENU_TYPES.reduce((a, m) => a + (Number(menuQty[m]) || 0), 0);

  const hanwoo = Number(menuQty['한우']) || 0;
  const others = totalQty - hanwoo;
  const hanwooOdd = !isBanchan && hanwoo > 0 && hanwoo > others * HANWOO_MAX_RATIO;

  const missing: string[] = [];
  if (!deliveryDate) missing.push('조리일');
  if (!babyName.trim()) missing.push('아기 이름');
  if (!/^\d{10,11}$/.test(phone.replace(/\D/g, ''))) missing.push('연락처');
  if (!address.trim()) missing.push('주소');
  if (!(Number(months) > 0)) missing.push('개월수');
  if (!isBanchan && !stage) missing.push('단계');
  if (!isBanchan && !volume) missing.push('용량');
  if (totalQty < 1) missing.push('팩수');
  const canSave = missing.length === 0 && !busy;

  function clearForNext() {
    setPicked(null); setQ(''); setHits([]);
    setBabyName(''); setMonths(''); setPhone(''); setAddress(''); setDoorPassword('');
    setMenuQty({}); setBanchanQty(''); setRequest('');
    setOrderType('일반');
    // 조리일·단계·용량·받는방법·권역은 남긴다 — 같은 날 비슷한 줄이 이어진다
    setTimeout(() => nameRef.current?.focus(), 0);
  }

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const sets = isBanchan
        ? [{ stage: '반찬세트', volume: null, simple: true, menus: [], qty: totalQty }]
        : [{
            stage, volume: Number(volume), simple: false, qty: totalQty,
            menus: MENU_TYPES.filter(m => (Number(menuQty[m]) || 0) > 0)
              .map(m => ({ menu: m, qty: Number(menuQty[m]) })),
          }];

      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          admin_manual: true,
          baby_name: babyName.trim(),
          months: Number(months),
          customer_phone: phone.replace(/\D/g, ''),
          address: address.trim(),
          door_password: doorPassword.trim() || null,
          stage: isBanchan ? null : stage,
          volume: isBanchan ? null : Number(volume),
          delivery_date: deliveryDate,
          order_type: orderType,
          receive_method: receive,
          // 우편번호가 없으면 서버가 이 값으로 권역을 판정한다 (팩당 500원이 걸린다)
          delivery_method: receive === '픽업' ? '직배송' : zone,
          postal_code: picked?.postalCode || null,
          total_qty: totalQty,
          customer_request: request.trim() || null,
          items: [{ delivery_date: deliveryDate, sets, date_qty: totalQty }],
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) {
        setMsg({ ok: false, text: j.error || `넣지 못했어요 (${res.status})` });
      } else {
        setAddedCount(n => n + 1);
        setMsg({ ok: true, text: `${babyName} ${totalQty}팩 — 조리표에 들어갔어요` });
        clearForNext();
        onSaved();
      }
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || '네트워크 오류' });
    } finally {
      setBusy(false);
    }
  }

  const input = 'w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none';
  const label = 'block text-xs font-medium text-stone-500 mb-1';
  const volOptions = stage && STAGE_OPTIONS[stage as StageType]
    ? STAGE_OPTIONS[stage as StageType].map(o => o.volume)
    : VOL_ALL;

  return (
    <div className="bg-white rounded-xl border border-amber-200 overflow-hidden no-print mb-4">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-4 py-3 text-left">
        <span className="font-bold text-stone-900 text-sm">
          조리표에 줄 넣기
          {addedCount > 0 && <span className="ml-2 font-normal text-amber-700">{addedCount}줄 넣음</span>}
        </span>
        <span className="text-stone-400 text-xs">{open ? '접기' : '열기'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-stone-100 pt-3 space-y-4">
          <p className="text-xs text-stone-500 leading-relaxed">
            이름 두 글자만 치면 지난 주문에서 그 집을 찾아 연락처·주소·단계·용량까지 가져옵니다.
            저장하면 이름과 팩수만 비워지고 조리일·단계·용량은 남습니다.
          </p>

          {/* 손님 찾기 */}
          <div>
            <span className={label}>손님 찾기 (이름 또는 번호 끝자리)</span>
            <input ref={nameRef} value={q} onChange={e => setQ(e.target.value)}
              placeholder="예: 서은" className={input} />
            {searching && <p className="mt-1 text-xs text-stone-400">찾는 중…</p>}
            {hits.length > 0 && (
              <div className="mt-2 border border-stone-200 rounded-lg divide-y divide-stone-100 overflow-hidden">
                {hits.map(h => (
                  <button key={h.phone} onClick={() => pick(h)}
                    className="w-full text-left px-3 py-2 hover:bg-amber-50">
                    <div className="text-sm font-bold text-stone-900">
                      {h.babyName}
                      {h.orders >= 2 && <span className="ml-1.5 text-[11px] font-normal text-amber-700">{h.orders}번</span>}
                      {h.orderType === '선결제' && <span className="ml-1.5 text-[11px] font-normal text-sky-700">선결제</span>}
                    </div>
                    <div className="text-[11px] text-stone-400 truncate">
                      마지막 {h.lastDate} · {h.stage || '-'}{h.volume ? ` ${h.volume}g` : ''} · {h.address}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {picked && (
            <p className="text-[11px] text-stone-500 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2 leading-relaxed">
              {picked.lastDate} 주문 때 <b>{picked.lastMonths}개월</b>이라 적혀 있어서 지금 <b>{picked.guessMonths}개월</b>로 넣었습니다.
              달수만 더한 짐작이라 한 달 틀릴 수 있어요 — 아시면 고쳐주세요.
            </p>
          )}

          {/* 칸 */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <span className={label}>조리일</span>
              <input type="date" value={deliveryDate} onChange={e => setDeliveryDate(e.target.value)} className={input} />
            </div>
            <div>
              <span className={label}>아기 이름</span>
              <input value={babyName} onChange={e => setBabyName(e.target.value)} className={input} />
            </div>
            <div>
              <span className={label}>개월수</span>
              <input inputMode="numeric" value={months}
                onChange={e => setMonths(e.target.value.replace(/\D/g, ''))} className={input} />
            </div>
            <div className="col-span-2 sm:col-span-3">
              <span className={label}>주소</span>
              <input value={address} onChange={e => setAddress(e.target.value)} className={input} />
            </div>
            <div>
              <span className={label}>연락처</span>
              <input inputMode="numeric" value={phone}
                onChange={e => setPhone(e.target.value.replace(/\D/g, ''))} className={input} />
            </div>
            <div>
              <span className={label}>현관 비번</span>
              <input value={doorPassword} onChange={e => setDoorPassword(e.target.value)} className={input} />
            </div>
            <div>
              <span className={label}>받는 방법</span>
              <select value={receive} onChange={e => setReceive(e.target.value as any)} className={input}>
                <option value="배송">배송</option>
                <option value="픽업">픽업</option>
              </select>
            </div>
            {receive === '배송' && (
              <div>
                <span className={label}>배송 권역</span>
                <select value={zone} onChange={e => setZone(e.target.value as any)} className={input}>
                  <option value="직배송">직배송 (강서·양천)</option>
                  <option value="당일배송">당일배송 (그 외)</option>
                  <option value="택배익일배송">택배 익일배송</option>
                </select>
              </div>
            )}
            <div>
              <span className={label}>주문 유형</span>
              <select value={orderType} onChange={e => setOrderType(e.target.value as any)} className={input}>
                <option value="일반">일반 (입금 확인)</option>
                <option value="선결제">선결제 (잔여 차감)</option>
              </select>
            </div>
            <div className="col-span-2 sm:col-span-1">
              <span className={label}>요청사항</span>
              <input value={request} onChange={e => setRequest(e.target.value.slice(0, 60))}
                placeholder="보냉가방 등" className={input} />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-stone-700">
            <input type="checkbox" checked={isBanchan} onChange={e => setIsBanchan(e.target.checked)}
              className="h-4 w-4 accent-amber-500" />
            유아식(반찬) 주문
          </label>

          {!isBanchan ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className={label}>단계</span>
                  <select value={stage} onChange={e => { setStage(e.target.value as StageType); setVolume(''); }} className={input}>
                    <option value="">고르기</option>
                    {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <span className={label}>용량</span>
                  <select value={volume} onChange={e => setVolume(e.target.value)} className={input}>
                    <option value="">고르기</option>
                    {volOptions.map(v => <option key={v} value={v}>{v}g</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                {MENU_TYPES.map(m => (
                  <div key={m}>
                    <span className={label}>{menuLabel(m)}</span>
                    <input inputMode="numeric" value={menuQty[m] || ''}
                      onChange={e => setMenuQty(q2 => ({ ...q2, [m]: e.target.value.replace(/\D/g, '') }))}
                      className={input} />
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="w-32">
              <span className={label}>반찬 세트</span>
              <input inputMode="numeric" value={banchanQty}
                onChange={e => setBanchanQty(e.target.value.replace(/\D/g, ''))} className={input} />
            </div>
          )}

          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-semibold text-stone-700">합계 {totalQty}팩</p>
            {missing.length > 0 && (
              <p className="text-xs text-amber-700">{missing.join(', ')} 넣어주세요</p>
            )}
          </div>

          {hanwooOdd && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              한우 {hanwoo}팩 · 나머지 {others}팩 — 손님 주문에서는 막히는 비율입니다.
              사장님이 넣으시는 것이니 그대로 들어갑니다.
            </p>
          )}

          {msg && (
            <p className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'}`}>
              {msg.text}
            </p>
          )}

          <div className="flex gap-2">
            <button onClick={save} disabled={!canSave}
              className="flex-1 rounded-xl bg-amber-500 py-3 text-sm font-semibold text-white disabled:bg-stone-200 disabled:text-stone-400">
              {busy ? '넣는 중…' : '조리표에 넣기'}
            </button>
            <button onClick={clearForNext} disabled={busy}
              className="px-4 rounded-xl border border-stone-300 text-sm text-stone-600">
              비우기
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
