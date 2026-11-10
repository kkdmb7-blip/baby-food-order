'use client';
import { useEffect, useRef, useState } from 'react';
import { MENU_TYPES, menuLabel, type StageType } from '@/lib/supabase';
import { SLOTS, slotKey, fitSlot, type Slot } from '@/lib/slots';
import { slicesOn } from '@/lib/orderItems';
import { parseKakaoOrder, missingFields, FIELD_LABEL, type ParsedKakaoOrder } from '@/lib/parseKakaoOrder';

/*
  한 사람씩, 이름 한 번 치고 칸만 체크하는 입력판.

  어떻게 쓰나
    ① 이름을 한 번 친다 → 뜨는 집을 엔터로 고른다 (연락처·주소가 따라온다)
    ② 여덟 칸(중기1 240·310, 중기2 230·300, 후기 230·300, 완료기 230·300)에
       해당하는 자리에 한우·닭·기타 팩수를 넣는다
    ③ 엔터나 '확인' → 저장되고 아래로 쌓인다. 입력칸은 비워져 다음 사람 차례.
    ④ 잘못 넣었으면 '되돌리기' → 그 주문은 취소되고, 넣었던 내용이 위 칸에 그대로 올라온다.
       되돌리기는 지우는 버튼이 아니라 고치는 버튼이다 — 고쳐서 다시 엔터를 치면 된다.
    ⑤ 월·목을 같이 주문하셨으면 목요일에 '이름만 적어둔다'. 목요일을 정리할 때
       오른쪽에 그 이름이 떠 있고, 눌러서 그때 채워 넣는다.

  조리일은 하나다
    전에는 이 판에 날짜 칸이 따로 있어서, 여기서 날짜를 바꾸면 화면 위쪽은 그대로인 채
    주문만 다른 날짜로 들어갔다. 넣고 나서 어디로 갔는지 알 수 없었다.
    이제 이 날짜 칸은 화면 맨 위 날짜와 같은 칸이다 — 여기서 바꾸면 화면 전체가 따라간다.

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

  처음 오는 손님도 여기서 받는다
    단골은 이름만 고르면 연락처·주소·개월수가 지난 주문에서 따라온다.
    처음 오는 손님은 그 자리에서 연락처·주소·개월수를 받아 고객으로도 저장한다.
    선결제·픽업과 반찬(유아식)은 아직 아래 '조리표에 줄 넣기'로 넣어야 한다.
*/

type Addr = {
  address: string; addressDetail: string | null; doorPassword: string | null;
  postalCode: string | null; deliveryMethod: string | null; lastDate: string;
};

type Hit = {
  babyName: string; phone: string; address: string; addressDetail: string | null;
  doorPassword: string | null; stage: string | null; volume: number | null;
  lastMenus?: Record<string, number>;
  addresses?: Addr[];
  postalCode: string | null; deliveryMethod: string | null; receiveMethod: string | null;
  lastDate: string; lastMonths: number; guessMonths: number; orders: number; orderType: string | null;
};

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const dowOf = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? DOW[new Date(d + 'T00:00:00Z').getUTCDay()] : '');
const addDays = (d: string, n: number) =>
  /^\d{4}-\d{2}-\d{2}$/.test(d)
    ? new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10)
    : d;
const fullAddr = (a: Addr) => (a.address + (a.addressDetail ? ' ' + a.addressDetail : '')).trim();

/** 조리일에 이름만 적어둔 것. 팩수도 메뉴도 없는 '그날 할 일'이다 */
type Pend = {
  id: string; delivery_date: string; baby_name: string;
  customer_phone: string | null; note: string | null; done_at: string | null;
};

type Qty = Record<string, Record<string, string>>;   // slotKey → menu → 팩수

const copyQty = (q: Qty): Qty => Object.fromEntries(Object.entries(q).map(([k, v]) => [k, { ...v }]));

/** 넣을 때 화면에 있던 것 전부. 되돌리기를 누르면 이걸 그대로 다시 올린다 —
    되돌리기는 지우는 버튼이 아니라 고치는 버튼이라, 내용이 돌아와야 고칠 수 있다. */
type Snap = {
  deliveryDate: string;
  pendId: string | null;      // 적어둔 이름에서 끌어온 것이면 그 id — 되돌리면 다시 '할 일'로 돌아간다
  q: string;
  hit: Hit | null;
  isNew: boolean;
  nc: { phone: string; address: string; months: string; door: string };
  addrIdx: number;
  addrAdding: boolean;
  addrNew: { address: string; door: string };
  qty: Qty;
};

/** 넣고 난 줄 — 아래로 쌓인다. id 를 들고 있어야 잘못 친 걸 되돌릴 수 있다 */
type Done = {
  key: number;
  name: string;
  date: string;               // 어느 조리일에 넣었는지 — 날짜를 바꿔가며 치면 섞인다
  undone?: boolean;
  pending?: boolean;          // 보내는 중 — 화면은 기다리지 않고 다음 사람을 치게 한다
  snap: Snap;
  lines: {
    slot: Slot; menus: Record<string, number>; total: number;
    ok: boolean; pending?: boolean; error?: string; id?: string; row?: any;
  }[];
};

let SEQ = 1;

export default function GridEntry({ date, orders, onSaved, onDateChange }: {
  date: string;
  /** 그날 주문 전부 — 오른쪽 조리갯수를 아래 조리표와 같은 자료로 세기 위해 받는다 */
  orders: any[];
  /** 만들어진 주문 줄을 넘긴다 — 화면이 주문 전체를 다시 받지 않고 그 줄만 꽂으면 된다 */
  onSaved: (rows?: any[]) => void;
  onDateChange: (d: string) => void;
}) {
  // 아침에 조리표 탭을 열면 바로 치기 시작하신다 — 접혀 있으면 매번 한 번 더 눌러야 한다
  const [open, setOpen] = useState(true);

  // 조리일은 화면 위쪽과 같은 값이다. 여기서 바꾸면 위도 같이 바뀐다(onDateChange).
  // 따로 들고 있으면 넣은 주문이 화면에 없는 날짜로 가버린다.
  const deliveryDate = date;

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

  // 주소 — 하나뿐이면 고를 일이 없다. 둘 이상일 때만 고르고, 기본은 대표(가장 최근) 주소.
  // 새 주소는 여기서 바로 적어 쓸 수 있고, 쓰고 나면 다음부터 목록에 뜬다(주문에 남으므로).
  const [addrIdx, setAddrIdx] = useState(0);
  const [addrAdding, setAddrAdding] = useState(false);
  const [addrNew, setAddrNew] = useState({ address: '', door: '' });
  const ncPhone = nc.phone.replace(/\D/g, '');
  const ncValid = /^\d{10,11}$/.test(ncPhone) && nc.address.trim().length > 3 && Number(nc.months) > 0;

  // 지난 주문에서 모은 주소들. 옛 응답에는 addresses 가 없을 수 있어 한 건짜리로 되살린다.
  const addrList: Addr[] = hit
    ? (hit.addresses?.length ? hit.addresses : [{
        address: hit.address, addressDetail: hit.addressDetail, doorPassword: hit.doorPassword,
        postalCode: hit.postalCode, deliveryMethod: hit.deliveryMethod, lastDate: hit.lastDate,
      }])
    : [];
  const usingNewAddr = addrAdding && addrNew.address.trim().length > 3;
  const chosenAddr: Addr | null = !hit ? null
    : usingNewAddr
      ? { address: addrNew.address.trim(), addressDetail: null, doorPassword: addrNew.door.trim() || null,
          postalCode: null, deliveryMethod: null, lastDate: '' }
      : (addrList[addrIdx] || addrList[0] || null);

  // 카톡 주문서 붙여넣기 — 읽을 수 있는 만큼만 읽어 아래 칸을 채운다.
  // 멋대로 저장하지 않는다. 사장님이 보고 고친 뒤 엔터를 쳐야 들어간다.
  const [paste, setPaste] = useState('');
  const [parsed, setParsed] = useState<ParsedKakaoOrder | null>(null);
  const [pasteNote, setPasteNote] = useState<string | null>(null);

  // 적어둔 이름 — 이 조리일에 이름만 미리 적어둔 것들
  const [pend, setPend] = useState<Pend[]>([]);
  const [pendUsed, setPendUsed] = useState<string | null>(null);   // 지금 치는 사람이 그 목록에서 왔으면 그 id
  const [parkOpen, setParkOpen] = useState(false);
  const [park, setPark] = useState({ date: '', name: '', note: '' });

  const [done, setDone] = useState<Done[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // 날짜가 바뀌면 그 날짜에 적어둔 이름을 불러온다
  useEffect(() => {
    if (!open || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    let alive = true;
    (async () => {
      try {
        const d = await fetch(`/api/admin/pending-names?date=${date}`).then(r => r.json());
        if (alive && d.ok) setPend(d.rows || []);
      } catch { /* 못 불러와도 입력은 된다 */ }
    })();
    return () => { alive = false; };
  }, [date, open]);

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

  function pick(h: Hit, prefill = true) {
    setHit(h); setQ(h.babyName); setHits([]); setListOpen(false); setIsNew(false);
    setAddrIdx(0); setAddrAdding(false); setAddrNew({ address: '', door: '' });
    if (!prefill) return;   // 카톡에서 읽은 팩수를 덮어쓰면 안 된다
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

  function applyPaste(text: string) {
    setPaste(text);
    setPasteNote(null);
    const t = text.trim();
    setParsed(t ? parseKakaoOrder(t, deliveryDate || date) : null);
  }

  /**
   * 읽은 걸 아래 칸으로 옮긴다. 저장은 안 한다 — 보시고 엔터를 쳐야 들어간다.
   * 못 읽은 건 비워 두고 무엇을 못 읽었는지 적는다. 멋대로 채우면 틀린 걸 모르고 넘어간다.
   */
  async function fillFromParsed() {
    const p = parsed;
    if (!p) return;
    setErr(null);
    // 주문서에 적힌 조리일이 화면 날짜와 다르면 화면 날짜를 그 날로 옮긴다(위쪽까지 같이).
    // 조용히 다른 날짜로 저장하면 넣은 게 화면에서 사라져 어디로 갔는지 알 수 없다.
    const dateMoved = p.delivery_date && p.delivery_date !== date ? p.delivery_date : '';
    if (dateMoved) onDateChange(dateMoved);

    // 단계 묶음 → 여덟 칸
    const nq: Qty = {};
    const unknown: string[] = [];
    const moved: string[] = [];      // 용량을 그 단계의 칸으로 맞춘 것
    const noQty: string[] = [];      // 칸은 찾았는데 팩수가 안 적힌 것
    let noMenu = 0;
    for (const s of p.sets) {
      if (!s.stage || !s.volume) {
        unknown.push(`${s.stage || '단계?'} ${s.volume ? s.volume + 'g' : '용량?'}`);
        continue;
      }
      // 주문서 안내문이 "230g 또는 300g" 이라 중기1단계도 230·300 으로 적어 보내신다.
      // 중기1은 240·310 이므로(중기2를 한 번 더 갈아 다시 끓이니 양이 는다) 그 칸으로 맞춘다.
      const slot = fitSlot(s.stage, Number(s.volume));
      if (!slot) {
        unknown.push(`${s.stage} ${s.volume}g`);
        continue;
      }
      if (slot.volume !== Number(s.volume)) {
        moved.push(`${s.stage.replace('단계', '')} ${s.volume}g→${slot.volume}g`);
      }
      const row: Record<string, string> = {};
      let sum = 0;
      for (const m of MENU_TYPES) {
        const n = s.menus[m] || 0;
        if (n) { row[m] = String(n); sum += n; }
      }
      if (!sum) {
        if (s.qty) noMenu += s.qty;
        else noQty.push(slot.label);
      }
      nq[slot.key] = row;
    }

    // 손님 찾기 — 번호가 가장 확실하다
    const term = p.customer_phone || p.baby_name;
    let found: Hit | null = null;
    if (term) {
      try {
        const d = await fetch(`/api/admin/order-lookup?q=${encodeURIComponent(term)}`).then(r => r.json());
        const list: Hit[] = d.ok ? (d.hits || []) : [];
        found = p.customer_phone
          ? (list.find(h => h.phone.replace(/\D/g, '') === p.customer_phone) || null)
          : (list.length === 1 ? list[0] : null);
      } catch { /* 못 찾으면 처음 오는 손님으로 받는다 */ }
    }

    if (found) {
      pick(found, false);
    } else {
      setHit(null); setQ(p.baby_name); setHits([]); setListOpen(false);
      setIsNew(true);
      setNc({ phone: p.customer_phone, address: p.address, months: p.months, door: p.door_password });
    }
    setQty(nq);

    const miss = missingFields(p).map(k => FIELD_LABEL[k]);
    const notes: string[] = [];
    notes.push(found ? `${found.babyName} — 지난 주문에서 찾았어요` : '처음 오는 손님으로 받았어요');
    if (dateMoved) notes.push(`조리일을 ${dateMoved}(${dowOf(dateMoved)})로 옮겼어요`);
    if (moved.length) notes.push(`용량을 그 단계 칸으로 맞췄어요: ${moved.join(', ')}`);
    if (noQty.length) notes.push(`${noQty.join('·')} 칸 — 팩수를 넣어주세요`);
    if (p.isBanchan && !Object.keys(nq).length) {
      notes.push('반찬(유아식) 주문은 이 칸으로 못 넣어요 — 아래 "조리표에 줄 넣기"로 넣어주세요');
    }
    if (noMenu) notes.push(`메뉴가 안 적힌 ${noMenu}팩 — 한우·닭·기타로 나눠 넣어주세요`);
    if (unknown.length) notes.push(`못 넣은 칸: ${unknown.join(', ')}`);
    if (miss.length) notes.push(`못 읽음: ${miss.join('·')}`);
    setPasteNote(notes.join('  ·  '));
  }

  function reset() {
    setQ(''); setHit(null); setQty({}); setHits([]); setListOpen(false); setErr(null); setInfo(null);
    setPaste(''); setParsed(null); setPasteNote(null);
    setIsNew(false); setNc({ phone: '', address: '', months: '', door: '' });
    setAddrIdx(0); setAddrAdding(false); setAddrNew({ address: '', door: '' });
    setPendUsed(null); setParkOpen(false); setPark({ date: '', name: '', note: '' });
    setTimeout(() => nameRef.current?.focus(), 0);
  }

  /** 넣었던 것을 화면에 그대로 다시 올린다 — 이름·연락처·주소·팩수까지. 고쳐서 엔터만 치면 된다 */
  function restore(s: Snap) {
    if (s.deliveryDate && s.deliveryDate !== date) onDateChange(s.deliveryDate);
    setPendUsed(s.pendId);
    setQ(s.q); setHit(s.hit); setHits([]); setListOpen(false);
    setIsNew(s.isNew); setNc({ ...s.nc });
    setAddrIdx(s.addrIdx); setAddrAdding(s.addrAdding); setAddrNew({ ...s.addrNew });
    setQty(copyQty(s.qty));
    setPaste(''); setParsed(null); setPasteNote(null);
    setErr(null);
    setTimeout(() => nameRef.current?.focus(), 0);
  }

  /* ── 적어둔 이름 ──────────────────────────────────────────────
     월·목을 같이 주문하셨을 때, 목요일 것까지 한 번에 치려면 시간이 너무 걸린다.
     목요일 자리에 이름만 적어두고 목요일에 카톡을 다시 보며 채우는 것이 원래 방식이다.
     주문으로 넣으면 0팩 주문이 조리표·매출에 섞이니 따로 둔다. */

  /** 다른 날짜에 이름만 적어둔다 */
  async function addPark() {
    const name = park.name.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(park.date)) { setErr('적어둘 조리일을 골라주세요'); return; }
    if (!name) { setErr('적어둘 이름을 넣어주세요'); return; }
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/admin/pending-names', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          delivery_date: park.date, baby_name: name,
          customer_phone: hit?.phone || '', note: park.note,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) { setErr(j.error || '적어두기 실패'); setBusy(false); return; }
      if (park.date === date && j.row) setPend(p => [...p, j.row]);
      setInfo(`${park.date}(${dowOf(park.date)}) 에 ${name} 적어뒀어요 — 그날 날짜를 고르면 오른쪽에 뜹니다`);
      setParkOpen(false); setPark({ date: '', name: '', note: '' });
    } catch (e: any) { setErr(e?.message || '적어두기 실패'); }
    setBusy(false);
  }

  /** 적어둔 이름을 눌렀을 때 — 이름을 쳐서 집을 고른 것과 똑같은 상태가 된다 */
  async function usePend(p: Pend) {
    setErr(null); setInfo(null); setQty({});
    setPaste(''); setParsed(null); setPasteNote(null);
    setPendUsed(p.id);
    const term = (p.customer_phone || '').replace(/\D/g, '') || p.baby_name;
    try {
      const d = await fetch(`/api/admin/order-lookup?q=${encodeURIComponent(term)}`).then(r => r.json());
      const list: Hit[] = d.ok ? (d.hits || []) : [];
      const want = (p.customer_phone || '').replace(/\D/g, '');
      const found = want
        ? list.find(h => h.phone.replace(/\D/g, '') === want)
        : (list.length === 1 ? list[0] : null);
      if (found) { pick(found); return; }
    } catch { /* 아래로 떨어진다 */ }
    // 못 찾으면 이름만 올려두고 고르게 한다 — 멋대로 처음 오는 손님으로 만들지 않는다
    setHit(null); setIsNew(false); setQ(p.baby_name); setListOpen(true);
    setInfo(`${p.baby_name} — 지난 주문을 못 찾았어요. 뜨는 집을 고르거나 처음 오는 손님으로 넣어주세요`);
    setTimeout(() => nameRef.current?.focus(), 0);
  }

  /** 처리됨 표시 / 되돌리기 */
  async function markPend(id: string, done: boolean) {
    setPend(ps => ps.map(x => (x.id === id ? { ...x, done_at: done ? new Date().toISOString() : null } : x)));
    try {
      await fetch('/api/admin/pending-names', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, done }),
      });
    } catch { /* 표시만 못 바뀐 것이라 입력은 영향 없다 */ }
  }

  async function removePend(id: string) {
    setPend(ps => ps.filter(x => x.id !== id));
    try { await fetch(`/api/admin/pending-names?id=${id}`, { method: 'DELETE' }); } catch { /* 화면에서만 빠진다 */ }
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
    setErr(null); setInfo(null);

    // 넣기 전에 화면을 그대로 떠 둔다 — 되돌리기를 누르면 이걸 다시 올린다
    const snap: Snap = {
      deliveryDate, pendId: pendUsed, q: q.trim(), hit, isNew, nc: { ...nc },
      addrIdx, addrAdding, addrNew: { ...addrNew }, qty: copyQty(qty),
    };

    // 단골이면 지난 주문에서(고른 주소로), 처음이면 지금 치신 값에서
    const name = hit ? hit.babyName : q.trim();
    const addr = hit ? (chosenAddr ? fullAddr(chosenAddr) : '') : nc.address.trim();
    const phone = (hit ? hit.phone : ncPhone).replace(/\D/g, '');
    const months = hit ? (hit.guessMonths || hit.lastMonths) : Number(nc.months);
    const door = (hit ? chosenAddr?.doorPassword : nc.door.trim()) || null;
    const postal = hit ? chosenAddr?.postalCode ?? null : null;
    const orderType = hit?.orderType === '선결제' ? '선결제' : '일반';
    // 우편번호가 없으면 서버가 이 값으로 권역을 판정한다 (팩당 500원이 걸린다).
    // 주소마다 권역이 다를 수 있으므로 고른 주소의 값을 쓴다.
    const dm = hit ? chosenAddr?.deliveryMethod : null;
    const zone =
      dm === '직배송' || dm === '당일배송' || dm === '택배익일배송'
        ? dm
        : (/강서구|양천구/.test(addr) ? '직배송' : '당일배송');
    const receive = hit?.receiveMethod === '픽업' ? '픽업' : '배송';

    // 칸마다 주문 한 건. 전에는 한 건씩 차례로 보내고 다 끝나야 입력칸이 비워졌다 —
    // 칸이 셋이면 왕복 세 번을 기다렸다. 같이 보내고, 화면은 기다리지 않고 바로 비운다.
    const jobs = usedSlots.map(slot => {
      const menus: Record<string, number> = {};
      for (const m of MENU_TYPES) {
        const n = Number(qty[slot.key]?.[m]) || 0;
        if (n > 0) menus[m] = n;
      }
      return { slot, menus, total: slotTotal(slot.key) };
    });

    // 먼저 아래에 '넣는 중'으로 올려두고 입력칸을 비운다 — 다음 사람을 바로 치실 수 있게
    const key = SEQ++;
    const pid = pendUsed;
    setDone(d => [{
      key, name, date: deliveryDate, snap, pending: true,
      lines: jobs.map(j => ({ ...j, ok: false, pending: true })),
    }, ...d]);
    reset();

    const lines: Done['lines'] = await Promise.all(jobs.map(async ({ slot, menus, total }) => {
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
        return { slot, menus, total, ok, id: j.id, row: j.row,
                 error: ok ? undefined : (j.error || `실패 (${res.status})`) };
      } catch (e: any) {
        return { slot, menus, total, ok: false, error: e?.message || '네트워크 오류' };
      }
    }));

    setDone(ds => ds.map(x => (x.key === key ? { ...x, pending: false, lines } : x)));
    // 적어둔 이름에서 끌어온 사람이면 그 '할 일'은 끝났다 — 손으로 지우게 하지 않는다
    if (pid && lines.some(l => l.ok)) void markPend(pid, true);
    // 만들어진 줄을 그대로 넘긴다 — 아래 조리표가 주문 500건을 다시 받지 않고 바로 반영된다
    const rows = lines.map(l => l.row).filter(Boolean);
    if (rows.length) onSaved(rows);
    if (lines.some(l => !l.ok)) {
      setErr(`${name} — 안 들어간 칸이 있어요. 아래 '다시 올리기'를 눌러주세요`);
    }
  }

  /** 잘못 넣었을 때 — 그 주문을 취소하고, 넣었던 내용을 위 칸에 그대로 다시 올린다.
      지우는 버튼이 아니라 고치는 버튼이다. 내용이 사라지면 처음부터 다시 쳐야 하니
      이름·연락처·주소·팩수를 그대로 되돌려 두고, 고친 뒤 엔터를 치면 새로 들어간다.
      취소된 주문은 조리표·주소록에서 빠지므로 안 만들고 안 나간다.
      선결제 손님은 취소할 때 서버가 잔액을 되돌려주므로(applyCancelReversal)
      다시 넣어도 두 번 빠지지 않는다. */
  async function undo(d: Done) {
    const ids = d.lines.filter(l => l.ok && l.id).map(l => l.id!);
    if (!ids.length) return;

    // 이미 다음 사람을 치고 있으면 그게 날아간다 — 그때만 한 번 묻는다.
    // 되돌리는 사람이 지금 화면에 올라와 있는 사람이면 물을 일이 아니다.
    const typing = q.trim() !== '' || currentTotal > 0 || isNew;
    if (typing && q.trim() !== d.snap.q
        && !window.confirm(`지금 치고 있는 내용이 지워지고 ${d.name}이(가) 올라옵니다. 되돌릴까요?`)) return;

    setBusy(true); setErr(null); setInfo(null);
    let failed = 0;
    for (const id of ids) {
      try {
        const r = await fetch(`/api/orders/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: '취소' }),
        });
        if (!r.ok) failed++;
      } catch { failed++; }
    }
    setBusy(false);
    if (failed) {
      setErr(`${failed}건을 못 되돌렸어요 — 주문 탭에서 확인해주세요`);
    } else {
      setDone(ds => ds.map(x => (x.key === d.key ? { ...x, undone: true } : x)));
      // 적어둔 이름에서 온 것이면 다시 '할 일'로 돌려놓는다 — 아직 안 끝난 것이니
      if (d.snap.pendId) void markPend(d.snap.pendId, false);
      restore(d.snap);
      setInfo(`${d.name} — 취소했어요. 넣었던 내용을 위에 그대로 올려뒀으니 고친 뒤 엔터를 치면 다시 들어갑니다.`);
    }
    onSaved();
  }

  /* 조리갯수 (엑셀 '조리갯수' 시트 자리)

     ⚠️ 전에는 '이 화면에서 방금 넣은 것' 만 셌다. 그러면 아래 조리표와 숫자가 달라진다 —
        아래 조리표는 그날 주문 전부(손님이 직접 넣은 것, 어제 들어온 것, 다른 기기에서
        넣은 것)를 보여주기 때문이다. 담는 쪽이 쓰는 숫자가 두 가지면 그게 사고가 된다.
        이제 아래 조리표·담는 수량 프린트와 같은 자료(그날 주문 + slicesOn)로 센다.
        방금 넣은 몫은 각 줄에 '+n' 으로 따로 보여준다.

     미지정: 팩수는 있는데 메뉴를 안 적은 몫(카톡에 "300g 3팩" 만 적혀 온 경우).
             이걸 빼놓으면 합계가 조리표와 어긋나므로 칸을 따로 둔다. */
  const dayOrders = orders.filter(o => o && o.status !== '취소');
  const tally = SLOTS.map(s => {
    const counts: Record<string, number> = {};
    for (const m of MENU_TYPES) counts[m] = 0;
    let sum = 0;
    for (const o of dayOrders) {
      for (const sl of slicesOn(o as any, deliveryDate)) {
        if (slotKey(sl.stage, sl.volume) !== s.key) continue;
        for (const m of MENU_TYPES) counts[m] += sl.menus[m] || 0;
        sum += Number(sl.qty) || 0;
      }
    }
    // 이 화면에서 방금 넣은 몫 (되돌린 건 빠진다)
    let mine = 0;
    for (const d of done) {
      if (d.undone || d.date !== deliveryDate) continue;
      for (const l of d.lines) if (l.ok && l.slot.key === s.key) mine += l.total;
    }
    const named = MENU_TYPES.reduce((a, m) => a + counts[m], 0);
    return { slot: s, counts, sum, mine, unnamed: Math.max(0, sum - named) };
  });
  // 여덟 칸에 없는 줄(반찬세트, 옛 복합주문 등) — 합계가 조리표와 맞아야 하므로 같이 센다
  const extras = (() => {
    const map = new Map<string, number>();
    for (const o of dayOrders) {
      for (const sl of slicesOn(o as any, deliveryDate)) {
        const key = slotKey(sl.stage, sl.volume);
        if (SLOTS.some(x => x.key === key)) continue;
        const label = `${sl.stage ?? '-'}${sl.volume ? ` ${sl.volume}g` : ''}`;
        map.set(label, (map.get(label) || 0) + (Number(sl.qty) || 0));
      }
    }
    return [...map.entries()].map(([label, qty]) => ({ label, qty }));
  })();
  const grand = tally.reduce((a, t) => a + t.sum, 0) + extras.reduce((a, e) => a + e.qty, 0);
  const mineAll = tally.reduce((a, t) => a + t.mine, 0);

  const inp = 'rounded border border-stone-300 px-1.5 py-1 text-sm focus:border-amber-500 focus:outline-none';
  const onEnterConfirm = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); confirm(); }
  };

  return (
    <div className="bg-white rounded-xl border border-amber-200 overflow-hidden no-print mb-4">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-4 py-3 text-left">
        <span className="font-bold text-stone-900 text-sm">
          주문접수
          {grand > 0 && (
            <span className="ml-2 font-normal text-stone-500">
              이 날짜 {grand}팩
              {mineAll > 0 && <span className="ml-1 text-amber-700">(방금 {mineAll}팩)</span>}
            </span>
          )}
        </span>
        <span className="text-stone-400 text-xs">{open ? '접기' : '열기'}</span>
      </button>

      {open && (
        <div className="px-3 pb-4 border-t border-stone-100 pt-3">
          <div className="flex flex-wrap items-center gap-3 mb-3">
            {/* 화면 맨 위 날짜와 같은 칸이다. 여기서 바꾸면 위도 같이 바뀐다 */}
            <label className="flex items-center gap-2">
              <span className="text-xs font-medium text-stone-500">조리일</span>
              <input type="date" value={deliveryDate}
                onChange={e => { if (e.target.value) onDateChange(e.target.value); }}
                className="rounded border border-stone-300 px-2 py-1 text-sm" />
              <span className="text-sm font-bold text-stone-700">({dowOf(deliveryDate)})</span>
              <span className="text-[10px] text-stone-400">맨 위 날짜와 같은 칸</span>
            </label>
            <p className="text-[11px] text-stone-500 leading-snug">
              이름 → <b>엔터</b>로 집 고르기 → 칸에 팩수 → <b>엔터</b>면 저장. 칸 여러 개 같이 됩니다.
              잘못 넣었으면 오른쪽 <b>되돌리기</b> — 취소되고 넣었던 내용이 다시 올라옵니다.
            </p>
          </div>

          {/* 치는 곳(왼쪽)과 확인하는 곳(오른쪽)을 나란히 — 스크롤해야 합계가 보이면
              엔터를 칠 때마다 눈이 아래로 내려갔다 와야 한다 */}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_330px] items-start">
          <div>

          {/* ⓪ 카톡 주문서 — 읽을 수 있는 만큼만 읽어 아래 칸을 채운다. 저장은 사장님이 엔터로 */}
          <div className="mb-2">
            <textarea
              value={paste}
              onChange={e => applyPaste(e.target.value)}
              rows={paste ? 3 : 2}
              placeholder="카톡 주문서를 여기에 붙여넣으세요 — 읽은 만큼 아래 칸에 채워드립니다"
              className="w-full rounded border border-stone-300 px-2 py-1.5 text-[12px] leading-snug focus:border-amber-500 focus:outline-none"
            />
            {parsed && (
              <div className="mt-1 flex items-start gap-1.5">
                <div className="flex-1 min-w-0 text-[11px] text-stone-600 leading-snug">
                  <b className="text-stone-900">{parsed.baby_name || '이름 못 읽음'}</b>
                  {parsed.months && ` · ${parsed.months}개월`}
                  {parsed.delivery_date && ` · ${parsed.delivery_date}(${dowOf(parsed.delivery_date)})`}
                  {parsed.sets.length > 0 && (
                    <span className="ml-1 text-stone-500">
                      · {parsed.sets.map(s => {
                        const mm = MENU_TYPES.filter(m => s.menus[m]).map(m => `${menuLabel(m)}${s.menus[m]}`).join('·');
                        return `${s.stage.replace('단계', '')} ${s.volume}g ${mm || `${s.qty}팩(메뉴 없음)`}`;
                      }).join('  +  ')}
                    </span>
                  )}
                  {parsed.isBanchan && <span className="ml-1 text-amber-700 font-bold">반찬</span>}
                </div>
                <button onClick={fillFromParsed} disabled={busy}
                  className="flex-shrink-0 px-2.5 py-1 rounded bg-stone-800 text-white text-[11px] font-bold disabled:opacity-40">
                  아래에 채우기
                </button>
                <button onClick={() => { setPaste(''); setParsed(null); setPasteNote(null); }}
                  className="flex-shrink-0 px-2 py-1 rounded border border-stone-300 text-[11px] text-stone-500">
                  지우기
                </button>
              </div>
            )}
            {pasteNote && (
              <p className="mt-1 text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded px-2 py-1 leading-snug">
                {pasteNote}
              </p>
            )}
          </div>

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
              {/* 월·목을 같이 주문하셨을 때 — 목요일 자리에 이름만 적어둔다 */}
              <button onClick={() => { setParkOpen(o => !o); setPark({ date: '', name: (hit?.babyName || q).trim(), note: '' }); }}
                title="다른 날짜에 이름만 적어둡니다 — 그날 정리할 때 뜹니다"
                className={`px-2 py-1.5 rounded border text-[11px] whitespace-nowrap ${parkOpen ? 'border-sky-400 bg-sky-50 text-sky-800' : 'border-stone-300 text-stone-600 hover:bg-sky-50'}`}>
                + 다른 날
              </button>
              {(hit || isNew) && (
                <button onClick={reset} className="px-3 py-1.5 rounded border border-stone-300 text-xs text-stone-600">
                  지우기
                </button>
              )}
            </div>
            {hit && (
              <div className="mt-1 text-[11px] text-stone-600 space-y-1">
                <div className="flex items-center gap-1.5 flex-wrap text-stone-400">
                  <span>지난 주문 {hit.lastDate}</span>
                  {hit.stage && <span>· {hit.stage.replace('단계', '')} {hit.volume ?? ''}g</span>}
                  {hit.orderType === '선결제' && <span className="text-sky-700 font-bold">선결제</span>}
                </div>
                {/* 주소가 하나면 그냥 쓴다. 둘 이상일 때만 고른다 — 맨 위가 대표(가장 최근) */}
                <div className="flex items-center gap-1.5">
                  <span className="flex-shrink-0">📍</span>
                  {addrList.length > 1 && !usingNewAddr ? (
                    <select value={addrIdx} onChange={e => setAddrIdx(Number(e.target.value))}
                      className="flex-1 min-w-0 rounded border border-stone-300 px-1.5 py-1 text-[12px]">
                      {addrList.map((a, i) => (
                        <option key={i} value={i}>{fullAddr(a)}{i === 0 ? '  (대표)' : ''}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="flex-1 min-w-0 truncate">
                      {usingNewAddr ? addrNew.address.trim() : (chosenAddr ? fullAddr(chosenAddr) : '주소 없음')}
                      {usingNewAddr && <span className="ml-1 text-amber-700 font-bold">새 주소</span>}
                    </span>
                  )}
                  <button onClick={() => { setAddrAdding(v => !v); setAddrNew({ address: '', door: '' }); }}
                    className="flex-shrink-0 text-[11px] px-1.5 py-0.5 rounded border border-stone-300 text-stone-600 hover:bg-stone-50">
                    {addrAdding ? '취소' : '+ 주소'}
                  </button>
                </div>
                {addrAdding && (
                  <div className="grid grid-cols-3 gap-1">
                    <input value={addrNew.address} onChange={e => setAddrNew(v => ({ ...v, address: e.target.value }))}
                      onKeyDown={onEnterConfirm} placeholder="새 주소 (구 이름 포함)"
                      className={`${inp} col-span-2 text-[12px]`} />
                    <input value={addrNew.door} onChange={e => setAddrNew(v => ({ ...v, door: e.target.value.slice(0, 20) }))}
                      onKeyDown={onEnterConfirm} placeholder="현관비번" className={`${inp} text-[12px]`} />
                    <p className="col-span-3 text-[10px] text-stone-500">
                      이 주문에 쓰면 다음부터 위 목록에 뜹니다 — 따로 저장하실 필요 없어요.
                    </p>
                  </div>
                )}
              </div>
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

          {/* 다른 날 이름만 적어두기 — 주문이 아니라 그날 할 일이다 */}
          {parkOpen && (
            <div className="mb-2 rounded-lg border border-sky-300 bg-sky-50/60 p-2">
              <p className="text-[11px] font-bold text-sky-900 mb-1.5">
                다른 날 <b>이름만</b> 적어두기 — 주문으로 들어가지 않습니다. 그날 날짜를 고르면 오른쪽에 떠요.
              </p>
              <div className="flex flex-wrap gap-1 mb-1.5">
                {[1, 2, 3, 4, 5, 6, 7].map(n => {
                  const d = addDays(deliveryDate, n);
                  const on = park.date === d;
                  return (
                    <button key={n} onClick={() => setPark(v => ({ ...v, date: d }))}
                      className={`px-1.5 py-0.5 rounded text-[11px] border ${on ? 'bg-sky-600 text-white border-sky-600 font-bold' : 'bg-white border-stone-300 text-stone-600'}`}>
                      {Number(d.slice(5, 7))}/{Number(d.slice(8, 10))} {dowOf(d)}
                    </button>
                  );
                })}
              </div>
              <div className="grid grid-cols-[132px_1fr_1fr_auto] gap-1.5">
                <input type="date" value={park.date} onChange={e => setPark(v => ({ ...v, date: e.target.value }))}
                  className={`${inp} text-[12px]`} />
                <input value={park.name} onChange={e => setPark(v => ({ ...v, name: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addPark(); } }}
                  placeholder="아기 이름" className={`${inp} font-bold`} />
                <input value={park.note} onChange={e => setPark(v => ({ ...v, note: e.target.value.slice(0, 100) }))}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addPark(); } }}
                  placeholder="메모 (선택) — 예: 월·목 같이 주문" className={`${inp} text-[12px]`} />
                <button onClick={addPark} disabled={busy || !park.date || !park.name.trim()}
                  className="px-3 rounded bg-sky-600 text-white text-[12px] font-bold disabled:bg-stone-200 disabled:text-stone-400">
                  적어두기
                </button>
              </div>
            </div>
          )}

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
                {/* 칸 이름과 숫자칸이 멀면 눈이 가로로 왔다 갔다 한다 — 폭을 고정해 붙여 둔다 */}
                <tr className="bg-stone-50 text-[11px] text-stone-500">
                  <th className="text-left font-medium pl-2 pr-1 py-1 w-[88px]">칸</th>
                  {MENU_TYPES.map(m => <th key={m} className="font-medium py-1 w-12">{menuLabel(m)}</th>)}
                  <th className="font-medium py-1 w-9">합</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {SLOTS.map((s, i) => {
                  const t = slotTotal(s.key);
                  const newStage = i > 0 && SLOTS[i - 1].stage !== s.stage;
                  return (
                    <tr key={s.key}
                        className={`${newStage ? 'border-t-4 border-t-stone-300' : 'border-t border-stone-100'} ${t ? 'bg-amber-50/50' : ''}`}>
                      <td className="pl-2 pr-1 py-0.5 font-bold text-stone-700 whitespace-nowrap text-[13px]">
                        {s.stage.replace('단계', '')}
                        <span className={`ml-1 text-[12px] ${s.isBig ? 'text-red-600' : 'text-stone-500'}`}>{s.volume}</span>
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
                      <td></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {info && (
            <p className="mt-2 text-xs text-amber-900 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 flex items-start gap-2">
              <span className="flex-1">{info}</span>
              <button onClick={() => setInfo(null)} className="flex-shrink-0 text-amber-700/70 underline">닫기</button>
            </p>
          )}
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
            {/* 적어둔 이름 — 이 날짜에 미리 적어둔 '할 일'. 눌러서 그 자리에서 채운다 */}
            {pend.length > 0 && (() => {
              const left = pend.filter(p => !p.done_at);
              return (
                <div className="rounded-lg border border-sky-300 overflow-hidden">
                  <div className="px-2.5 py-1 bg-sky-100 border-b border-sky-200 flex items-baseline justify-between">
                    <span className="text-[13px] font-black text-sky-900">적어둔 이름</span>
                    <span className="text-[11px] text-sky-800">
                      {left.length ? `${left.length}명 남음` : '다 넣었어요'}
                    </span>
                  </div>
                  <div className="divide-y divide-sky-100 max-h-36 overflow-auto">
                    {pend.map(p => (
                      <div key={p.id} className={`px-2 py-1 flex items-center gap-1 ${p.done_at ? 'opacity-45' : ''}`}>
                        <button onClick={() => usePend(p)} disabled={busy}
                          title="이 이름을 위에 올립니다"
                          className="flex-1 min-w-0 text-left disabled:opacity-40">
                          <span className={`text-[13px] font-bold text-stone-900 ${p.done_at ? 'line-through' : ''}`}>
                            {p.baby_name}
                          </span>
                          {p.note && <span className="ml-1 text-[11px] text-stone-500">{p.note}</span>}
                        </button>
                        {p.done_at
                          ? <button onClick={() => markPend(p.id, false)} className="flex-shrink-0 text-[10px] text-stone-400 underline">되돌리기</button>
                          : <button onClick={() => markPend(p.id, true)} title="주문은 다른 데서 넣었을 때" className="flex-shrink-0 text-[10px] px-1 py-0.5 rounded border border-stone-300 text-stone-500">완료</button>}
                        <button onClick={() => removePend(p.id)} title="적어둔 것 지우기"
                          className="flex-shrink-0 text-[11px] text-stone-300 hover:text-rose-600 px-0.5">×</button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* 조리갯수 — 비어 있어도 자리를 지킨다. 칸이 움직이면 눈이 다시 찾아야 한다 */}
            <div className="rounded-lg border border-stone-300 overflow-hidden">
              <div className="px-2.5 py-1 bg-stone-100 border-b border-stone-200">
                <div className="flex items-baseline justify-between">
                  <span className="text-[13px] font-black text-stone-800">
                    조리갯수
                    <span className="ml-1 font-normal text-[11px] text-stone-500">
                      {Number(deliveryDate.slice(5, 7))}/{Number(deliveryDate.slice(8, 10))} {dowOf(deliveryDate)} 전체
                    </span>
                  </span>
                  <span className="text-[11px] text-stone-500">{dayOrders.length}명</span>
                </div>
                <p className="text-[10px] text-stone-400 leading-tight">
                  아래 조리표·담는 수량과 같은 숫자입니다
                  {mineAll > 0 && <span className="text-amber-700"> · 그중 방금 넣은 것 +{mineAll}팩</span>}
                </p>
              </div>
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-[10px] text-stone-400 bg-stone-50">
                    <th className="text-left font-medium px-2 py-0.5">칸</th>
                    {MENU_TYPES.map(m => <th key={m} className="font-medium py-0.5 w-8">{menuLabel(m)}</th>)}
                    <th className="font-medium py-0.5 w-8" title="팩수는 있는데 메뉴를 안 적은 몫">미정</th>
                    <th className="font-medium py-0.5 w-8">합</th>
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
                        <td className={`py-0.5 text-center ${t.unnamed ? 'text-rose-600 font-bold' : ''}`}>{t.unnamed || '·'}</td>
                        <td className="py-0.5 text-center font-bold">
                          {t.sum || '·'}
                          {t.mine > 0 && <span className="ml-0.5 text-[9px] font-normal text-amber-700">+{t.mine}</span>}
                        </td>
                      </tr>
                    );
                  })}
                  {/* 여덟 칸에 없는 줄 — 빼놓으면 합계가 조리표와 어긋난다 */}
                  {extras.map(e => (
                    <tr key={e.label} className="border-t border-stone-100 text-stone-500">
                      <td className="px-2 py-0.5 whitespace-nowrap text-[11px]">{e.label}</td>
                      <td colSpan={MENU_TYPES.length + 1} className="py-0.5 text-center text-[10px] text-stone-400">여기선 안 나눠요</td>
                      <td className="py-0.5 text-center font-bold">{e.qty}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-stone-400 bg-stone-50 font-black">
                    <td className="px-2 py-1">합계</td>
                    {MENU_TYPES.map(m => (
                      <td key={m} className="py-1 text-center">{tally.reduce((a, t) => a + t.counts[m], 0) || '·'}</td>
                    ))}
                    <td className="py-1 text-center">{tally.reduce((a, t) => a + t.unnamed, 0) || '·'}</td>
                    <td className="py-1 text-center text-amber-700">{grand || '·'}</td>
                  </tr>
                </tbody>
              </table>
              {tally.some(t => t.unnamed > 0) && (
                <p className="px-2 py-1 text-[10px] text-rose-700 bg-rose-50 border-t border-rose-200 leading-snug">
                  '미정' 은 팩수만 들어오고 메뉴를 안 적은 몫이에요 — 아래 조리표에서 <b>고치기</b>로 나눠주세요.
                </p>
              )}
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
                    <div key={d.key} className={`px-2.5 py-1 text-[12px] leading-snug flex items-start gap-1 ${d.undone ? 'opacity-40 line-through' : ''}`}>
                      <div className="flex-1 min-w-0">
                        <span className="font-bold text-stone-900">{d.name}</span>
                        {/* 다른 날짜에 넣은 줄은 날짜를 적어 둔다 — 조리갯수에는 안 들어간다 */}
                        {d.date !== deliveryDate && (
                          <span className="ml-1 text-[10px] text-sky-700 font-bold">
                            {Number(d.date.slice(5, 7))}/{Number(d.date.slice(8, 10))} {dowOf(d.date)}
                          </span>
                        )}
                        {d.lines.map((l, i) => (
                          <span key={i} className={`ml-1.5 ${l.pending ? 'text-stone-400' : l.ok ? 'text-stone-500' : 'text-rose-700 font-bold'}`}>
                            {l.slot.label} {MENU_TYPES.filter(m => l.menus[m]).map(m => `${menuLabel(m)}${l.menus[m]}`).join('·')}
                            {l.pending && ' 넣는 중…'}
                            {!l.pending && !l.ok && ` — ${l.error}`}
                          </span>
                        ))}
                      </div>
                      {/* 안 들어간 줄 — 내용만 위에 다시 올린다(취소할 주문이 없다) */}
                      {!d.pending && !d.undone && !d.lines.some(l => l.ok) && (
                        <button onClick={() => restore(d.snap)}
                          title="넣었던 내용을 위 칸에 다시 올립니다"
                          className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-rose-300 text-rose-700 font-bold">
                          다시 올리기
                        </button>
                      )}
                      {/* 잘못 넣었을 때 — 취소하고 내용을 위 칸에 그대로 올린다(고치는 버튼) */}
                      {!d.pending && !d.undone && d.lines.some(l => l.ok && l.id) && (
                        <button onClick={() => undo(d)} disabled={busy}
                          title="취소하고 넣었던 내용을 위 칸에 그대로 올립니다 — 고쳐서 다시 엔터"
                          className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-stone-300 text-stone-500 hover:bg-amber-50 hover:text-amber-800 hover:border-amber-300 disabled:opacity-40">
                          되돌리기
                        </button>
                      )}
                      {d.undone && <span className="flex-shrink-0 text-[10px] text-stone-400">위로 올림</span>}
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
