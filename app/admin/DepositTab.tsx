'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import CookingTable, { type PayState } from './CookingTable';
import { buildCookingSheet, banchanRegularMatcher } from '@/lib/cookingSheet';
import { isOpenworld } from '@/lib/openworld';
import { prepaidPrice, type Customer } from '@/lib/supabase';
import ChargeBar from './ChargeBar';
import { kindOf, isSplit, partsOf, balanceFor, shortKind, orderKinds, partBalance, convertNeed } from '@/lib/prepaidSplit';
import { AddMissing, LaterInfo } from './InlineAdd';

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
const hasPrepaid = (c?: Customer) => !!c && (c.prepaid_balance !== 0 || (c.prepaid_banchan || 0) > 0 || isSplit(c));

// 주문의 단계·용량 → 선결제 할인표 이름 ('완료기 300g'). 중기1의 240/310 도 230/300 표를 쓴다.
function labelOf(o: SheetOrder): string | null {
  const st = String(o.stage || '');
  const kind = st.startsWith('중기') ? '중기' : st.startsWith('후기') ? '후기' : st.startsWith('완료') ? '완료기' : null;
  if (!kind) return null;
  return `${kind} ${Number(o.volume) >= 300 ? 300 : 230}g`;
}

type Patch = { order?: Partial<SheetOrder>; customer?: Partial<Customer>; customerId?: string };

function PaySheet({ orders, date, customers, onToggle, onPatch, onAdded }: {
  orders: SheetOrder[]; date: string; customers: Customer[];
  onToggle: (o: SheetOrder) => void; onPatch: (orderId: string | null, p: Patch) => void;
  onAdded?: (row: any) => void;
}) {
  /* 이름을 누르면
       '입금 체크' 모드 — 선결제가 있는 손님(남은 팩·반찬 회수)은 선결제 판이 열리고, 나머지는 입금확인을 켜고 끈다(전과 같음)
       '선결제' 모드   — 누구든 선결제 판이 열린다. 선결제를 새로 시작하는 손님(충전)도 여기서
     2026-11-14 사장님: "체크 기능 살리면서 선결제 시작한 애들 있으면 그것도 거기서 바로 수정" */
  // 'panel' = 미입금·선결제 손님은 판이 열린다(기본) / 'quick' = 누구든 누르면 바로 입금확인 켜고 끄기
  // 2026-11-14 사장님: 미입금 아이도 새로 선결제를 시작했으면 강이한처럼 판에서 넣을 수 있게
  // 2026-11-14 사장님: "회색일 때 한 번 누르면 체크, 다시 풀고 또 누르면 입력창 — 둘 다 원클릭으로"
  // → 모드 전환 없앰. 이름 = 바로 입금확인 켜고 끄기, 이름 칸 오른쪽 끝 ▸ = 판 열기
  const [openId, setOpenId] = useState<string | null>(null);
  const byId = new Map(orders.map(o => [o.id, o]));
  // 조리표를 뽑은 시각 — 그 뒤에 들어온 아이는 조리표처럼 단계 맨 아래('추가')에
  const [printedAt, setPrintedAt] = useState<string | null>(null);
  useEffect(() => {
    let alive = true; setPrintedAt(null);
    fetch(`/api/admin/cooking-print?date=${date}`).then(r => r.json())
      .then(d => { if (alive && d.ok && d.printed) setPrintedAt(d.printedAt || null); }).catch(() => { /* 못 읽어도 표는 나온다 */ });
    return () => { alive = false; };
  }, [date]);
  const sheet = buildCookingSheet(orders as any, date, printedAt, { isBanchanRegular: banchanRegularMatcher(customers) });
  /* 오픈월드는 블록마다 아래쪽으로 (사장님: 엑셀에서도 월·목 표 아래에 따로 적었다).
     한 단계가 20명 넘어 여러 칸으로 나뉘면 단계 전체를 한 줄로 이어 정렬한 뒤 원래 칸 크기대로 다시 나눈다
     — 그래야 오픈월드가 칸마다 흩어지지 않고 그 단계 맨 끝에 모인다. 조리표 탭 순서는 그대로다. */
  {
    // 순서: 보통 → 오픈월드 → 나중에 넣은 아이('추가', 사장님: "추가한 아이들은 맨 아래")
    const ow = (id: string) => isOpenworld(byId.get(id)?.paid_note) ? 1 : 0;
    const rank = (p: { orderId: string; isNew?: boolean }) => (p.isNew ? 2 : ow(p.orderId));
    for (const stage of new Set(sheet.sections.map(s => s.stage))) {
      const parts = sheet.sections.filter(s => s.stage === stage);
      const all = parts.flatMap(s => s.list).map((p, i) => ({ p, i }))
        .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map(x => x.p);
      let k = 0;
      for (const s of parts) { const n = s.list.length; s.list = all.slice(k, k + n); k += n; }
    }
    sheet.banchan = sheet.banchan.map((b, i) => ({ b, i }))
      .sort((x, y) => rank(x.b) - rank(y.b) || x.i - y.i).map(x => x.b);
  }
  const custOf = (o: SheetOrder) =>
    customers.find(c => (o.customer_id && c.id === o.customer_id)) || customers.find(c => !!o.customer_phone && c.phone === o.customer_phone);
  // 후불 손님(postpaid)의 안 받은 주문은 빨간 미입금이 아니라 주황 '후불' — 나중에 한꺼번에 받는다
  const stateOf = (o: SheetOrder): PayState => { const s = payState(o); return s === 'unpaid' && custOf(o)?.postpaid ? 'postpaid' : s; };
  const count: Record<PayState, number> = { paid: 0, unpaid: 0, openworld: 0, prepaid: 0, skip: 0, postpaid: 0 };
  let unpaidWon = 0;
  for (const o of orders) {
    const s = stateOf(o); count[s]++;
    if (s === 'unpaid') unpaidWon += (o.total_price || 0) + (o.shipping_fee || 0);
  }
  const dow = '일월화수목금토'[new Date(date + 'T00:00:00Z').getUTCDay()];
  const openOrder = openId ? byId.get(openId) : undefined;

  return (
    <div className="bg-white rounded-xl border border-stone-200 p-4 overflow-x-auto">
      <div className="flex items-baseline gap-x-3 gap-y-1 flex-wrap mb-2 text-[13px]">
        <span className="text-base font-black text-stone-900">입금 {Number(date.slice(5, 7))}/{Number(date.slice(8, 10))}({dow})</span>
        <span className="font-bold text-emerald-700">✓ 확인 {count.paid}</span>
        <span className="font-bold text-rose-700">미입금 {count.unpaid}{unpaidWon ? ` · ${won(unpaidWon)}` : ''}</span>
        {count.openworld > 0 && <span className="font-bold text-sky-800">오픈월드 {count.openworld}</span>}
        {count.postpaid > 0 && <span className="font-bold text-orange-700">후불 {count.postpaid}</span>}
        {count.prepaid > 0 && <span className="font-bold text-violet-700">선결제 {count.prepaid}</span>}
        {count.skip > 0 && <span className="text-stone-500">대조안함 {count.skip}</span>}
      </div>
      <p className="mb-2 text-[11px] text-stone-500 leading-relaxed">
        <span className="px-1 bg-emerald-200 rounded">초록 ✓</span> 입금확인 ·{' '}
        <span className="px-1 border border-stone-300 rounded text-rose-700">흰 칸 빨간 이름</span> 미입금 ·{' '}
        <span className="px-1 bg-violet-100 rounded">보라</span> 선결제에서 뺌 ·{' '}
        <span className="px-1 bg-sky-100 rounded">하늘</span> 오픈월드 ·{' '}
        <span className="px-1 bg-stone-100 rounded">회색</span> 엑셀 시절(대조 못 함).{' '}
<b>이름</b>을 누르면 입금확인이 바로 켜지고 꺼집니다. 이름 칸 <b>오른쪽 끝 ▸</b>를 누르면 판이 열립니다 — 선결제 충전·빼기, 남은 팩, 택배비, 정보 넣기.
        {' '}배송 칸 <b>내</b> = 다음 날 것과 합쳐 택배.
      </p>

      {openOrder && (
        <PrepaidPanel key={openOrder.id} o={openOrder} cust={custOf(openOrder)}
          onClose={() => setOpenId(null)} onToggle={() => { onToggle(openOrder); setOpenId(null); }}
          onPatch={p => onPatch(openOrder.id, p)} onPatchOrder={(id, p) => onPatch(id, p)} />
      )}

      {sheet.people === 0 && sheet.banchan.length === 0
        ? <p className="text-center text-stone-400 text-sm py-6">이 날짜에 주문이 없어요 — 맨 위에서 날짜를 바꿔 보세요</p>
        : <CookingTable sheet={sheet} pay={{
            state: id => { const o = byId.get(id); return o ? stateOf(o) : 'skip'; },
            onToggle: id => { const o = byId.get(id); if (o) onToggle(o); },
            onOpen: id => setOpenId(id),
            // 선결제가 마이너스 = 더 먹은 만큼 입금 요청할 손님 (사장님 2026-11-14)
            // 여러 단계 선결제 손님은 이 주문 단계·용량의 묶음 잔액으로 본다
            tag: id => {
              const o = byId.get(id); if (!o) return null;
              const c = custOf(o); if (!c) return null;
              // 230g·300g 섞인 주문은 묶음 중 가장 모자란 쪽
              const b = Math.min(...orderKinds(o as any).map(k => balanceFor(c, k.kind)));
              if (String(o.stage || '').startsWith('반찬')) return null;
              // (완료기 '전환' 꼬리표는 사장님 요청으로 뺐다 2026-11-14 — 단계 변경은 ▸ 판의 노란 상자에서)
              return b < 0 ? `${b}` : null;
            },
          }} printedAt={printedAt} add={onAdded ? { date, onAdded } : undefined} />}
      {onAdded && <AddMissing sheet={sheet} date={date} onAdded={onAdded} />}
    </div>
  );
}

/* 후불 — 받을 돈 (2026-11-14 사장님: "고우리는 특이하게 후불로 하고 있어")
   후불 손님마다 아직 안 받은 주문 날짜·금액과 합계. 돈을 받으면 [정산] → 그 주문들을 한꺼번에 입금확인.
   손님 카드 '후불' 은 고객관리에서 켜고 끈다. */
type PostpaidRow = { id: string; baby_name: string; total: number; orders: { id: string; date: string; qty: number; won: number; excel: boolean }[] };
function PostpaidBox({ onSettled }: { onSettled: (ids: string[], note: string) => void }) {
  const [list, setList] = useState<PostpaidRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => fetch('/api/admin/postpaid').then(r => r.json()).then(d => { if (d.ok) setList(d.list); }).catch(() => { /* 못 읽으면 상자를 안 보인다 */ });
  useEffect(() => { load(); }, []);
  if (!list || !list.length) return null;
  async function settle(c: PostpaidRow) {
    if (!confirm(`${c.baby_name} — 후불 ${c.orders.length}건 ${c.total.toLocaleString()}원을 받으셨나요?\n${c.orders.map(o => `${md(o.date)} ${o.qty}팩 ${o.won.toLocaleString()}원`).join('\n')}\n\n전부 입금확인으로 바꿉니다.`)) return;
    setBusy(c.id); setMsg(null);
    const d = await fetch('/api/admin/postpaid', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_id: c.id, order_ids: c.orders.map(o => o.id) }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e?.message }));
    setBusy(null);
    if (!d.ok) { setMsg(`못 했어요: ${d.error || ''}`); return; }
    onSettled(d.ids || [], d.paid_note);
    setMsg(`${c.baby_name} — ${d.total.toLocaleString()}원 정산했어요`);
    load();
  }
  return (
    <div className="bg-orange-50 border border-orange-200 rounded-xl px-4 py-3">
      <p className="text-[13px] font-black text-orange-800">후불 — 받을 돈</p>
      <div className="mt-1.5 space-y-1.5">
        {list.map(c => (
          <div key={c.id} className="flex items-center gap-2 flex-wrap text-[12px]">
            <b className="text-stone-900">{c.baby_name}</b>
            {c.orders.length === 0 ? <span className="text-stone-400">받을 돈 없음</span> : <>
              <b className="text-orange-700">{c.orders.length}건 {c.total.toLocaleString()}원</b>
              <span className="text-[11px] text-stone-500">
                {c.orders.map(o => `${md(o.date)} ${o.won.toLocaleString()}${o.excel ? '(엑셀)' : ''}`).join(' · ')}
              </span>
              <button disabled={busy === c.id} onClick={() => settle(c)}
                className="ml-auto px-3 py-1 rounded-lg border border-orange-300 bg-white text-orange-800 font-bold disabled:opacity-40">정산 (받았어요)</button>
            </>}
          </div>
        ))}
      </div>
      {msg && <p className="mt-1 text-[12px] font-bold text-orange-800">{msg}</p>}
      <p className="mt-1 text-[11px] text-stone-500">표에서는 주황 이름이 후불 주문이에요. 일부만 받았으면 그 날짜 이름을 눌러 하나씩 입금확인하세요. (엑셀) = 앱 이전 주문이라 이미 받으셨을 수도 있어요.</p>
    </div>
  );
}

/* 단계 변경 — 중기·후기 선결제를 완료기로 (차액 팩당 500원). 사장님 2026-11-14 안시은:
   "완료기로 바꾸고 싶으면 차액 추가 입금하면 해 줘. 표기가 필요하고 입금 받았는지 확인, 입금했다면 진행"
   차액과 같은 금액의 은행 입금이 있으면 골라서 바로, 현금 등은 '따로 받았어요'. 서버: app/api/admin/prepaid-convert */
const kstDay = (iso: string) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10);
function ConvertBox({ cust, to, onDone }: { cust: Customer; to: string; onDone: (c: any, msg: string) => void }) {
  const [p, setP] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [units, setUnits] = useState('');
  useEffect(() => {
    let alive = true;
    fetch('/api/admin/prepaid-convert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: cust.id, to }) })
      .then(r => r.json()).then(d => { if (alive) { setP(d); if (d.units) setUnits(String(d.units)); } }).catch(() => { /* 못 읽으면 상자를 안 보인다 */ });
    return () => { alive = false; };
  }, [cust.id, cust.prepaid_balance, to]);
  if (!p?.ok || !p.need) return null;
  const n = Number(units) || 0;
  const won = n * p.per;
  const sameWon = won === p.won;
  async function apply(dep?: { id: string; depositor: string; deposited_at: string }) {
    if (n < p.need.fromBalance) { setErr(`남은 ${p.need.fromBalance}팩보다 적게는 못 바꿔요`); return; }
    if (!confirm(`${cust.baby_name} — ${p.need.from} ${p.need.fromBalance}팩을 ${p.need.to}로 바꿀까요?\n차액 ${won.toLocaleString()}원 (${n}팩×${p.per}원) — ${dep ? `입금 ${dep.depositor} ${md(kstDay(dep.deposited_at))}` : '따로 받음'}`)) return;
    setBusy(true); setErr(null);
    const d = await fetch('/api/admin/prepaid-convert', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_id: cust.id, to, apply: true, units: n, expect_from: p.need.fromBalance, ...(dep ? { deposit_id: dep.id } : { cash: true }) }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e?.message }));
    setBusy(false);
    if (!d.ok) { setErr(`못 바꿨어요: ${d.error || ''}`); return; }
    onDone(d.customer, `${p.need.to}로 바꿨어요 — 차액 ${d.won.toLocaleString()}원 (${d.how})`);
  }
  const btn = 'px-2.5 py-1 rounded-lg border text-[12px] font-bold disabled:opacity-40';
  return (
    <div className="border-2 border-amber-300 bg-amber-50 rounded-lg p-2 space-y-1.5">
      <p className="text-[12px] text-amber-900">
        <b>단계 변경 필요</b> — 선결제는 <b>{p.need.from} {p.need.fromBalance}팩</b>인데 이 주문은 <b>{p.need.to}</b>예요. 바꾸기 전까지는 중기·후기 묶음에서 같이 빠집니다.
      </p>
      <div className="flex items-center gap-1.5 flex-wrap text-[12px]">
        <span>바꿀 팩</span>
        <input value={units} onChange={e => setUnits(e.target.value.replace(/\D/g, ''))} disabled={busy} inputMode="numeric"
          className="w-12 px-1.5 py-0.5 border border-amber-300 rounded text-right font-black text-amber-900 outline-none" />
        <span className="text-stone-500">(남은 {p.need.fromBalance}{p.usedTo ? ` + 이미 먹은 완료기 ${p.usedTo}` : ''})</span>
        <span>× {p.per}원 = <b className="text-amber-900">{won.toLocaleString()}원</b> 차액</span>
      </div>
      {sameWon && p.deposits?.length > 0 ? (
        <div className="space-y-1">
          {p.deposits.map((d: any) => (
            <div key={d.id} className="flex items-center gap-2 text-[12px]">
              <span className={d.match ? 'font-bold text-emerald-800' : 'text-stone-500'}>{md(kstDay(String(d.deposited_at)))} {d.depositor} {Number(d.amount).toLocaleString()}원{d.match ? ' (이름 맞음)' : ''}</span>
              <button disabled={busy} onClick={() => apply(d)} className={`${btn} ml-auto border-emerald-400 bg-emerald-100 text-emerald-900`}>이 입금으로 확인하고 바꾸기</button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[12px] font-bold text-rose-700">아직 {won.toLocaleString()}원 입금이 안 보여요 — 차액 입금 요청을 보내 주세요. (은행 파일을 올리면 여기 뜹니다)</p>
      )}
      <button disabled={busy} onClick={() => apply()} className={`${btn} border-amber-300 bg-white text-amber-900`}>따로 받았어요(현금 등) — 바꾸기</button>
      {err && <p className="text-[12px] font-bold text-rose-700">{err}</p>}
    </div>
  );
}

type CascadeLine ={ id: string; date: string; qty: number; action: '뺌' | '이미 뺌' | '건너뜀'; why?: string; after: number };

function PrepaidPanel({ o, cust: custProp, onClose, onToggle, onPatch, onPatchOrder }: {
  o: SheetOrder; cust?: Customer; onClose: () => void; onToggle: () => void; onPatch: (p: Patch) => void;
  onPatchOrder: (orderId: string, p: Patch) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  // 입금 탭은 선결제·정기·오픈월드 손님만 들고 있다 — 목록에 없으면 이 손님 카드를 직접 불러온다
  const [loaded, setLoaded] = useState<Customer | null | undefined>(undefined);
  useEffect(() => {
    if (custProp) return;
    const q = o.customer_id ? `id=${o.customer_id}` : o.customer_phone ? `phone=${encodeURIComponent(o.customer_phone)}` : '';
    if (!q) { setLoaded(null); return; }
    fetch(`/api/customers?${q}`).then(r => r.json()).then(d => setLoaded(d.customer || null)).catch(() => setLoaded(null));
  }, [custProp, o.customer_id, o.customer_phone]);
  const cust = custProp || loaded || undefined;
  const patch = (p: Patch) => {
    onPatch(p);
    if (loaded && p.customer && p.customerId === loaded.id) setLoaded({ ...loaded, ...p.customer });
  };
  const stage = String(o.stage || '');
  const banchan = stage.startsWith('반찬');
  const unit = banchan ? '회' : '팩';
  const qty = Number(o.total_qty) || 0;
  // 여러 단계 선결제 손님은 이 주문 단계·용량의 묶음 (lib/prepaidSplit)
  const okind = banchan ? null : kindOf(stage, (o as any).volume);
  const split = !banchan && isSplit(cust);
  const left = banchan ? (cust?.prepaid_banchan || 0) : balanceFor(cust, okind);
  // 한 주문에 230g·300g 이 섞여 있으면(서은혁) 묶음마다 따로 빠진다 — 서버도 같은 계산(lib/prepaidSplit orderKinds)
  const ks = banchan ? [] : orderKinds(o as any);
  const mixed = ks.length > 1;
  const mixTxt = ks.map(k => `${k.kind ? shortKind(k.kind) : '?'} ${k.qty}`).join(' · ');
  const afterTxt = (sign: number) => mixed
    ? ks.map(k => `${k.kind ? shortKind(k.kind) : '?'} ${k.kind ? partBalance(cust, k.kind) : 0}→${(k.kind ? partBalance(cust, k.kind) : 0) + sign * k.qty}`).join(' · ')
    : `${left}${unit} → ${left + sign * qty}${unit}`;
  /* 용량별로 따로 센다 — 사장님 2026-11-14(서은혁): "카운팅 자체를 2개로 나눠서 해야 돼"
     230·300 섞인 주문이거나 여러 묶음 손님이면 '남은 선결제'·'한꺼번에 빼기' 칸을 묶음마다 하나씩 */
  const perKinds: string[] = banchan ? [] : [...new Set([
    ...ks.map(k => k.kind).filter((k): k is string => !!k),
    ...(split ? partsOf(cust).map(p => p.kind) : []),
  ])];
  const perKind = perKinds.length > 1;
  const [edits, setEdits] = useState<Record<string, string>>({});
  const editOf = (k: string) => edits[k] ?? String(partBalance(cust, k));
  async function setPart(k: string) {
    if (!cust) return;
    const raw = editOf(k).trim();
    const n = Number(raw || 0);
    const before = partBalance(cust, k);
    if (!Number.isInteger(n)) { setInfo('숫자로 적어주세요'); return; }
    if (n === before) { setEdits(e => { const x = { ...e }; delete x[k]; return x; }); return; }
    if (!confirm(`${o.baby_name} — ${k} 남은 ${before}팩 → ${n}팩으로 고칠까요?`)) { setEdits(e => { const x = { ...e }; delete x[k]; return x; }); return; }
    setBusy(true); setInfo(null);
    const d = await fetch(`/api/customers/${cust.id}/prepaid`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ set: n, kind: k, per_kind: true, memo: '입금 탭에서 고침' }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e?.message }));
    setBusy(false);
    setEdits(e => { const x = { ...e }; delete x[k]; return x; });
    if (!d.ok) { setInfo(`못 고쳤어요: ${d.error || ''}`); return; }
    patch({ customerId: cust.id, customer: { prepaid_balance: d.new_balance, prepaid_split: d.split ?? null, ...(d.label ? { prepaid_label: d.label } : {}) } as any });
    setInfo(`${shortKind(k)} 남은 ${n}팩으로 고쳤어요`);
  }
  const [startsN, setStartsN] = useState<Record<string, string>>({});
  const used = /^선결제 차감 \d+(팩|회) \(입금 탭/.test(String(o.paid_note || '')); // 이 화면에서 뺀 것
  const label = split ? okind : (cust?.prepaid_label || labelOf(o));
  const [edit, setEdit] = useState(String(left));
  // 손님 카드를 늦게 불러오면 그때의 남은 팩으로 칸을 맞춘다
  useEffect(() => { setEdit(String(left)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [cust?.id]);

  // 택배비 선결제 회수는 서버가 주문과 같이 뺀다(lib/prepaidShip) — 뺀 뒤 손님 카드에서 다시 읽어 맞춘다
  async function reloadShip() {
    if (!cust || cust.prepaid_ship === null || cust.prepaid_ship === undefined) return;
    try {
      const d = await fetch(`/api/customers?id=${cust.id}`).then(r => r.json());
      if (d.customer) patch({ customerId: cust.id, customer: { prepaid_ship: d.customer.prepaid_ship } });
    } catch { /* 못 읽으면 새로고침 때 맞는다 */ }
  }

  async function use(on: boolean) {
    if (!confirm(mixed
      ? (on ? `${o.baby_name} — 이 주문 ${mixTxt}팩을 선결제에서 뺄까요?\n남은 ${afterTxt(-1)}`
        : `${o.baby_name} — 선결제에서 뺀 ${mixTxt}팩을 돌려놓을까요?\n남은 ${afterTxt(1)}, 주문은 미입금으로`)
      : on
      ? `${o.baby_name} — 이 주문 ${qty}${unit}을 선결제에서 뺄까요?\n남은 ${left}${unit} → ${left - qty}${unit}`
      : `${o.baby_name} — 선결제에서 뺀 ${qty}${unit}을 돌려놓을까요?\n남은 ${left}${unit} → ${left + qty}${unit}, 주문은 미입금으로`)) return;
    setBusy(true); setInfo(null);
    const d = await fetch('/api/admin/order-prepaid', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: o.id, use: on }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e?.message }));
    setBusy(false);
    if (!d.ok) { setInfo(`못 했어요: ${d.error || ''}`); return; }
    patch({ order: { paid: d.paid, paid_note: d.paid_note }, customerId: d.customer_id, customer: (banchan ? { prepaid_banchan: d.balance } : { prepaid_balance: d.balance, prepaid_split: d.split ?? null }) as any });
    setEdit(String(d.part ?? d.balance));
    void reloadShip();
    setInfo(on ? `선결제에서 뺐어요 — 남은 ${d.part ?? d.balance}${unit}` : `돌려놓았어요 — 남은 ${d.part ?? d.balance}${unit}`);
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
      body: JSON.stringify(banchan ? { item: '반찬', set: n, memo: '입금 탭에서 고침' } : { set: n, memo: '입금 탭에서 고침', ...(split && okind ? { kind: okind } : {}) }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e?.message }));
    setBusy(false);
    if (!d.ok) { setInfo(`못 고쳤어요: ${d.error || ''}`); setEdit(String(left)); return; }
    patch({ customerId: cust.id, customer: banchan ? { prepaid_banchan: d.new_balance } : { prepaid_balance: d.new_balance, prepaid_split: d.split ?? null } });
    setInfo(`남은 ${d.part ?? d.new_balance}${unit}로 고쳤어요`);
  }

  async function charge(units: number, pick: string) {
    if (!cust) return;
    const wonAmt = prepaidPrice(pick, units);
    if (!confirm(wonAmt ? `${o.baby_name} — ${pick} ${units}팩 ${wonAmt.toLocaleString()}원 받으셨나요?` : `${o.baby_name} — ${units}팩을 넣을까요?`)) return;
    setBusy(true); setInfo(null);
    const d = await fetch(`/api/customers/${cust.id}/prepaid`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ units, amount_won: wonAmt || undefined, label: pick }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e?.message }));
    setBusy(false);
    if (!d.ok) { setInfo(`못 넣었어요: ${d.error || ''}`); return; }
    const nc = { prepaid_balance: d.new_balance, prepaid_split: d.split ?? null, prepaid_label: d.label || pick };
    patch({ customerId: cust.id, customer: nc });
    setEdit(String(balanceFor(nc as any, okind)));
    setInfo(`${units}팩 넣었어요 — ${d.split ? `묶음이 나뉘었어요(${(d.split as any[]).map(p => `${p.kind} ${p.balance}`).join(' · ')}). ` : `남은 ${d.new_balance}팩. `}이 주문도 빼시려면 '선결제에서 빼기'를 누르세요`);
  }

  /* 이 날부터 뒤로 한꺼번에 — 사장님 2026-11-14: "2일 페이지에서 갯수 정하면 그 뒤로 체크 안 된 것들 자동 차감"
     이 주문 '전' 남은 수를 적으면 미리보기 → 한꺼번에 빼기 */
  const [startN, setStartN] = useState('');
  const [preview, setPreview] = useState<{ lines: CascadeLine[]; final: number | string; current: number | string; neg?: boolean } | null>(null);
  async function cascade(apply: boolean) {
    const n = Number(startN.trim());
    // 용량별 — 적은 묶음만 센다 (lib: order-prepaid/cascade multi)
    const starts: Record<string, number> = {};
    if (perKind) {
      for (const k of perKinds) { const v = (startsN[k] || '').trim(); if (v !== '') starts[k] = Number(v); }
      if (!Object.keys(starts).length) { setInfo('묶음마다 이 주문 전에 남아 있던 수를 적어 주세요 (안 쓰는 묶음은 비워 두세요)'); return; }
    } else if (startN.trim() === '' || !Number.isInteger(n) || n < 0) { setInfo('이 주문 전에 남아 있던 수를 숫자로 적어 주세요'); return; }
    if (apply && preview && !confirm(`${o.baby_name} — ${preview.lines.filter(l => l.action === '뺌').length}건을 선결제에서 빼고, 남은 ${preview.final}${unit}로 맞출까요?`)) return;
    setBusy(true); setInfo(null);
    const d = await fetch('/api/admin/order-prepaid/cascade', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(perKind ? { id: o.id, starts, apply } : { id: o.id, start: n, apply }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e?.message }));
    setBusy(false);
    if (!d.ok) { setInfo(`못 했어요: ${d.error || ''}`); return; }
    if (!apply) { setPreview({ lines: d.lines, final: d.final, current: d.current, neg: d.neg }); return; }
    if (d.multi) {
      patch({ customerId: d.customer_id, customer: { prepaid_balance: d.total, prepaid_split: d.split ?? null } as any });
      for (const x of d.done || []) {
        const p: Patch = { order: { paid: true, paid_note: x.paid_note } };
        if (x.id === o.id) patch(p); else onPatchOrder(x.id, p);
      }
      setPreview(null); setStartsN({});
      void reloadShip();
      setInfo(`${(d.done || []).length}건 뺐어요 — 남은 ${d.final}${unit}`);
      return;
    }
    patch({ customerId: d.customer_id, customer: (banchan ? { prepaid_banchan: d.final } : { prepaid_balance: d.total ?? d.final, prepaid_split: d.split ?? null }) as any });
    for (const x of d.done || []) {
      const p: Patch = { order: { paid: true, paid_note: x.paid_note } };
      if (x.id === o.id) patch(p); else onPatchOrder(x.id, p);
    }
    setEdit(String(d.final)); setPreview(null); setStartN('');
    void reloadShip();
    setInfo(`${(d.done || []).length}건 뺐어요 — 남은 ${d.final}${unit}`);
  }

  const btn = 'px-2.5 py-1 rounded-lg border text-[12px] font-bold disabled:opacity-40';
  return (
    <div className="mb-3 border-2 border-violet-300 bg-violet-50/60 rounded-xl p-3 text-[12px] space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <b className="text-[14px] text-stone-900">{o.baby_name}</b>
        <span className="text-stone-600">{banchan ? (stage === '반찬낱개' ? `반찬 낱개 ${qty}개` : `반찬 ${qty}세트`) : mixed ? `${stage.replace('단계', '')} ${mixTxt}팩` : `${stage.replace('단계', '')} ${o.volume || ''} ${qty}팩`} · {won((o.total_price || 0) + (o.shipping_fee || 0))}</span>
        <span className={`px-1.5 rounded ${used ? 'bg-violet-200 text-violet-900' : o.paid ? 'bg-emerald-200 text-emerald-900' : 'bg-white border border-stone-300 text-rose-700'}`}>
          {o.order_type === '선결제' ? '선결제 주문' : used ? '선결제에서 뺌' : o.paid ? '입금확인' : '미입금'}
        </span>
        <button onClick={onClose} className="ml-auto text-stone-500 text-[12px] underline">닫기</button>
      </div>
      {o.paid_note && <p className="text-[11px] text-stone-500">{o.paid_note}</p>}
      {/* 이름·팩수만 먼저 넣은 아이 — 연락처·주소를 여기서 넣으면 손님 카드가 이어지고 선결제도 쓸 수 있다 */}
      {!String((o as any).address || '').trim() && (o as any).receive_method !== '픽업' && (
        <LaterInfo order={o as any} onSaved={row => patch({ order: row })} />
      )}

      {/* ① 돈으로 받았으면 이것 하나 — 판 맨 앞 */}
      {!used && o.order_type !== '선결제' && (
        <button disabled={busy} onClick={onToggle}
          className={`w-full py-2 rounded-lg border-2 text-[14px] font-black disabled:opacity-40 ${o.paid ? 'border-stone-300 bg-white text-stone-600' : 'border-emerald-400 bg-emerald-100 text-emerald-900'}`}>
          {o.paid ? '입금확인 끄기' : '✓ 입금확인 (돈으로 받음)'}
        </button>
      )}

      {/* ② 선결제 — 새로 시작하면 충전 → 이 주문 빼기 순서로 */}
      {!cust && loaded === undefined && !custProp ? <p className="text-stone-400">손님 카드 불러오는 중…</p> : !cust ? <p className="text-rose-700">손님 카드를 못 찾았어요 — 고객관리에서 이 손님을 먼저 찾아 주세요(카드가 연결돼야 선결제를 씁니다).</p> : (
        <>
          <p className="pt-1 text-[11px] font-bold text-violet-800 border-t border-violet-200">선결제 {left === 0 && !used ? '— 새로 시작하면 ① 충전 ② 이 주문 빼기' : ''}</p>
          {(() => {
            const to = ks.map(k => k.kind).find(k => convertNeed(cust, k));
            return to ? <ConvertBox cust={cust} to={to} onDone={(nc, msg) => {
              patch({ customerId: cust.id, customer: nc });
              setEdits({}); setEdit(String(nc?.prepaid_balance ?? left)); setInfo(msg);
            }} /> : null;
          })()}
          {!banchan && (
            <div className="flex gap-1.5 flex-wrap items-center">
              <span className="text-stone-500">충전</span>
              <ChargeBar label={label} disabled={busy} onCharge={(u, l) => charge(u, l)} />
            </div>
          )}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-bold text-stone-700">남은 {banchan ? '반찬' : '선결제'}</span>
            {perKind ? perKinds.map(k => (
              <label key={k} className="flex items-center gap-0.5" title={`${k} 남은 팩 (마이너스 = 받을 팩)`}>
                <span className="font-bold text-stone-600">{shortKind(k)}</span>
                <input value={editOf(k)} onChange={e => { const v = e.target.value.replace(/[^\d-]/g, ''); setEdits(s => ({ ...s, [k]: v })); }} disabled={busy}
                  onBlur={() => setPart(k)} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} inputMode="numeric"
                  className={`w-12 px-1.5 py-0.5 border rounded text-right text-[13px] font-black outline-none focus:border-violet-400 ${partBalance(cust, k) < 0 ? 'text-red-600' : 'text-violet-800'} border-violet-300`} />
                <span>팩</span>
              </label>
            )) : <>
            <input value={edit} onChange={e => setEdit(e.target.value.replace(banchan ? /\D/g : /[^\d-]/g, ''))} disabled={busy}
              onBlur={setLeft} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} inputMode="numeric"
              className={`w-14 px-1.5 py-0.5 border rounded text-right text-[13px] font-black outline-none focus:border-violet-400 ${left < 0 ? 'text-red-600' : 'text-violet-800'} border-violet-300`} />
            <span>{unit}{!banchan && label ? <span className="ml-1 text-stone-400">{label}</span> : null}</span>
            </>}
            {!banchan && cust.prepaid_ship !== null && cust.prepaid_ship !== undefined && (
              <span className={`text-[11px] font-bold ${cust.prepaid_ship < 0 ? 'text-red-600' : 'text-sky-700'}`}
                title="택배 주문이 선결제로 빠질 때 5팩까지 1회씩 같이 빠집니다">
                · 택배비 {cust.prepaid_ship}회
              </span>
            )}
            {split && !perKind && (
              <span className="text-[11px] text-stone-500">
                · 다른 묶음 {partsOf(cust).filter(p => p.kind !== okind).map(p => (
                  <b key={p.kind} className={`ml-1 ${p.balance < 0 ? 'text-red-600' : 'text-stone-700'}`}>{shortKind(p.kind)} {p.balance}</b>
                ))}
              </span>
            )}
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
                {mixed ? <>선결제에서 빼기 (−{mixTxt} → 남은 {afterTxt(-1).replace(/ -?\d+→/g, ' ')})</> : <>선결제에서 빼기 (−{qty}{unit} → 남은 {left - qty})</>}
              </button>
            )}
          </div>
          {mixed && (
            <p className="text-[11px] text-violet-800">
              이 주문은 용량이 섞여 있어요 — <b>{mixTxt}</b>팩이 묶음마다 따로 빠집니다. 없는 용량은 마이너스(받을 팩)로 잡혀요.
            </p>
          )}
          {o.order_type !== '선결제' && stage !== '반찬낱개' && (
            <div className="pt-2 border-t border-violet-200 space-y-1.5">
              <p className="text-[11px] font-bold text-violet-800">이 날부터 뒤로 한꺼번에 빼기</p>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-stone-700">{md(o.delivery_date || '')} 이 주문 전에 남은</span>
                {perKind ? perKinds.map(k => (
                  <label key={k} className="flex items-center gap-0.5">
                    <span className="font-bold text-stone-600">{shortKind(k)}</span>
                    <input value={startsN[k] || ''} onChange={e => { const v = e.target.value.replace(/\D/g, ''); setStartsN(s => ({ ...s, [k]: v })); setPreview(null); }} disabled={busy}
                      onKeyDown={e => { if (e.key === 'Enter') cascade(false); }} inputMode="numeric" placeholder="예: 20"
                      className="w-12 px-1.5 py-0.5 border border-violet-300 rounded text-right text-[13px] font-black text-violet-800 outline-none focus:border-violet-400" />
                  </label>
                )) : (
                  <input value={startN} onChange={e => { setStartN(e.target.value.replace(/\D/g, '')); setPreview(null); }} disabled={busy}
                    onKeyDown={e => { if (e.key === 'Enter') cascade(false); }} inputMode="numeric" placeholder="예: 30"
                    className="w-14 px-1.5 py-0.5 border border-violet-300 rounded text-right text-[13px] font-black text-violet-800 outline-none focus:border-violet-400" />
                )}
                <span>{unit}</span>
                <button disabled={busy || (perKind ? !Object.values(startsN).some(v => v) : !startN)} onClick={() => cascade(false)} className={`${btn} border-violet-300 bg-white text-violet-800`}>뒤 주문 보기</button>
              </div>
              {preview && (
                <div className="bg-white border border-violet-200 rounded-lg p-2 space-y-0.5">
                  {preview.lines.length === 0 && <p className="text-stone-500">이 날부터 뒤로 주문이 없어요</p>}
                  {preview.lines.map(l => (
                    <div key={l.id} className={`flex gap-2 text-[12px] ${l.action === '뺌' ? 'text-violet-900 font-bold' : 'text-stone-400'}`}>
                      <span className="w-10">{md(l.date)}</span>
                      <span className="w-10 text-right">{l.qty}{unit}</span>
                      <span className="flex-1">{l.action === '뺌' ? '이번에 뺌' : l.action === '이미 뺌' ? '이미 선결제로 빠짐' : `건너뜀(${l.why})`}</span>
                      <span>남은 {l.after}</span>
                    </div>
                  ))}
                  <p className="pt-1 text-[12px] text-stone-700">지금 남은 {preview.current}{unit} → <b className={(preview.neg ?? (Number(preview.final) < 0)) ? 'text-red-600' : 'text-violet-800'}>{preview.final}{unit}</b></p>
                  {perKind && <p className="text-[11px] text-stone-500">숫자를 적은 묶음만 셉니다. 안 적은 용량이 섞인 주문은 건너뜁니다.</p>}
                  <button disabled={busy || !preview.lines.some(l => l.action === '뺌') && preview.final === preview.current} onClick={() => cascade(true)}
                    className={`${btn} w-full py-1.5 border-violet-400 bg-violet-100 text-violet-900 text-[13px]`}>
                    {preview.lines.filter(l => l.action === '뺌').length}건 한꺼번에 빼기
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
      {info &&<p className="text-[12px] text-violet-800 font-bold">{info}</p>}
    </div>
  );
}

export default function DepositTab({ dayOrders = [], date, customers = [], onTogglePaid, onPatch, onAdded }: {
  dayOrders?: SheetOrder[]; date?: string; customers?: Customer[]; onTogglePaid?: (o: any) => void;
  onPatch?: (orderId: string | null, p: Patch) => void;
  onAdded?: (row: any) => void; // 표 단계 아래 추가 줄로 넣은 주문 — 조리표 탭과 같은 주문 목록에 꽂는다
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
  // 선결제보다 더 먹은 손님 — 입금 요청 톡 보낼 명단 (사장님 2026-11-14)
  // 여러 단계 선결제 손님은 묶음 하나만 마이너스여도 (예: 완료기 230 −3, 후기 230 +12)
  // 택배비 선결제(prepaid_ship)가 마이너스여도 — '택배비' 묶음으로 같이 보인다
  const minus = customers.map(c => ({ c, neg: [...partsOf(c).filter(p => p.balance < 0), ...((c.prepaid_ship || 0) < 0 ? [{ kind: '택배비(회)', balance: c.prepaid_ship as number }] : [])] })).filter(x => x.neg.length > 0)
    .sort((a, b) => Math.min(...a.neg.map(p => p.balance)) - Math.min(...b.neg.map(p => p.balance)) || String(a.c.baby_name).localeCompare(String(b.c.baby_name), 'ko'));

  return (
    <div className="space-y-4">
      <PostpaidBox onSettled={(ids, note) => ids.forEach(id => onPatch?.(id, { order: { paid: true, paid_note: note } }))} />
      {minus.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          <p className="text-[13px] font-black text-red-700">입금 요청 — 선결제 마이너스 {minus.length}명</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {minus.map(({ c, neg }) => (
              <span key={c.id} className="px-2 py-0.5 rounded-lg bg-white border border-red-200 text-[12px]">
                <b className="text-stone-900">{c.baby_name}</b>
                {neg.map(p => (
                  <span key={p.kind}><b className="ml-1 text-red-600">{p.balance}팩</b><span className="ml-0.5 text-[11px] text-stone-400">{p.kind}</span></span>
                ))}
                {isSplit(c) && <span className="ml-1 text-[11px] text-stone-400">(다른 묶음 {partsOf(c).filter(p => p.balance >= 0).map(p => `${shortKind(p.kind)} ${p.balance}`).join(' · ')})</span>}
                {c.phone && <span className="ml-1 text-[11px] text-stone-500">{c.phone.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3')}</span>}
              </span>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-stone-500">입금 체크판에서도 이름 옆에 빨간 숫자(−7)로 보입니다. 입금받으면 이름을 눌러 충전하세요.</p>
        </div>
      )}
      {date && <PaySheet orders={dayOrders} date={date} customers={customers} onToggle={toggleFromSheet}
        onPatch={(id, p) => onPatch?.(id, p)} onAdded={onAdded} />}

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
