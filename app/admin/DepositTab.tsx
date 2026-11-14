'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import CookingTable, { type PayState } from './CookingTable';
import { buildCookingSheet } from '@/lib/cookingSheet';
import { isOpenworld } from '@/lib/openworld';
import { PREPAID_UNITS, prepaidPrice, type Customer } from '@/lib/supabase';

/*
  입금 대조 화면
    - 은행 거래내역(.xls)을 올리면 입금 줄이 쌓이고(같은 입금은 한 번만), 주문과 자동으로 맞춰본다.
    - 자동으로 맞춘 것도 근거와 함께 보이고, 사장님이 풀 수 있다. 입금 줄은 지우지 않는다.
    - 누군지 모르는 입금은 주문을 찾아 붙이고, 그때 입금자 이름(엄마·아빠)을 손님 카드에 저장해 두면
      다음부터는 그 이름으로 온 돈도 자동으로 찾는다.
*/

type Dep = {
  id: string; deposited_at: string; depositor: string; amount: number; bank_memo: string | null; source: string | null;
  status: '자동확인' | '수동확인' | '확인필요' | '모름' | '선결제' | '무관';
  order_ids: string[]; suggested_ids: string[]; customer_phone: string | null; note: string | null; confirmed_at: string | null;
};
type O = {
  id: string; baby_name: string; delivery_date: string; customer_phone: string; total_price: number; shipping_fee: number;
  total_qty: number; stage: string | null; volume: number | null; delivery_method: string | null;
  paid: boolean; paid_note: string | null; status: string; source?: string | null;
};

const STATUS_ORDER: Dep['status'][] = ['확인필요', '모름', '선결제', '자동확인', '수동확인', '무관'];
const STATUS_CLS: Record<Dep['status'], string> = {
  확인필요: 'bg-amber-100 text-amber-800 border-amber-200',
  모름: 'bg-rose-100 text-rose-700 border-rose-200',
  선결제: 'bg-violet-100 text-violet-700 border-violet-200',
  자동확인: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  수동확인: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  무관: 'bg-stone-100 text-stone-500 border-stone-200',
};
const STATUS_HELP: Record<Dep['status'], string> = {
  확인필요: '이름은 찾았는데 금액·날짜가 안 맞거나, 맞는 주문이 여러 개예요',
  모름: '누구 돈인지 못 찾았어요 — 엄마·아빠 이름일 수 있어요',
  선결제: '선결제 할인표 금액과 같아요 — 잔여 팩은 고객관리에서 넣어주세요',
  자동확인: '이름·날짜·금액이 딱 맞아 자동으로 입금확인했어요 — 근거를 보고 틀리면 풀어주세요',
  수동확인: '사장님이 확인한 입금',
  무관: '카드·플랫폼 정산 등 손님 입금이 아닌 돈',
};

const won = (n: number) => `${(n || 0).toLocaleString('ko-KR')}원`;
const kst = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString();
const when = (iso: string) => { const t = kst(iso); return `${Number(t.slice(5, 7))}/${Number(t.slice(8, 10))} ${t.slice(11, 16)}`; };
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const due = (o: O) => (o.total_price || 0) + (o.shipping_fee || 0);
const what = (o: O) => String(o.stage || '').startsWith('반찬') ? '반찬' : `${String(o.stage || '').replace('단계', '')} ${o.volume || ''}`.trim();

/*
  조리표로 입금 체크 (2026-11-14 사장님: "조리표대로 보여줘, 그게 확인이 쉬워. 조리표랑 똑같이 해서 체크만")
    맨 위 날짜(머리말)의 조리표를 그대로 그리고, 이름 칸 색으로 입금 상태를 보인다.
    이름을 누르면 입금확인을 켜고 끈다. 은행 입금 줄 목록은 그 아래에 접어 둔다.
*/
type SheetOrder = Parameters<typeof buildCookingSheet>[0][number] & {
  paid?: boolean; paid_note?: string | null; order_type?: string | null; total_price?: number; shipping_fee?: number;
  customer_id?: string | null;
};
const isPrepaidUse = (o: SheetOrder) => String(o.paid_note || '').startsWith('선결제 차감');
const payState = (o: SheetOrder): PayState =>
  isPrepaidUse(o) || o.order_type === '선결제' ? 'prepaid'
  : o.paid ? 'paid' : isOpenworld(o.paid_note) ? 'openworld' : o.paid_note ? 'skip' : 'unpaid';
const hasPrepaid = (c?: Customer) => !!c && (c.prepaid_balance !== 0 || (c.prepaid_banchan || 0) > 0);

// 주문의 단계·용량 → 선결제 할인표 이름 ('완료기 300g'). 중기1의 240/310 도 230/300 표를 쓴다.
function labelOf(o: SheetOrder): string | null {
  const st = String(o.stage || '');
  const kind = st.startsWith('중기') ? '중기' : st.startsWith('후기') ? '후기' : st.startsWith('완료') ? '완료기' : null;
  if (!kind) return null;
  return `${kind} ${Number(o.volume) >= 300 ? 300 : 230}g`;
}

type Patch = { order?: Partial<SheetOrder>; customer?: Partial<Customer>; customerId?: string };

function PaySheet({ orders, date, customers, onToggle, onPatch }: {
  orders: SheetOrder[]; date: string; customers: Customer[];
  onToggle: (o: SheetOrder) => void; onPatch: (orderId: string | null, p: Patch) => void;
}) {
  /* 이름을 누르면
       '입금 체크' 모드 — 선결제가 있는 손님(남은 팩·반찬 회수)은 선결제 판이 열리고, 나머지는 입금확인을 켜고 끈다(전과 같음)
       '선결제' 모드   — 누구든 선결제 판이 열린다. 선결제를 새로 시작하는 손님(충전)도 여기서
     2026-11-14 사장님: "체크 기능 살리면서 선결제 시작한 애들 있으면 그것도 거기서 바로 수정" */
  const [mode, setMode] = useState<'pay' | 'prepaid'>('pay');
  const [openId, setOpenId] = useState<string | null>(null);
  const sheet = buildCookingSheet(orders as any, date);
  const byId = new Map(orders.map(o => [o.id, o]));
  const custOf = (o: SheetOrder) =>
    customers.find(c => (o.customer_id && c.id === o.customer_id)) || customers.find(c => !!o.customer_phone && c.phone === o.customer_phone);
  const count: Record<PayState, number> = { paid: 0, unpaid: 0, openworld: 0, prepaid: 0, skip: 0 };
  let unpaidWon = 0;
  for (const o of orders) {
    const s = payState(o); count[s]++;
    if (s === 'unpaid') unpaidWon += (o.total_price || 0) + (o.shipping_fee || 0);
  }
  const dow = '일월화수목금토'[new Date(date + 'T00:00:00Z').getUTCDay()];
  const click = (o: SheetOrder) => {
    if (mode === 'prepaid' || hasPrepaid(custOf(o)) || isPrepaidUse(o) || o.order_type === '선결제') setOpenId(o.id);
    else onToggle(o);
  };
  const openOrder = openId ? byId.get(openId) : undefined;

  return (
    <div className="bg-white rounded-xl border border-stone-200 p-4 overflow-x-auto">
      <div className="flex items-baseline gap-x-3 gap-y-1 flex-wrap mb-2 text-[13px]">
        <span className="text-base font-black text-stone-900">입금 {Number(date.slice(5, 7))}/{Number(date.slice(8, 10))}({dow})</span>
        <span className="font-bold text-emerald-700">✓ 확인 {count.paid}</span>
        <span className="font-bold text-rose-700">미입금 {count.unpaid}{unpaidWon ? ` · ${won(unpaidWon)}` : ''}</span>
        {count.openworld > 0 && <span className="font-bold text-sky-800">오픈월드 {count.openworld}</span>}
        {count.prepaid > 0 && <span className="font-bold text-violet-700">선결제 {count.prepaid}</span>}
        {count.skip > 0 && <span className="text-stone-500">대조안함 {count.skip}</span>}
        <span className="ml-auto flex rounded-lg border border-stone-300 overflow-hidden text-[12px] font-bold">
          <button onClick={() => setMode('pay')} className={`px-3 py-1 ${mode === 'pay' ? 'bg-emerald-100 text-emerald-800' : 'text-stone-500'}`}>입금 체크</button>
          <button onClick={() => setMode('prepaid')} className={`px-3 py-1 border-l border-stone-300 ${mode === 'prepaid' ? 'bg-violet-100 text-violet-800' : 'text-stone-500'}`}>선결제</button>
        </span>
      </div>
      <p className="mb-2 text-[11px] text-stone-500 leading-relaxed">
        <span className="px-1 bg-emerald-200 rounded">초록 ✓</span> 입금확인 ·{' '}
        <span className="px-1 border border-stone-300 rounded text-rose-700">흰 칸 빨간 이름</span> 미입금 ·{' '}
        <span className="px-1 bg-violet-100 rounded">보라</span> 선결제에서 뺌 ·{' '}
        <span className="px-1 bg-sky-100 rounded">하늘</span> 오픈월드 ·{' '}
        <span className="px-1 bg-stone-100 rounded">회색</span> 엑셀 시절(대조 못 함).{' '}
        {mode === 'pay'
          ? <>이름을 누르면 입금확인이 켜지고 꺼집니다. <b>선결제가 남은 손님</b>은 선결제 판이 열립니다.</>
          : <><b>선결제 모드</b> — 누구든 이름을 누르면 선결제 판이 열립니다(충전·차감·남은 팩 고치기).</>}
        {' '}배송 칸 <b>내</b> = 다음 날 것과 합쳐 택배.
      </p>

      {openOrder && (
        <PrepaidPanel key={openOrder.id} o={openOrder} cust={custOf(openOrder)}
          onClose={() => setOpenId(null)} onToggle={() => { onToggle(openOrder); setOpenId(null); }}
          onPatch={p => onPatch(openOrder.id, p)} />
      )}

      {sheet.people === 0 && sheet.banchan.length === 0
        ? <p className="text-center text-stone-400 text-sm py-6">이 날짜에 주문이 없어요 — 맨 위에서 날짜를 바꿔 보세요</p>
        : <CookingTable sheet={sheet} pay={{ state: id => { const o = byId.get(id); return o ? payState(o) : 'skip'; }, onToggle: id => { const o = byId.get(id); if (o) click(o); } }} />}
    </div>
  );
}

function PrepaidPanel({ o, cust, onClose, onToggle, onPatch }: {
  o: SheetOrder; cust?: Customer; onClose: () => void; onToggle: () => void; onPatch: (p: Patch) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const stage = String(o.stage || '');
  const banchan = stage.startsWith('반찬');
  const unit = banchan ? '회' : '팩';
  const qty = Number(o.total_qty) || 0;
  const left = banchan ? (cust?.prepaid_banchan || 0) : (cust?.prepaid_balance || 0);
  const used = /^선결제 차감 \d+(팩|회) \(입금 탭/.test(String(o.paid_note || '')); // 이 화면에서 뺀 것
  const label = cust?.prepaid_label || labelOf(o);
  const [edit, setEdit] = useState(String(left));

  async function use(on: boolean) {
    if (!confirm(on
      ? `${o.baby_name} — 이 주문 ${qty}${unit}을 선결제에서 뺄까요?\n남은 ${left}${unit} → ${left - qty}${unit}`
      : `${o.baby_name} — 선결제에서 뺀 ${qty}${unit}을 돌려놓을까요?\n남은 ${left}${unit} → ${left + qty}${unit}, 주문은 미입금으로`)) return;
    setBusy(true); setInfo(null);
    const d = await fetch('/api/admin/order-prepaid', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: o.id, use: on }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e?.message }));
    setBusy(false);
    if (!d.ok) { setInfo(`못 했어요: ${d.error || ''}`); return; }
    onPatch({ order: { paid: d.paid, paid_note: d.paid_note }, customerId: d.customer_id, customer: { [d.field]: d.balance } as any });
    setEdit(String(d.balance));
    setInfo(on ? `선결제에서 뺐어요 — 남은 ${d.balance}${unit}` : `돌려놓았어요 — 남은 ${d.balance}${unit}`);
  }

  async function setLeft() {
    if (!cust) return;
    const n = Number(edit.trim() || 0);
    if (!Number.isInteger(n) || (banchan && n < 0)) { setInfo('숫자로 적어주세요'); return; }
    if (n === left) return;
    if (!confirm(`${o.baby_name} — 남은 ${left}${unit} → ${n}${unit}로 고칠까요?`)) { setEdit(String(left)); return; }
    setBusy(true); setInfo(null);
    const d = await fetch(`/api/customers/${cust.id}/prepaid`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(banchan ? { item: '반찬', set: n, memo: '입금 탭에서 고침' } : { set: n, memo: '입금 탭에서 고침' }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e?.message }));
    setBusy(false);
    if (!d.ok) { setInfo(`못 고쳤어요: ${d.error || ''}`); setEdit(String(left)); return; }
    onPatch({ customerId: cust.id, customer: banchan ? { prepaid_banchan: d.new_balance } : { prepaid_balance: d.new_balance } });
    setInfo(`남은 ${d.new_balance}${unit}로 고쳤어요`);
  }

  async function charge(units: number) {
    if (!cust) return;
    const wonAmt = prepaidPrice(label, units);
    if (!confirm(wonAmt ? `${o.baby_name} — ${label} ${units}팩 ${wonAmt.toLocaleString()}원 받으셨나요?` : `${o.baby_name} — ${units}팩을 넣을까요?`)) return;
    setBusy(true); setInfo(null);
    const d = await fetch(`/api/customers/${cust.id}/prepaid`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ units, amount_won: wonAmt || undefined, label: label || undefined }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e?.message }));
    setBusy(false);
    if (!d.ok) { setInfo(`못 넣었어요: ${d.error || ''}`); return; }
    onPatch({ customerId: cust.id, customer: { prepaid_balance: d.new_balance, ...(label ? { prepaid_label: label } : {}) } });
    setEdit(String(d.new_balance));
    setInfo(`${units}팩 넣었어요 — 남은 ${d.new_balance}팩. 이 주문도 빼시려면 '선결제에서 빼기'를 누르세요`);
  }

  const btn = 'px-2.5 py-1 rounded-lg border text-[12px] font-bold disabled:opacity-40';
  return (
    <div className="mb-3 border-2 border-violet-300 bg-violet-50/60 rounded-xl p-3 text-[12px] space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <b className="text-[14px] text-stone-900">{o.baby_name}</b>
        <span className="text-stone-600">{banchan ? (stage === '반찬낱개' ? `반찬 낱개 ${qty}개` : `반찬 ${qty}세트`) : `${stage.replace('단계', '')} ${o.volume || ''} ${qty}팩`} · {won((o.total_price || 0) + (o.shipping_fee || 0))}</span>
        <span className={`px-1.5 rounded ${used ? 'bg-violet-200 text-violet-900' : o.paid ? 'bg-emerald-200 text-emerald-900' : 'bg-white border border-stone-300 text-rose-700'}`}>
          {o.order_type === '선결제' ? '선결제 주문' : used ? '선결제에서 뺌' : o.paid ? '입금확인' : '미입금'}
        </span>
        <button onClick={onClose} className="ml-auto text-stone-500 text-[12px] underline">닫기</button>
      </div>
      {o.paid_note && <p className="text-[11px] text-stone-500">{o.paid_note}</p>}

      {!cust ? <p className="text-rose-700">손님 카드를 못 찾았어요 — 고객관리에서 이 손님을 먼저 찾아 주세요(카드가 연결돼야 선결제를 씁니다).</p> : (
        <>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-bold text-stone-700">남은 {banchan ? '반찬' : '선결제'}</span>
            <input value={edit} onChange={e => setEdit(e.target.value.replace(banchan ? /\D/g : /[^\d-]/g, ''))} disabled={busy}
              onBlur={setLeft} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} inputMode="numeric"
              className={`w-14 px-1.5 py-0.5 border rounded text-right text-[13px] font-black outline-none focus:border-violet-400 ${left < 0 ? 'text-red-600' : 'text-violet-800'} border-violet-300`} />
            <span>{unit}{!banchan && label ? <span className="ml-1 text-stone-400">{label}</span> : null}</span>
            <span className="text-[11px] text-stone-400">(고치고 Enter)</span>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {o.order_type === '선결제' ? (
              <span className="text-stone-500">주문할 때 이미 선결제로 빠진 주문이에요 — 바꾸려면 주문을 고쳐 주세요</span>
            ) : used ? (
              <button disabled={busy} onClick={() => use(false)} className={`${btn} border-stone-300 bg-white text-stone-700`}>선결제 되돌리기 (+{qty}{unit})</button>
            ) : stage === '반찬낱개' ? (
              <span className="text-stone-500">반찬 낱개는 선결제(세트 회수)로 뺄 수 없어요</span>
            ) : (
              <button disabled={busy || o.paid} onClick={() => use(true)} className={`${btn} border-violet-400 bg-violet-100 text-violet-900`}>
                선결제에서 빼기 (−{qty}{unit} → 남은 {left - qty})
              </button>
            )}
            {!used && o.order_type !== '선결제' && (
              <button disabled={busy} onClick={onToggle} className={`${btn} ${o.paid ? 'border-stone-300 bg-white text-stone-600' : 'border-emerald-300 bg-emerald-50 text-emerald-800'}`}>
                {o.paid ? '입금확인 끄기' : '입금확인 (돈으로 받음)'}
              </button>
            )}
          </div>
          {!banchan && (
            <div className="flex gap-1.5 flex-wrap items-center">
              <span className="text-stone-500">선결제 충전{label ? ` (${label})` : ''}</span>
              {PREPAID_UNITS.map(u => (
                <button key={u} disabled={busy} onClick={() => charge(u)} className={`${btn} border-amber-200 bg-white text-amber-800`}>
                  +{u}팩{prepaidPrice(label, u) ? <span className="ml-1 font-normal text-stone-500">{prepaidPrice(label, u)!.toLocaleString()}원</span> : null}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {info && <p className="text-[12px] text-violet-800 font-bold">{info}</p>}
    </div>
  );
}

export default function DepositTab({ dayOrders = [], date, customers = [], onTogglePaid, onPatch }: {
  dayOrders?: SheetOrder[]; date?: string; customers?: Customer[]; onTogglePaid?: (o: any) => void;
  onPatch?: (orderId: string | null, p: Patch) => void;
}) {
  const [showBank, setShowBank] = useState(false);
  const [deps, setDeps] = useState<Dep[] | null>(null);
  const [orders, setOrders] = useState<Record<string, O>>({});
  const [unpaid, setUnpaid] = useState<O[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState<Record<string, boolean>>({ 확인필요: true, 모름: true, 선결제: true, 자동확인: false, 수동확인: false, 무관: false });
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    setErr(null);
    try {
      const d = await fetch('/api/admin/deposits').then(r => r.json());
      if (!d.ok) { setErr(d.error || '불러오지 못했어요'); return; }
      setDeps(d.deposits);
      setOrders(Object.fromEntries((d.orders || []).map((o: O) => [o.id, o])));
      setUnpaid(d.unpaid || []);
    } catch (e: any) { setErr(e?.message || '불러오지 못했어요'); }
  }
  useEffect(() => { load(); }, []);

  async function upload(f: File) {
    setBusy(true); setMsg(null);
    const fd = new FormData(); fd.append('file', f);
    try {
      const d = await fetch('/api/admin/deposits', { method: 'POST', body: fd }).then(r => r.json());
      setMsg(d.ok ? `파일 입금 ${d.inFile}건 중 새로 ${d.added}건 · ${d.checked}건 맞춰봄 · 자동확인 ${d.auto}건` : `못 올렸어요: ${d.error}`);
      await load();
    } catch (e: any) { setMsg(`못 올렸어요: ${e?.message || '네트워크 오류'}`); }
    setBusy(false);
    if (fileRef.current) fileRef.current.value = '';
  }
  async function rematch() {
    setBusy(true); setMsg(null);
    const fd = new FormData(); fd.append('rematch', '1');
    const d = await fetch('/api/admin/deposits', { method: 'POST', body: fd }).then(r => r.json()).catch(() => ({ ok: false }));
    setMsg(d.ok ? `${d.checked}건 다시 맞춰봄 · 새로 자동확인 ${d.auto}건` : `실패: ${d.error || ''}`);
    await load(); setBusy(false);
  }

  // 입금이 없는 주문을 사장님이 직접 확인 — 카드결제·현금·선결제 차감 등. 근거 문구가 주문에 남는다.
  async function markPaid(o: O, note: string) {
    const d = await fetch(`/api/orders/${o.id}/paid`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paid: true, note }),
    }).then(r => r.json()).catch(() => ({ ok: false }));
    if (d.ok) setUnpaid(list => list.filter(x => x.id !== o.id));
    else setMsg(`못 바꿨어요: ${d.error || ''}`);
  }

  const groups = useMemo(() => {
    const g: Record<string, Dep[]> = {};
    for (const d of deps || []) (g[d.status] ||= []).push(d);
    return g;
  }, [deps]);

  function toggleFromSheet(o: SheetOrder) {
    if (!onTogglePaid) return;
    const s = payState(o);
    if (s === 'openworld' && !confirm(`${o.baby_name} — 오픈월드 주문이에요(나중에 한꺼번에 정산). 그래도 입금확인으로 바꿀까요?`)) return;
    if (s === 'prepaid' && !confirm(`${o.baby_name} — 선결제 주문이에요. 입금확인으로 표시할까요?`)) return;
    onTogglePaid(o);
  }
  const need = (groups['확인필요'] || []).length + (groups['모름'] || []).length;

  return (
    <div className="space-y-4">
      {date && <PaySheet orders={dayOrders} date={date} customers={customers} onToggle={toggleFromSheet}
        onPatch={(id, p) => onPatch?.(id, p)} />}

      <button onClick={() => setShowBank(v => !v)}
        className="w-full flex justify-between items-center px-4 py-3 bg-white rounded-xl border border-stone-200 text-sm font-bold text-stone-700">
        <span>은행 입금 줄 하나씩 보기{deps ? ` · 확인필요·모름 ${need}건` : ''}</span><span>{showBank ? '∧' : '∨'}</span>
      </button>

      {showBank && <>
      <div className="bg-white rounded-xl border border-stone-200 p-4">
        <div className="flex items-center gap-2 flex-wrap">
          <label className={`px-3 py-2 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 text-sm font-bold cursor-pointer ${busy ? 'opacity-40 pointer-events-none' : ''}`}>
            은행 거래내역 올리기 (.xls)
            <input ref={fileRef} type="file" accept=".xls,.xlsx" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }} />
          </label>
          <button onClick={rematch} disabled={busy}
            className="px-3 py-2 rounded-lg border border-stone-300 text-stone-700 text-sm font-bold disabled:opacity-40">다시 맞춰보기</button>
          {busy && <span className="text-xs text-stone-400">처리 중…</span>}
        </div>
        <p className="mt-2 text-[11px] text-stone-500 leading-relaxed">
          국민은행 '거래내역조회' 엑셀 파일을 그대로 올리시면 됩니다. 같은 입금은 몇 번 올려도 한 번만 들어가요.
          자동확인은 <b>이름·날짜·금액이 딱 맞을 때만</b> 해요. 나머지는 아래에서 골라 주세요.
        </p>
        {msg && <p className="mt-2 text-xs text-emerald-700">{msg}</p>}
        {deps && (
          <div className="mt-3 flex gap-1.5 flex-wrap">
            {STATUS_ORDER.map(s => (
              <button key={s} onClick={() => setShow(p => ({ ...p, [s]: !p[s] }))}
                className={`text-xs px-2.5 py-1 rounded-full border font-bold ${STATUS_CLS[s]} ${show[s] ? '' : 'opacity-50'}`}>
                {s} {(groups[s] || []).length}
              </button>
            ))}
          </div>
        )}
      </div>

      {err && <p className="text-sm text-red-600">불러오지 못했어요: {err} <button onClick={load} className="underline">다시</button></p>}
      {!deps && !err && <p className="text-sm text-stone-400">불러오는 중…</p>}
      {deps && deps.length === 0 && <p className="text-sm text-stone-400">아직 올린 입금내역이 없어요</p>}

      {deps && STATUS_ORDER.filter(s => show[s] && (groups[s] || []).length).map(s => (
        <section key={s}>
          <h3 className="text-sm font-bold text-stone-700 mb-1">{s} <span className="font-normal text-stone-400">{(groups[s] || []).length}건 · {won((groups[s] || []).reduce((a, d) => a + d.amount, 0))}</span></h3>
          <p className="text-[11px] text-stone-400 mb-2">{STATUS_HELP[s]}</p>
          <div className="space-y-2">
            {(groups[s] || []).map(d => <DepositRow key={d.id} d={d} orders={orders} onDone={load} />)}
          </div>
        </section>
      ))}

      {deps && deps.length > 0 && (
        <section>
          <h3 className="text-sm font-bold text-stone-700 mb-1">입금을 못 찾은 주문 <span className="font-normal text-stone-400">{unpaid.length}건</span></h3>
          <p className="text-[11px] text-stone-400 mb-2">입금내역 기간 안의 주문인데 짝이 되는 입금이 없어요. 선결제 손님이거나, 이름을 다르게 보냈거나, 아직 안 보냈을 수 있어요.</p>
          {unpaid.length === 0 ? <p className="text-xs text-stone-400">없어요</p> : (
            <div className="bg-white rounded-xl border border-stone-200 divide-y divide-stone-100">
              {unpaid.map(o => (
                <div key={o.id} className="px-3 py-1.5 text-xs flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="w-10 font-bold text-stone-700">{md(o.delivery_date)}</span>
                  <span className="font-bold text-stone-900 w-20 truncate">{o.baby_name}</span>
                  <span className="text-stone-500 flex-1 min-w-0 truncate">{what(o)} {o.total_qty}{String(o.stage || '').startsWith('반찬') ? '세트' : '팩'}{o.delivery_method && o.delivery_method !== '직배송' ? ' · 택배' : ''}</span>
                  <span className="font-bold text-stone-700 whitespace-nowrap">{won(due(o))}</span>
                  <span className="flex gap-1.5 ml-auto">
                    <button onClick={() => markPaid(o, '선결제 차감')} className="px-2 py-0.5 rounded border border-violet-200 text-violet-700 whitespace-nowrap">선결제분</button>
                    <button onClick={() => markPaid(o, '')} className="px-2 py-0.5 rounded border border-emerald-300 text-emerald-800 font-bold whitespace-nowrap">직접 확인</button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      </>}
    </div>
  );
}

function DepositRow({ d, orders, onDone }: { d: Dep; orders: Record<string, O>; onDone: () => void }) {
  const linked = d.order_ids.map(id => orders[id]).filter(Boolean);
  const sugg = d.suggested_ids.map(id => orders[id]).filter(Boolean);
  const [open, setOpen] = useState(false);
  // '아마 이 주문' 은 합계가 입금액과 딱 맞을 때만 미리 체크해 둔다 — 안 맞는데 체크돼 있으면 그대로 누르기 쉽다
  const [picked, setPicked] = useState<Record<string, O>>(() => {
    const open = (d.status === '확인필요' ? sugg : []).filter(o => !o.paid);
    return open.reduce((a, o) => a + due(o), 0) === d.amount ? Object.fromEntries(open.map(o => [o.id, o])) : {};
  });
  const [q, setQ] = useState('');
  const [found, setFound] = useState<O[]>([]);
  const [savePayer, setSavePayer] = useState(true);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [editMemo, setEditMemo] = useState(false);
  const [memo, setMemo] = useState('');
  const depDay = kst(d.deposited_at).slice(0, 10);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      const r = await fetch(`/api/admin/deposits/search?date=${depDay}&q=${encodeURIComponent(q.trim())}`).then(r => r.json()).catch(() => ({}));
      setFound(r.orders || []);
    }, 250);
    return () => clearTimeout(t);
  }, [q, open, depDay]);

  const sum = Object.values(picked).reduce((a, o) => a + due(o), 0);
  async function act(body: any) {
    setBusy(true); setInfo(null);
    try {
      let r = await fetch(`/api/admin/deposits/${d.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      let j = await r.json().catch(() => ({}));
      if (!j.ok && j.need_force && confirm(`${j.error}\n\n그래도 이 입금으로 바꿀까요?`)) {
        r = await fetch(`/api/admin/deposits/${d.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, force: true }) });
        j = await r.json().catch(() => ({}));
      }
      if (j.ok) { onDone(); return; }
      setInfo(j.error || `실패 (${r.status})`);
    } catch (e: any) { setInfo(e?.message || '네트워크 오류'); }
    setBusy(false);
  }
  const toggle = (o: O) => setPicked(p => { const n = { ...p }; if (n[o.id]) delete n[o.id]; else n[o.id] = o; return n; });

  const orderLine = (o: O, kind: 'linked' | 'pick') => (
    <label key={o.id} className={`flex items-center gap-2 text-xs px-2 py-1 rounded ${kind === 'linked' ? 'bg-emerald-50' : picked[o.id] ? 'bg-amber-50' : ''}`}>
      {kind === 'pick' && <input type="checkbox" checked={!!picked[o.id]} onChange={() => toggle(o)} />}
      <span className="w-10 font-bold">{md(o.delivery_date)}</span>
      <span className="font-bold text-stone-900 w-20 truncate">{o.baby_name}</span>
      <span className="text-stone-500 flex-1 truncate">{what(o)} {o.total_qty}{String(o.stage || '').startsWith('반찬') ? '세트' : '팩'}{o.delivery_method && o.delivery_method !== '직배송' ? ' · 택배' : ''} · …{String(o.customer_phone || '').slice(-4) || '번호없음'}</span>
      <span className="font-bold">{won(due(o))}</span>
      {kind === 'pick' && o.paid && <span className="text-[10px] text-emerald-700">이미 확인됨</span>}
    </label>
  );

  const canPick = d.status !== '자동확인' && d.status !== '수동확인';
  return (
    <div className="bg-white rounded-xl border border-stone-200 p-3">
      <div className="flex items-start gap-2">
        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-bold shrink-0 ${STATUS_CLS[d.status]}`}>{d.status}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm">
            <span className="font-bold text-stone-900">{d.depositor}</span>
            <span className="ml-2 font-bold text-amber-700">{won(d.amount)}</span>
            <span className="ml-2 text-xs text-stone-400">{when(d.deposited_at)}</span>
          </div>
          {d.note && <p className="text-[11px] text-stone-500 mt-0.5 leading-relaxed">{d.note}</p>}
        </div>
      </div>

      {linked.length > 0 && <div className="mt-2 space-y-0.5">{linked.map(o => orderLine(o, 'linked'))}</div>}

      <div className="mt-2 flex gap-1.5 flex-wrap">
        {/* 자동확인·직접확인한 것도 나중에 다른 아기 주문으로 바꿀 수 있다 — 아기 이름과 다른 집 엄마 이름이 같은 경우가 있다 */}
        <button onClick={() => setOpen(v => !v)} className="text-[11px] px-2.5 py-1 rounded border border-amber-300 bg-amber-50 text-amber-800 font-bold">{open ? '닫기' : canPick ? '주문 골라 붙이기' : '다른 주문으로 바꾸기'}</button>
        {linked.length > 0 && <button disabled={busy} onClick={() => confirm('이 입금 짝을 풀까요? 주문은 미입금으로 돌아가요') && act({ action: 'unlink' })} className="text-[11px] px-2.5 py-1 rounded border border-stone-300 text-stone-600 font-bold">짝 풀기</button>}
        {d.status !== '무관' && <button disabled={busy} onClick={() => act({ action: 'status', status: '무관' })} className="text-[11px] px-2.5 py-1 rounded border border-stone-200 text-stone-500">손님 돈 아님</button>}
        {d.status !== '선결제' && d.status !== '자동확인' && d.status !== '수동확인' && <button disabled={busy} onClick={() => act({ action: 'status', status: '선결제' })} className="text-[11px] px-2.5 py-1 rounded border border-violet-200 text-violet-700">선결제로 표시</button>}
        {(d.status === '무관' || d.status === '선결제') && d.confirmed_at && <button disabled={busy} onClick={() => act({ action: 'status', status: '모름' })} className="text-[11px] px-2.5 py-1 rounded border border-stone-200 text-stone-500">되돌리기</button>}
        {d.status !== '확인필요' && <button disabled={busy} onClick={() => (linked.length === 0 || confirm('확인필요로 돌리면 붙은 주문이 미입금으로 돌아가요. 할까요?')) && act({ action: 'status', status: '확인필요' })} className="text-[11px] px-2.5 py-1 rounded border border-amber-200 text-amber-700">나중에 볼게요</button>}
        <button onClick={() => { setEditMemo(v => !v); setMemo(d.note || ''); }} className="text-[11px] px-2.5 py-1 rounded border border-stone-200 text-stone-600">메모 고치기</button>
      </div>
      {editMemo && (
        <div className="mt-2 flex gap-1.5">
          <input value={memo} onChange={e => setMemo(e.target.value)} maxLength={300} placeholder="예: 이단우 엄마, 11/9분+11/12분 합친 돈"
            className="flex-1 px-2 py-1.5 border border-stone-300 rounded text-xs outline-none focus:border-amber-400" />
          <button disabled={busy} onClick={() => act({ action: 'memo', note: memo })}
            className="text-[11px] px-3 py-1 rounded border border-emerald-300 bg-emerald-50 text-emerald-800 font-bold disabled:opacity-40">저장</button>
        </div>
      )}

      {((canPick && sugg.length > 0) || open) && (
        <div className="mt-2 border-t border-stone-100 pt-2 space-y-1">
          {sugg.length > 0 && <p className="text-[11px] text-stone-500">아마 이 주문</p>}
          {sugg.map(o => orderLine(o, 'pick'))}
          {open && (
            <>
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="아기 이름 또는 저장된 입금자 이름으로 찾기 (입금일 앞뒤 3주)"
                className="w-full mt-1 px-2 py-1.5 border border-stone-300 rounded text-xs outline-none focus:border-amber-400" />
              <div className="max-h-56 overflow-auto">
                {found.filter(o => !d.suggested_ids.includes(o.id)).map(o => orderLine(o, 'pick'))}
                {q.trim() && found.length === 0 && <p className="text-[11px] text-stone-400 px-2">그런 주문이 없어요</p>}
              </div>
            </>
          )}
          {Object.keys(picked).length > 0 && (
            <div className="mt-1 flex items-center gap-2 flex-wrap bg-stone-50 rounded px-2 py-1.5">
              <span className={`text-xs font-bold ${sum === d.amount ? 'text-emerald-700' : 'text-rose-600'}`}>
                고른 주문 {won(sum)} / 입금 {won(d.amount)}{sum !== d.amount ? ` (차이 ${won(d.amount - sum)})` : ' — 딱 맞아요'}
              </span>
              <label className="text-[11px] text-stone-600 flex items-center gap-1">
                <input type="checkbox" checked={savePayer} onChange={e => setSavePayer(e.target.checked)} />
                입금자 이름을 손님 카드에 저장(엄마·아빠 이름일 때)
              </label>
              <button disabled={busy} onClick={() => act({ action: 'confirm', order_ids: Object.keys(picked), save_payer: savePayer })}
                className="ml-auto text-[11px] px-3 py-1 rounded border border-emerald-300 bg-emerald-50 text-emerald-800 font-bold disabled:opacity-40">
                이 주문 돈으로 확인
              </button>
            </div>
          )}
        </div>
      )}
      {info && <p className="mt-1 text-[11px] text-rose-600">{info}</p>}
    </div>
  );
}
