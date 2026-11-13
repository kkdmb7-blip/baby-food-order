'use client';
import { useEffect, useRef, useState } from 'react';
import {
  MENU_TYPES, menuLabel, BANCHAN_DOW, tierOf, banchanLineTotal,
  BANCHAN_STAGE, BANCHAN_SINGLE_STAGE, BANCHAN_SET_SIZE,
  BANCHAN_EXTRA_PRICE, BANCHAN_SINGLE_PRICE, BANCHAN_SINGLE_MAX,
  type StageType,
} from '@/lib/supabase';
import { SLOTS, slotKey, fitSlot, spreadPacks } from '@/lib/slots';
import { slicesOn } from '@/lib/orderItems';
import { looksDirectDelivery } from '@/lib/routeCode';
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

  여기서 다 된다 (전에는 아래 '조리표에 줄 넣기' 로 가야 했던 것들)
    반찬 세트 — 여덟 칸 아래 한 줄. 단계·용량이 없고 단가 체계가 다르다.
    픽업·권역·선결제·손님요청 — 그 아래 접힌 줄. 대개 지난 주문 그대로라 접어 뒀다.
    열지 않으면 지금까지와 똑같이 동작한다(지난 주문 값, 주소로 권역 짐작).
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

/**
 * 팩수 칸 — 숫자를 치거나 양옆 −/+ 로 올리고 내린다.
 * 키보드로 치는 게 가장 빠르지만, 한두 팩 더하거나 빼는 건 마우스가 편하다.
 *
 * 처음엔 ▲▼ 를 입력칸 오른쪽에 세로로 겹쳐 두었다. 작아서 마우스로 누르기 어려웠다.
 * 사장님: "화살표를 칸 양쪽으로 해서 가로로, 좀 키워서 마우스로 잘 누를 수 있게."
 * 그래서 [−] 숫자 [+] 모양이다. 단추 하나가 22px 폭에 칸 높이 전부라 누르기 쉽다.
 * 그만큼 칸이 넓어져서 여덟 칸 표의 왼쪽 패널을 320 → 360px 로 넓혔다
 * (칸 84 + 메뉴 세 칸 ~78 + 합 32 = ~350).
 */
function QtyCell({ value, onChange, onEnter, disabled, big }: {
  value: string;
  onChange: (v: string) => void;
  onEnter: (e: React.KeyboardEvent) => void;
  disabled?: boolean;
  big?: boolean;
}) {
  const n = Number(value) || 0;
  const step = (d: number) => onChange(d > 0 ? String(Math.min(99, n + 1)) : (n > 1 ? String(n - 1) : ''));
  const btn = `shrink-0 w-[22px] border border-stone-300 bg-stone-50 text-stone-600 font-black leading-none
               hover:bg-amber-100 hover:text-amber-800 active:bg-amber-200 disabled:opacity-30
               ${big ? 'text-base' : 'text-sm'}`;
  return (
    <div className="flex items-stretch">
      <button type="button" onClick={() => step(-1)} disabled={disabled} tabIndex={-1}
        title="한 팩 내리기" className={`${btn} rounded-l border-r-0`}>−</button>
      <input inputMode="numeric" disabled={disabled} value={value}
        onChange={e => onChange(e.target.value.replace(/\D/g, '').slice(0, 2))}
        onKeyDown={e => {
          // 위/아래 키로도 올리고 내린다
          if (e.key === 'ArrowUp') { e.preventDefault(); step(1); return; }
          if (e.key === 'ArrowDown') { e.preventDefault(); step(-1); return; }
          onEnter(e);
        }}
        className={`flex-1 min-w-0 w-0 border border-stone-300 px-0 py-1 text-center
                    text-sm focus:border-amber-500 focus:outline-none ${big ? 'text-base font-black' : ''}`} />
      <button type="button" onClick={() => step(1)} disabled={disabled} tabIndex={-1}
        title="한 팩 올리기" className={`${btn} rounded-r border-l-0`}>+</button>
    </div>
  );
}

/** 그 날짜가 든 주의 월~금 (요일 체크판의 다섯 칸) */
function weekDays(d: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return [];
  const t = new Date(d + 'T00:00:00Z');
  const dow = t.getUTCDay();                 // 일=0
  const mon = addDays(d, dow === 0 ? -6 : 1 - dow);
  return [0, 1, 2, 3, 4].map(i => addDays(mon, i));
}

/** 그 날짜에 기본으로 받을 것 — 수요일은 반찬, 나머지 조리일은 이유식 */
function modeFor(d: string): '이유식' | '반찬' {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '이유식';
  return new Date(d + 'T00:00:00Z').getUTCDay() === BANCHAN_DOW ? '반찬' : '이유식';
}

/**
 * 미리 적어둔 것. 팩수도 메뉴도 없는 '그날 할 일'이다.
 * delivery_date 가 null 이면 요일을 아직 안 고른 '이름 행' — 비고를 여기에 적는다.
 */
type Pend = {
  id: string; delivery_date: string | null; baby_name: string;
  customer_phone: string | null; note: string | null; done_at: string | null;
};

type Qty = Record<string, Record<string, string>>;   // slotKey → menu → 팩수

const copyQty = (q: Qty): Qty => Object.fromEntries(Object.entries(q).map(([k, v]) => [k, { ...v }]));

/** 넣을 때 화면에 있던 것 전부. 되돌리기를 누르면 이걸 그대로 다시 올린다 —
    되돌리기는 지우는 버튼이 아니라 고치는 버튼이라, 내용이 돌아와야 고칠 수 있다. */
/** 받는 방법·권역·주문종류·요청 — 대개 지난 주문 그대로라 접어 둔다 */
type Opts = {
  receive: '배송' | '픽업';
  zone: '' | '직배송' | '당일배송' | '택배익일배송';   // '' 면 주소·지난 주문으로 짐작
  orderType: '일반' | '선결제';
  request: string;
  months: string;     // '' 면 지난 주문으로 짐작한 개월수를 쓴다
};
const OPTS0: Opts = { receive: '배송', zone: '', orderType: '일반', request: '', months: '' };

/** 넣은 줄을 가리키는 이름표. 반찬 세트는 여덟 칸에 없으므로 칸 자체가 아니라 이름표만 쓴다 */
type LineSlot = { key: string; label: string };
const BANCHAN_SLOT: LineSlot = { key: '반찬세트|0', label: '반찬 세트' };

type Snap = {
  deliveryDate: string;
  pendId: string | null;      // 적어둔 이름에서 끌어온 것이면 그 id — 되돌리면 다시 '할 일'로 돌아간다
  opts: Opts;
  banchan: string;
  bQty: Record<string, string>;   // 반찬 종류별 개수
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
    slot: LineSlot; menus: Record<string, number>; total: number;
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

  // 권역 짐작 — 고른 주소로 지난번에 나간 방법, 없으면 강서·양천이면 직배송.
  // 사장님이 직접 고르셨으면(opts.zone) 그 값이 우선이다. 팩당 500원이 걸린다.
  const addrNow = hit ? (chosenAddr ? fullAddr(chosenAddr) : '') : nc.address.trim();
  // ⚠️ 주소 글자에 '강서구|양천구' 가 있는지만 보면, 구를 빼고 적어 보내는 주소
  //    ("서울 등촌로 195", "화곡동22")가 당일배송으로 잡혀 팩당 500원이 더 붙는다.
  //    사장님 배송 순번표로 동네를 확인한다(looksDirectDelivery).
  const zoneGuess: '직배송' | '당일배송' | '택배익일배송' =
    chosenAddr?.deliveryMethod === '택배익일배송'
      ? '택배익일배송'
      : (chosenAddr?.deliveryMethod === '직배송' || looksDirectDelivery(addrNow))
        ? '직배송'
        : '당일배송';

  /* 이유식 접수 / 반찬 접수 — 받는 모양이 아예 다르다(반찬은 단계·용량·메뉴가 없다).
     월·화·목·금은 이유식, 수요일은 반찬이 기본이다. 공휴일 때문에 요일이 바뀌는 주가 있어서
     옆에 전환 버튼을 둔다. 날짜를 옮기면 그 날짜의 기본값으로 돌아온다. */
  const [mode, setMode] = useState<'이유식' | '반찬'>(() => modeFor(date));
  useEffect(() => { setMode(modeFor(date)); }, [date]);

  /* 반찬 — 사장님 엑셀('수반찬 주문내역')을 보니 세트 한 덩어리가 아니었다.
     칸이 여섯 개(반찬 5 + 국 1)이고 손님마다 개수가 다르다.

        이름    소단치 한숙볶 닭크조 청김무 한잡채 국  합계
        곽원      1     0     1     1     1    2    6
        김우주    2     2     1     0     1    1    7

     그래서 세트 수 하나가 아니라 여섯 칸을 받는다. 대부분은 1씩이라 기본값을 1로 둔다.
     값은 세트 단위로 매겨지므로(기본 여섯 개 한 세트), 저장할 때 세트 수와 종류별 개수를
     같이 보낸다 — 금액은 세트 수로, 조리·포장은 종류별 개수로 쓴다. */
  const [banchan, setBanchan] = useState('');                      // 세트 수
  const [bMenu, setBMenu] = useState<{ name: string }[]>([]);      // 그날 반찬 5종 + 국
  const [bQty, setBQty] = useState<Record<string, string>>({});    // 칸 이름 → 개수
  // 받는 방법·권역·주문종류·요청 — 대개 지난 주문 그대로라 접어 둔다
  const [opts, setOpts] = useState<Opts>(OPTS0);
  const [optsOpen, setOptsOpen] = useState(false);

  // 카톡 주문서 붙여넣기 — 읽을 수 있는 만큼만 읽어 아래 칸을 채운다.
  // 멋대로 저장하지 않는다. 사장님이 보고 고친 뒤 엔터를 쳐야 들어간다.
  const [paste, setPaste] = useState('');
  const [parsed, setParsed] = useState<ParsedKakaoOrder | null>(null);
  const [pasteNote, setPasteNote] = useState<string | null>(null);

  // 적어둔 이름 — 요일 체크판(월~금)에 쓰는 것들
  const [pend, setPend] = useState<Pend[]>([]);
  const [pendUsed, setPendUsed] = useState<string | null>(null);   // 지금 치는 사람이 그 목록에서 왔으면 그 id
  const [newName, setNewName] = useState('');                      // 체크판에 줄 하나 더 만들기

  const [done, setDone] = useState<Done[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // 반찬 접수로 들어가면 그날 반찬 다섯 가지와 국을 불러와 칸 이름으로 쓴다
  useEffect(() => {
    if (!open || mode !== '반찬' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    let alive = true;
    (async () => {
      try {
        const d = await fetch(`/api/admin/banchan-menu?date=${date}`).then(r => r.json());
        if (!alive || !d.ok) return;
        const list = [...(d.items || []), ...(d.soup ? [d.soup] : [])].map((x: any) => ({ name: String(x.name) }));
        setBMenu(list);
        // 기본은 한 개씩 — 엑셀에서도 대부분 1·1·1·1·1·1 이다
        setBQty(Object.fromEntries(list.map(x => [x.name, '1'])));
        if (list.length) setBanchan(b => b || '1');
      } catch { /* 메뉴를 못 불러와도 세트 수로는 넣을 수 있다 */ }
    })();
    return () => { alive = false; };
  }, [date, open, mode]);

  // 그 주(월~금)에 적어둔 이름을 한 번에 불러온다 — 요일 체크판이 한 주를 보여준다
  const week = weekDays(date);
  useEffect(() => {
    if (!open || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const [a, b] = [weekDays(date)[0], weekDays(date)[4]];
    let alive = true;
    (async () => {
      try {
        const d = await fetch(`/api/admin/pending-names?from=${a}&to=${b}`).then(r => r.json());
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
    // 받는 방법·주문종류는 지난 주문 그대로 시작한다 (선결제 손님은 계속 선결제다)
    setOpts({
      receive: h.receiveMethod === '픽업' ? '픽업' : '배송',
      zone: h.deliveryMethod === '직배송' || h.deliveryMethod === '당일배송' || h.deliveryMethod === '택배익일배송'
        ? h.deliveryMethod : '',
      orderType: h.orderType === '선결제' ? '선결제' : '일반',
      request: '', months: '',
    });
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
    const autoFilled: string[] = []; // 메뉴를 안 적어 보내셔서 나눠 담은 것
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
      // 메뉴를 안 적어 보내셨으면 한우→닭→기타 순으로 나눠 담아 둔다.
      // 팩수조차 없으면 종류별 1팩. 비워 두면 사장님이 매번 손으로 채워야 한다.
      if (!sum) {
        const spread = spreadPacks(s.qty);
        for (const m of MENU_TYPES) if (spread[m]) row[m] = String(spread[m]);
        const shown = MENU_TYPES.filter(m => spread[m]).map(m => `${menuLabel(m)}${spread[m]}`).join('·');
        autoFilled.push(s.qty ? `${slot.label} ${s.qty}팩 → ${shown}` : `${slot.label} 팩수 없음 → ${shown}`);
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
    if (autoFilled.length) notes.push(`메뉴가 안 적혀 나눠 담았어요(고치실 수 있어요): ${autoFilled.join(', ')}`);
    // 반찬 주문서면 반찬 접수로 전환한다. 세트 수는 주문서에 또박또박 적히지 않아
    // 한 세트로 두고 확인하게 한다.
    if (p.isBanchan && !Object.keys(nq).length) {
      setMode('반찬'); setBanchan('1');
      notes.push('반찬(유아식)으로 읽어 반찬 접수로 바꿨어요 — 세트 수를 확인해주세요');
    } else if (Object.keys(nq).length && mode === '반찬') {
      setMode('이유식');
      notes.push('이유식 주문서라 이유식 접수로 바꿨어요');
    }
    if (unknown.length) notes.push(`못 넣은 칸: ${unknown.join(', ')}`);
    if (miss.length) notes.push(`못 읽음: ${miss.join('·')}`);
    setPasteNote(notes.join('  ·  '));
  }

  function reset() {
    setQ(''); setHit(null); setQty({}); setHits([]); setListOpen(false); setErr(null); setInfo(null);
    setPaste(''); setParsed(null); setPasteNote(null);
    setIsNew(false); setNc({ phone: '', address: '', months: '', door: '' });
    setAddrIdx(0); setAddrAdding(false); setAddrNew({ address: '', door: '' });
    setPendUsed(null);
    setBanchan(''); setOpts(OPTS0); setOptsOpen(false);
    // 반찬 칸은 비우지 않고 기본값(한 개씩)으로 되돌린다 — 다음 손님도 대개 그대로다
    setBQty(Object.fromEntries(bMenu.map(m => [m.name, '1'])));
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
    setBanchan(s.banchan); setOpts({ ...s.opts }); setBQty({ ...(s.bQty || {}) });
    setPaste(''); setParsed(null); setPasteNote(null);
    setErr(null);
    setTimeout(() => nameRef.current?.focus(), 0);
  }

  /* ── 적어둔 이름 ──────────────────────────────────────────────
     월·목을 같이 주문하셨을 때, 목요일 것까지 한 번에 치려면 시간이 너무 걸린다.
     목요일 자리에 이름만 적어두고 목요일에 카톡을 다시 보며 채우는 것이 원래 방식이다.
     주문으로 넣으면 0팩 주문이 조리표·매출에 섞이니 따로 둔다. */

  /** 적어두기 한 줄 넣기. date 가 null 이면 요일 없는 '이름 행' */
  async function addPend(name: string, phone: string | null, d: string | null) {
    const r = await fetch('/api/admin/pending-names', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delivery_date: d || '', baby_name: name, customer_phone: phone || '' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || '적어두기 실패');
    if (j.row) setPend(p => [...p, j.row]);
    return j.row as Pend | undefined;
  }

  /** 이름만 체크판에 올린다 — 요일은 안 골라도 된다 */
  async function addName(name: string, phone: string | null) {
    const nm = name.trim();
    if (!nm) return;
    if (pend.some(p => p.baby_name === nm)) return;   // 이미 판에 있다
    setErr(null);
    try { await addPend(nm, phone, null); }
    catch (e: any) { setErr(e?.message || '적어두기 실패'); }
  }

  /** 요일 칸을 눌렀을 때 — 비어 있으면 그 날로 적어두고, 체크돼 있으면 지운다 */
  async function toggleCell(name: string, phone: string | null, d: string) {
    const nm = name.trim();
    if (!nm || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    const found = pend.find(p => p.baby_name === nm && p.delivery_date === d);
    if (found) { void removePend(found.id); return; }
    setErr(null);
    try {
      // 비고를 적을 집(이름 행)이 없으면 같이 만들어 둔다
      if (!pend.some(p => p.baby_name === nm && !p.delivery_date)) await addPend(nm, phone, null);
      await addPend(nm, phone, d);
    } catch (e: any) { setErr(e?.message || '적어두기 실패'); }
  }

  /** 비고 — 이름 행에 적는다(요일마다 따로 적을 일이 아니다) */
  async function saveNote(name: string, phone: string | null, note: string) {
    const nm = name.trim();
    if (!nm) return;
    let row = pend.find(p => p.baby_name === nm && !p.delivery_date);
    setPend(ps => ps.map(x => (x.baby_name === nm && !x.delivery_date ? { ...x, note } : x)));
    try {
      if (!row) row = await addPend(nm, phone, null);
      if (!row) return;
      await fetch('/api/admin/pending-names', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.id, note }),
      });
    } catch { /* 비고만 못 적힌 것이라 입력은 영향 없다 */ }
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
    if (!id) return;
    setPend(ps => ps.map(x => (x.id === id ? { ...x, done_at: done ? new Date().toISOString() : null } : x)));
    try {
      await fetch('/api/admin/pending-names', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, done }),
      });
    } catch { /* 표시만 못 바뀐 것이라 입력은 영향 없다 */ }
  }

  /** 체크판에서 이름을 눌렀을 때 — 그 사람을 위 칸에 올린다(이름을 치고 집을 고른 것과 같다) */
  async function useName(name: string, phone: string | null) {
    const onDate = pend.find(p => p.baby_name === name && p.delivery_date === date && !p.done_at);
    if (onDate) return usePend(onDate);
    return usePend({
      id: '', delivery_date: date, baby_name: name,
      customer_phone: phone, note: null, done_at: null,
    });
  }

  async function removePend(id: string) {
    if (!id) return;
    setPend(ps => ps.filter(x => x.id !== id));
    try { await fetch(`/api/admin/pending-names?id=${id}`, { method: 'DELETE' }); } catch { /* 화면에서만 빠진다 */ }
  }

  const slotTotal = (k: string) => MENU_TYPES.reduce((a, m) => a + (Number(qty[k]?.[m]) || 0), 0);
  // 지금 받는 것만 센다 — 모드를 바꾸기 전에 쳐둔 숫자가 같이 들어가면 안 된다
  const usedSlots = mode === '이유식' ? SLOTS.filter(s => slotTotal(s.key) > 0) : [];
  const banchanQty = mode === '반찬' ? (Number(banchan) || 0) : 0;
  // 종류별 개수 합 — 기본은 여섯(반찬 5 + 국 1)이고, 바꾸는 손님은 다르다
  const bTotal = bMenu.reduce((a, m) => a + (Number(bQty[m.name]) || 0), 0);
  /* 반찬 값 — 사장님 확인(2026-11-12)
       세트  여섯 칸이 세트 값에 들어 있고 일곱째부터 개당 5,000원. 배송 가능.
       낱개  1~5개, 개당 6,000원. 픽업만.
     사장님이 종류별 개수를 치시는 자리라 추가분·낱개가 생기는 곳은 여기뿐이다.
     치는 동안 값이 보여야 더 받아야 하는 걸 놓치지 않는다. */
  const bTier = tierOf(opts.zone || zoneGuess);
  // 세트를 0으로 두고 종류별로만 담으면 낱개 주문이다
  const bIsSingle = banchanQty === 0 && bTotal > 0 && bTotal <= BANCHAN_SINGLE_MAX;
  const bStage = bIsSingle ? BANCHAN_SINGLE_STAGE : BANCHAN_STAGE;
  // 낱개는 qty 가 개수, 세트는 qty 가 세트 수다
  const bQtyForPrice = bIsSingle ? bTotal : banchanQty;
  const bIncluded = BANCHAN_SET_SIZE * banchanQty;
  const bExtra = banchanQty > 0 ? Math.max(0, bTotal - bIncluded) : 0;
  const bPrice = banchanLineTotal(bTier, bStage, bQtyForPrice, bTotal);
  // 세트 0 인데 여섯 개 이상 담은 경우 — 낱개로는 못 받는다(세트로 치셔야 한다)
  const bNeedsSet = banchanQty === 0 && bTotal > BANCHAN_SINGLE_MAX;
  // 낱개는 배송을 못 나간다. 사장님이 '배송'으로 두면 서버가 거부하므로 미리 막는다
  const bSingleNeedsPickup = bIsSingle && opts.receive !== '픽업';
  // 낱개도 받는 주문이다 — 세트 수만 세면 '넣기' 버튼이 안 열린다
  const currentTotal = usedSlots.reduce((a, s) => a + slotTotal(s.key), 0) + bQtyForPrice;
  const whoOk = hit ? true : (isNew && ncValid);
  const banchanBlocked = bNeedsSet || bSingleNeedsPickup;
  const canConfirm = whoOk && currentTotal > 0 && !busy && !banchanBlocked;

  async function confirm() {
    if (!canConfirm) {
      if (!whoOk) {
        setErr(isNew
          ? '연락처(10~11자리)·주소·개월수를 넣어주세요'
          : '이름을 쳐서 뜨는 집을 고르거나, 처음 오는 손님이면 "새 손님"을 눌러주세요');
      } else if (bNeedsSet) {
        setErr(`반찬 ${bTotal}개 — 낱개는 ${BANCHAN_SINGLE_MAX}개까지예요. ${BANCHAN_SET_SIZE}개부터는 세트 수를 넣어주세요`);
      } else if (bSingleNeedsPickup) {
        setErr(`반찬 ${bTotal}개는 배송이 안 돼요 — 세트(${BANCHAN_SET_SIZE}개)부터 배송됩니다. 받는 방법을 픽업으로 바꿔주세요`);
      } else if (currentTotal === 0) {
        setErr(mode === '반찬' ? '반찬 세트 수나 종류별 개수를 넣어주세요' : '팩수를 넣어주세요');
      }
      return;
    }
    setErr(null); setInfo(null);

    // 넣기 전에 화면을 그대로 떠 둔다 — 되돌리기를 누르면 이걸 다시 올린다
    const snap: Snap = {
      deliveryDate, pendId: pendUsed, q: q.trim(), hit, isNew, nc: { ...nc },
      addrIdx, addrAdding, addrNew: { ...addrNew }, qty: copyQty(qty),
      opts: { ...opts }, banchan, bQty: { ...bQty },
    };

    // 단골이면 지난 주문에서(고른 주소로), 처음이면 지금 치신 값에서
    const name = hit ? hit.babyName : q.trim();
    const addr = hit ? (chosenAddr ? fullAddr(chosenAddr) : '') : nc.address.trim();
    const phone = (hit ? hit.phone : ncPhone).replace(/\D/g, '');
    // 개월수는 지난 주문값 + 그 뒤 지난 달수로 짐작한다. 사장님이 고치셨으면 그 값.
    const months = hit
      ? (Number(opts.months) || hit.guessMonths || hit.lastMonths)
      : Number(nc.months);
    const door = (hit ? chosenAddr?.doorPassword : nc.door.trim()) || null;
    const postal = hit ? chosenAddr?.postalCode ?? null : null;
    const orderType = opts.orderType;
    const receive = opts.receive;
    // 우편번호가 없으면 서버가 이 값으로 권역을 판정한다 (팩당 500원이 걸린다).
    // 사장님이 고르셨으면 그 값을, 아니면 고른 주소의 지난 값, 그것도 없으면 주소로 짐작한다.
    const zone = opts.zone || zoneGuess;

    // 칸마다 주문 한 건. 전에는 한 건씩 차례로 보내고 다 끝나야 입력칸이 비워졌다 —
    // 칸이 셋이면 왕복 세 번을 기다렸다. 같이 보내고, 화면은 기다리지 않고 바로 비운다.
    type Job = {
      slot: LineSlot; menus: Record<string, number>; total: number;
      stage: StageType | null; volume: number | null; sets: any[];
    };
    const jobs: Job[] = usedSlots.map(slot => {
      const menus: Record<string, number> = {};
      for (const m of MENU_TYPES) {
        const n = Number(qty[slot.key]?.[m]) || 0;
        if (n > 0) menus[m] = n;
      }
      const total = slotTotal(slot.key);
      return {
        slot: { key: slot.key, label: slot.label }, menus, total,
        stage: slot.stage, volume: slot.volume,
        sets: [{
          stage: slot.stage, volume: slot.volume, simple: false, qty: total,
          menus: Object.entries(menus).map(([menu, n]) => ({ menu, qty: n })),
        }],
      };
    });
    /* 반찬 — 단계·용량이 없고 단가 체계가 따로다.
         세트  qty = 세트 수. 여섯 칸이 세트 값에 들어 있고 일곱째부터 개당 5,000원.
         낱개  qty = 개수(1~5). 개당 6,000원, 픽업만.
       종류별 개수는 menus 에 적어 조리·포장에서 쓴다. qty 에 종류별 합을 넣으면
       세트 주문이 여섯 배가 되므로 단위를 섞지 않는다. */
    if (bQtyForPrice > 0) {
      const bMenus = bMenu
        .map(m => ({ menu: m.name, qty: Number(bQty[m.name]) || 0 }))
        .filter(m => m.qty > 0);
      jobs.push({
        slot: bIsSingle ? { key: `${BANCHAN_SINGLE_STAGE}|0`, label: '반찬 낱개' } : BANCHAN_SLOT,
        menus: {}, total: bQtyForPrice, stage: null, volume: null,
        sets: [{ stage: bStage, volume: null, simple: true, menus: bMenus, qty: bQtyForPrice }],
      });
    }

    // 먼저 아래에 '넣는 중'으로 올려두고 입력칸을 비운다 — 다음 사람을 바로 치실 수 있게
    const key = SEQ++;
    const pid = pendUsed;
    setDone(d => [{
      key, name, date: deliveryDate, snap, pending: true,
      lines: jobs.map(j => ({ ...j, ok: false, pending: true })),
    }, ...d]);
    reset();

    const lines: Done['lines'] = await Promise.all(jobs.map(async ({ slot, menus, total, stage, volume, sets }) => {
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
            stage,
            volume,
            delivery_date: deliveryDate,
            order_type: orderType,
            receive_method: receive,
            delivery_method: receive === '픽업' ? '직배송' : zone,
            postal_code: postal || null,
            total_qty: total,
            customer_request: opts.request.trim() || null,
            items: [{ delivery_date: deliveryDate, sets, date_qty: total }],
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

  // 반찬 접수일 때 보는 숫자 — 그날 반찬 세트 합과 사람 수
  const banchanDay = dayOrders.reduce((a, o) =>
    a + slicesOn(o as any, deliveryDate)
      .filter(sl => sl.stage === '반찬세트')
      .reduce((b, sl) => b + (Number(sl.qty) || 0), 0), 0);
  const banchanPeople = dayOrders.filter(o =>
    slicesOn(o as any, deliveryDate).some(sl => sl.stage === '반찬세트')).length;
  // 요일 체크판의 줄 — 그 주에 적어둔 이름들(먼저 적어둔 순서)
  const boardRows = (() => {
    const m = new Map<string, { name: string; phone: string | null; note: string }>();
    for (const p of pend) {
      const prev = m.get(p.baby_name);
      m.set(p.baby_name, {
        name: p.baby_name,
        phone: prev?.phone || p.customer_phone,
        // 비고는 이름 행(날짜 없는 줄)에 있다
        note: (!p.delivery_date ? p.note : prev?.note) || prev?.note || '',
      });
    }
    return [...m.values()];
  })();

  const mineBanchan = done.reduce((a, d) =>
    a + (d.undone || d.date !== deliveryDate ? 0
      : d.lines.filter(l => l.ok && l.slot.key === BANCHAN_SLOT.key).reduce((b, l) => b + l.total, 0)), 0);

  const inp = 'rounded border border-stone-300 px-1.5 py-1 text-sm focus:border-amber-500 focus:outline-none';
  const onEnterConfirm = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); confirm(); }
  };

  return (
    <div className="bg-white rounded-xl border border-amber-200 overflow-hidden no-print mb-4">
      {/* 머리말 — 제목 옆에 '무엇을 받는 중인지' 와 전환 버튼.
          수요일은 반찬이 기본이고, 공휴일로 요일이 바뀌면 여기서 전환한다. */}
      <div className="flex items-center gap-2 px-4 py-3">
        <button onClick={() => setOpen(o => !o)} className="flex-1 min-w-0 text-left">
          <span className="font-bold text-stone-900 text-sm">
            주문접수
            {/* 어느 날짜에 넣는지 — 틀리면 제일 비싼 실수라 치는 자리 옆에 늘 띄워 둔다.
                바꾸는 칸은 맨 위 줄(sticky)에 하나뿐이다. */}
            <span className="ml-1.5 font-black text-amber-700">
              {Number(deliveryDate.slice(5, 7))}/{Number(deliveryDate.slice(8, 10))}({dowOf(deliveryDate)})
            </span>
            <span className={`ml-1.5 text-[11px] px-1.5 py-0.5 rounded font-bold align-middle ${
              mode === '반찬' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
              {mode}
            </span>
            {grand > 0 && (
              <span className="ml-2 font-normal text-stone-500">
                이 날짜 {grand}{mode === '반찬' ? '팩·세트' : '팩'}
                {mineAll > 0 && <span className="ml-1 text-amber-700">(방금 {mineAll}팩)</span>}
              </span>
            )}
          </span>
        </button>
        <button
          onClick={() => { setMode(m => (m === '이유식' ? '반찬' : '이유식')); setOpen(true); setErr(null); setInfo(null); }}
          title="공휴일 때문에 요일이 바뀐 주에 씁니다. 날짜를 옮기면 그 날짜의 기본값으로 돌아옵니다"
          className={`flex-shrink-0 px-2.5 py-1 rounded-lg border-2 text-[11px] font-bold ${
            mode === '이유식'
              ? 'border-emerald-300 text-emerald-800 hover:bg-emerald-50'
              : 'border-amber-300 text-amber-800 hover:bg-amber-50'}`}>
          {mode === '이유식' ? '반찬 접수로 전환' : '이유식 접수로 전환'}
        </button>
        <button onClick={() => setOpen(o => !o)} className="flex-shrink-0 text-stone-400 text-xs">
          {open ? '접기' : '열기'}
        </button>
      </div>

      {open && (
        <div className="px-3 pb-4 border-t border-stone-100 pt-3">
          {/* 조리일 칸은 뺐다 — 맨 위 날짜 줄이 sticky 라 스크롤해도 늘 보이고,
              여기서 바꾸면 그 줄이 바뀌는 같은 칸이었다. 날짜는 머리말에 글자로 남겼다.
              쓰는 법 설명도 뺐다 — 사장님 혼자 쓰는 화면이라 자리만 차지한다. */}

          {/* 치는 곳(왼쪽)과 확인하는 곳(오른쪽)을 나란히 — 스크롤해야 합계가 보이면
              엔터를 칠 때마다 눈이 아래로 내려갔다 와야 한다 */}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] items-start">
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
                /* 이름만 치는 칸이라 넓을 필요가 없다 — 넓으면 뒤 칸까지 눈이 가야 한다 */
                className={`${inp} w-[130px] text-base font-bold ${hit ? 'border-emerald-400 bg-emerald-50/50' : ''}`}
              />
              {/* '+ 다른 날' 버튼은 뺐다 — 오른쪽 요일 체크판에서 칸을 누르면 된다 */}
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

          {/* 다른 날 적어두기는 오른쪽 요일 체크판으로 옮겼다 */}

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

          {/* 치는 칸(왼쪽)과 그날 집계(오른쪽)를 나란히 — 입력칸 옆이 비어 있었다 */}
          <div className="flex flex-col sm:flex-row gap-3 items-start">
            <div className="w-full sm:w-[360px] flex-shrink-0">
          {/* ② 반찬 접수 — 단계·용량이 없다.
              세트 수를 넣으면 세트 주문, 세트를 0으로 두고 종류별로만 담으면
              낱개 주문(1~5개·개당 6,000원·픽업만)이다. */}
          {mode === '반찬' && (
            <div className={`rounded-lg border-2 p-3 ${bIsSingle ? 'border-amber-300 bg-amber-50/50' : 'border-emerald-300 bg-emerald-50/50'}`}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-bold text-emerald-900">세트</span>
                <div className="w-20">
                  <QtyCell disabled={busy} big value={banchan}
                    onChange={setBanchan} onEnter={onEnterConfirm} />
                </div>
                {bPrice > 0 && (
                  <span className={`text-[11px] font-bold ${bIsSingle ? 'text-amber-800' : 'text-emerald-900'}`}>
                    {bPrice.toLocaleString()}원
                    {bExtra > 0 && (
                      <span className="ml-1 font-normal text-amber-700">
                        (세트 {banchanQty} + 추가 {bExtra}개)
                      </span>
                    )}
                    {bIsSingle && (
                      <span className="ml-1 font-normal">낱개 {bTotal}개 · 픽업만</span>
                    )}
                  </span>
                )}
              </div>

              {/* 세트를 0으로 두면 낱개 주문이다. 받을 수 있는 조건을 바로 알려준다 —
                  안 그러면 다 치고 '넣기' 를 눌렀을 때 서버가 거부한다. */}
              {bNeedsSet && (
                <p className="mb-2 rounded bg-rose-50 border border-rose-200 px-2 py-1 text-[11px] font-bold text-rose-700">
                  반찬 {bTotal}개 — 낱개는 {BANCHAN_SINGLE_MAX}개까지예요.
                  {BANCHAN_SET_SIZE}개부터는 위 세트 칸에 세트 수를 넣어주세요.
                </p>
              )}
              {bSingleNeedsPickup && (
                <p className="mb-2 rounded bg-amber-50 border border-amber-300 px-2 py-1 text-[11px] font-bold text-amber-800">
                  낱개 {bTotal}개는 배송이 안 돼요 — 세트({BANCHAN_SET_SIZE}개)부터 배송됩니다.
                  아래 '받는 방법'을 픽업으로 바꿔주세요.
                </p>
              )}
              {bIsSingle && !bSingleNeedsPickup && (
                <p className="mb-2 rounded bg-amber-50 border border-amber-200 px-2 py-1 text-[11px] font-bold text-amber-800">
                  낱개 {bTotal}개 · 개당 {BANCHAN_SINGLE_PRICE.toLocaleString()}원 — 픽업으로 받습니다.
                </p>
              )}

              {/* 여섯 칸 — 반찬 다섯 가지와 국. 대부분 1씩이고, 바꾸는 분만 숫자를 고친다 */}
              {bMenu.length > 0 ? (
                <div className="rounded border border-emerald-200 bg-white overflow-hidden">
                  {/* 메뉴 안에서는 얼마든지 바꿔 담으신다 — 한 종류로 6개도, 2·2·2 도 된다.
                      칸이 전부 1로 차 있으면 몰아 담을 때 다섯 칸을 지워야 해서
                      한 번에 비우고 한 번에 1씩 채우는 버튼을 둔다. */}
                  <div className="flex items-center gap-1 border-b border-emerald-200 bg-emerald-50/60 px-2 py-1">
                    <span className="text-[10px] text-stone-500 flex-1">종류별로 자유롭게</span>
                    <button type="button" disabled={busy}
                      onClick={() => setBQty(Object.fromEntries(bMenu.map(m => [m.name, '1'])))}
                      className="rounded border border-stone-300 bg-white px-1.5 py-0.5 text-[10px] font-bold text-stone-600 hover:bg-stone-50">
                      1씩
                    </button>
                    <button type="button" disabled={busy}
                      onClick={() => setBQty({})}
                      className="rounded border border-stone-300 bg-white px-1.5 py-0.5 text-[10px] font-bold text-stone-600 hover:bg-stone-50">
                      비우기
                    </button>
                  </div>
                  <table className="w-full text-sm">
                    <tbody>
                      {bMenu.map((m, i) => (
                        <tr key={m.name} className={i > 0 ? 'border-t border-stone-100' : ''}>
                          <td className="pl-2 py-0.5 text-[13px] font-bold text-stone-700">
                            {/* 번호는 손님이 받는 메뉴표와 같다 — "3번 두 개, 4번 빼고" 로 주문이 온다 */}
                            <span className="text-stone-400 mr-1">{i + 1}.</span>
                            {i === bMenu.length - 1 && /국|탕/.test(m.name)
                              ? <span className="text-emerald-700">국 · {m.name}</span>
                              : m.name}
                          </td>
                          <td className="py-0.5 px-1 w-[76px]">
                            <QtyCell disabled={busy}
                              value={bQty[m.name] ?? ''}
                              onChange={v => setBQty(x => ({ ...x, [m.name]: v }))}
                              onEnter={onEnterConfirm} />
                          </td>
                        </tr>
                      ))}
                      {/* 여섯 칸이 세트 값이다. 넘으면 개당 5,000원을 더 받아야 하니
                          모자란 쪽(덜 담김)과 넘는 쪽(추가금)을 다르게 알려준다. */}
                      <tr className="border-t-2 border-emerald-300 bg-emerald-50">
                        <td className="pl-2 py-1 text-[12px] font-black text-emerald-900">합계</td>
                        <td className="py-1 text-center font-black text-emerald-900">
                          {bTotal}
                          {banchanQty > 0 && bExtra > 0 && (
                            <span className="ml-1 text-[10px] font-bold text-amber-700">
                              +{bExtra}개 · {(bExtra * BANCHAN_EXTRA_PRICE).toLocaleString()}원
                            </span>
                          )}
                          {banchanQty > 0 && bTotal > 0 && bTotal < bIncluded && (
                            <span className="ml-1 text-[10px] font-bold text-stone-500">
                              {bIncluded}까지 세트값
                            </span>
                          )}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-[11px] text-stone-500">
                  이 날짜의 반찬 메뉴를 못 불러왔어요 — 세트 수만으로 넣습니다.
                  (메뉴관리에서 그 주 식단을 올리면 여기에 칸이 생깁니다)
                </p>
              )}
            </div>
          )}

          {/* ② 여덟 칸 (이유식 접수) */}
          {mode === '이유식' && (
          <div className="rounded-lg border border-stone-300 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                {/* 칸 이름과 숫자칸이 멀면 눈이 가로로 왔다 갔다 한다 — 폭을 고정해 붙여 둔다 */}
                <tr className="bg-stone-50 text-[11px] text-stone-500">
                  <th className="text-left font-medium pl-2 pr-1 py-1 w-[84px]">칸</th>
                  {MENU_TYPES.map(m => <th key={m} className="font-medium py-1">{menuLabel(m)}</th>)}
                  <th className="font-medium py-1 w-8">합</th>
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
                          <QtyCell disabled={busy}
                            value={qty[s.key]?.[m] || ''}
                            onChange={v => setQty(x => ({ ...x, [s.key]: { ...(x[s.key] || {}), [m]: v } }))}
                            onEnter={onEnterConfirm} />
                        </td>
                      ))}
                      <td className="text-center font-bold text-stone-700">{t || ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          )}
            </div>
            <div className="w-full sm:flex-1 min-w-0">
            {/* 반찬 접수일 때 — 여덟 칸 표는 뜻이 없다. 그날 세트 수만 본다 */}
              {mode === '반찬' && (
                <div className="rounded-lg border-2 border-emerald-300 overflow-hidden">
                  <div className="px-2.5 py-1 bg-emerald-100 border-b border-emerald-200 flex items-baseline justify-between">
                    <span className="text-[13px] font-black text-emerald-900">
                      반찬 세트
                      <span className="ml-1 font-normal text-[11px] text-emerald-800">
                        {Number(deliveryDate.slice(5, 7))}/{Number(deliveryDate.slice(8, 10))} {dowOf(deliveryDate)} 전체
                      </span>
                    </span>
                    <span className="text-[11px] text-emerald-800">{banchanPeople}명</span>
                  </div>
                  <div className="px-3 py-3 text-center">
                    <div className="text-3xl font-black text-emerald-900">{banchanDay}</div>
                    <div className="text-[11px] text-stone-500">
                      세트
                      {mineBanchan > 0 && <span className="ml-1 text-amber-700 font-bold">(방금 +{mineBanchan})</span>}
                    </div>
                  </div>
                </div>
              )}

              {/* 조리갯수 — 비어 있어도 자리를 지킨다. 칸이 움직이면 눈이 다시 찾아야 한다 */}
              {mode === '이유식' && (
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
                  {mineAll > 0 && (
                    <p className="text-[10px] text-amber-700 leading-tight">그중 방금 넣은 것 +{mineAll}팩</p>
                  )}
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
              )}
            </div>
          </div>

          {/* 받는 방법·권역·주문종류·요청 — 대개 지난 주문 그대로여서 접어 둔다.
              열지 않으면 지금까지와 똑같이 동작한다(지난 주문 값, 주소로 권역 짐작). */}
          <div className="mt-2 rounded-lg border border-stone-200 bg-stone-50/60">
            <button onClick={() => setOptsOpen(o => !o)}
              className="w-full flex items-center justify-between px-2 py-1 text-left">
              <span className="text-[11px] text-stone-600">
                {opts.receive === '픽업' ? <b className="text-emerald-700">픽업</b> : '배송'}
                {opts.receive === '배송' && <span className="ml-1 text-stone-500">{opts.zone || `${zoneGuess} (짐작)`}</span>}
                {opts.orderType === '선결제' && <b className="ml-1.5 text-sky-700">선결제</b>}
                {opts.request.trim() && <span className="ml-1.5 text-amber-700">요청 있음</span>}
                {hit && opts.months && <span className="ml-1.5 text-stone-500">{opts.months}개월</span>}
              </span>
              <span className="text-[10px] text-stone-400">{optsOpen ? '접기' : '픽업·선결제·권역·개월수·요청'}</span>
            </button>
            {optsOpen && (
              <div className="px-2 pb-2 space-y-1.5">
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-[10px] text-stone-500 w-12">받는 법</span>
                  {(['배송', '픽업'] as const).map(v => (
                    <button key={v} onClick={() => setOpts(o => ({ ...o, receive: v }))}
                      className={`px-2 py-0.5 rounded text-[11px] border ${opts.receive === v ? 'bg-stone-800 text-white border-stone-800 font-bold' : 'bg-white border-stone-300 text-stone-600'}`}>
                      {v}
                    </button>
                  ))}
                  {opts.receive === '픽업' && <span className="text-[10px] text-stone-500">배송 안 나가고 기본가로 계산됩니다</span>}
                </div>
                {opts.receive === '배송' && (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-[10px] text-stone-500 w-12">권역</span>
                    {([['', `짐작 (${zoneGuess})`], ['직배송', '직배송'], ['당일배송', '당일배송'], ['택배익일배송', '택배익일']] as const).map(([v, label]) => (
                      <button key={v} onClick={() => setOpts(o => ({ ...o, zone: v }))}
                        className={`px-2 py-0.5 rounded text-[11px] border ${opts.zone === v ? 'bg-stone-800 text-white border-stone-800 font-bold' : 'bg-white border-stone-300 text-stone-600'}`}>
                        {label}
                      </button>
                    ))}
                    <span className="text-[10px] text-stone-500">직배송 아니면 팩당 +500원</span>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-[10px] text-stone-500 w-12">종류</span>
                  {(['일반', '선결제'] as const).map(v => (
                    <button key={v} onClick={() => setOpts(o => ({ ...o, orderType: v }))}
                      className={`px-2 py-0.5 rounded text-[11px] border ${opts.orderType === v ? 'bg-sky-700 text-white border-sky-700 font-bold' : 'bg-white border-stone-300 text-stone-600'}`}>
                      {v === '선결제' ? '선결제 (잔여 차감)' : v}
                    </button>
                  ))}
                  {opts.orderType === '선결제' && (
                    <span className="text-[10px] text-stone-500">고객관리에 충전된 잔여에서 팩수만큼 빠집니다</span>
                  )}
                </div>
                {/* 개월수 — 아기는 자라니 지난 주문값 그대로면 틀린다. 짐작값을 보여주고 고치게 한다 */}
                {hit && (
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-stone-500 w-12">개월수</span>
                    <input inputMode="numeric" value={opts.months}
                      onChange={e => setOpts(o => ({ ...o, months: e.target.value.replace(/\D/g, '').slice(0, 2) }))}
                      onKeyDown={onEnterConfirm}
                      placeholder={String(hit.guessMonths || hit.lastMonths || '')}
                      className={`${inp} w-16 text-center`} />
                    <span className="text-[10px] text-stone-500">
                      비워두면 {hit.guessMonths || hit.lastMonths}개월 (지난 주문 {hit.lastDate} {hit.lastMonths}개월 기준)
                    </span>
                  </div>
                )}
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-stone-500 w-12">요청</span>
                  <input value={opts.request}
                    onChange={e => setOpts(o => ({ ...o, request: e.target.value.slice(0, 200) }))}
                    onKeyDown={onEnterConfirm}
                    placeholder="손님 요청 (선택)" className={`${inp} flex-1 text-[12px]`} />
                </div>
              </div>
            )}
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
              : canConfirm
                ? (mode === '반찬'
                    ? `확인 — ${hit ? hit.babyName : q.trim()} 반찬 ${bIsSingle ? `낱개 ${bTotal}개` : `${banchanQty}세트`} · ${bPrice.toLocaleString()}원  ⏎`
                    : `확인 — ${hit ? hit.babyName : q.trim()} ${currentTotal}팩 (칸 ${usedSlots.length}개)  ⏎`)
              : bNeedsSet ? `${BANCHAN_SET_SIZE}개부터는 세트 수를 넣어주세요`
              : bSingleNeedsPickup ? '낱개는 픽업으로만 받을 수 있어요'
              : isNew ? `연락처·주소·개월수와 ${mode === '반찬' ? '세트 수' : '팩수'}를 넣어주세요`
              : `이름 고르고 ${mode === '반찬' ? '세트 수' : '팩수'}를 넣어주세요`}
          </button>

          </div>

          {/* 오른쪽 — 치면서 바로 보는 곳. 붙여 두어서 스크롤 없이 확인된다 */}
          <div className="lg:sticky lg:top-3 space-y-2">
            {/* 요일 체크판 — 월·목을 같이 주문하신 손님을 미리 체크해 두고,
                그날 정리할 때 다시 본다. 주문이 아니라 '그날 할 일' 이다.
                칸을 누르면 적어두고, 체크된 칸을 누르면 지운다.
                주문이 들어가면 ✓ 가 회색으로 바뀐다(markPend). */}
            <div className="rounded-lg border border-sky-300 overflow-hidden">
              <div className="px-2 py-1 bg-sky-100 border-b border-sky-200 flex items-baseline justify-between">
                <span className="text-[12px] font-black text-sky-900">미리 적어두기</span>
                {/* 요일이 체크된 것 중 아직 주문 안 들어간 것만 센다 (이름만 올려둔 줄은 할 일이 아니다) */}
                <span className="text-[10px] text-sky-800">
                  {(() => {
                    const n = pend.filter(p => p.delivery_date && !p.done_at).length;
                    return n ? `${n}건 남음` : '남은 것 없음';
                  })()}
                </span>
              </div>
              <table className="w-full text-[12px] table-fixed">
                <thead>
                  <tr className="bg-sky-50 text-[10px] text-sky-900">
                    <th className="text-left font-medium pl-1.5 py-1 w-[62px]">이름</th>
                    {week.map(d => (
                      <th key={d} className={`font-bold py-1 w-[34px] text-[12px] ${d === deliveryDate ? 'bg-sky-200' : ''}`}>
                        {Number(d.slice(8, 10))}{dowOf(d)}
                      </th>
                    ))}
                    <th className="font-medium py-1 text-left pl-1">비고</th>
                    <th className="w-4"></th>
                  </tr>
                </thead>
                <tbody>
                  {boardRows.map(r => (
                    <tr key={r.name} className="border-t border-sky-100">
                      {/* 이름을 누르면 그 사람이 위 칸에 올라온다 */}
                      <td className="pl-1.5 py-0.5">
                        <button onClick={() => useName(r.name, r.phone)} disabled={busy}
                          title="이 이름을 위에 올립니다"
                          className="w-full text-[12px] font-bold text-stone-900 hover:text-sky-700 disabled:opacity-40 truncate text-left">
                          {r.name}
                        </button>
                      </td>
                      {week.map(d => {
                        const cell = pend.find(p => p.baby_name === r.name && p.delivery_date === d);
                        const done = !!cell?.done_at;
                        return (
                          <td key={d} className={`py-0.5 text-center ${d === deliveryDate ? 'bg-sky-50' : ''}`}>
                            <button onClick={() => toggleCell(r.name, r.phone, d)}
                              title={done ? '주문이 들어갔어요 (눌러서 지우기)' : cell ? '적어둔 것 (눌러서 지우기)' : '여기에 적어두기'}
                              className={`w-[24px] h-[24px] rounded border text-[13px] font-black leading-none ${
                                done ? 'bg-stone-200 border-stone-300 text-stone-500'
                                : cell ? 'bg-sky-600 border-sky-600 text-white'
                                : 'bg-white border-stone-300 text-transparent hover:border-sky-400'}`}>
                              ✓
                            </button>
                          </td>
                        );
                      })}
                      {/* 비고 — 이름 행에 적힌다 */}
                      <td className="py-0.5 pl-1">
                        <input
                          key={r.name + (r.note || '')}
                          defaultValue={r.note || ''}
                          onBlur={e => { if (e.target.value !== (r.note || '')) void saveNote(r.name, r.phone, e.target.value); }}
                          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                          maxLength={100}
                          className="w-full bg-transparent border border-transparent rounded px-1 text-[11px]
                                     hover:border-stone-200 focus:border-sky-400 focus:bg-white outline-none" />
                      </td>
                      <td className="text-center">
                        {/* 그 사람 줄을 통째로 지운다 */}
                        <button onClick={() => { for (const p of pend.filter(x => x.baby_name === r.name)) void removePend(p.id); }}
                          title="이 줄 지우기" className="text-[11px] text-stone-300 hover:text-rose-600">×</button>
                      </td>
                    </tr>
                  ))}
                  {boardRows.length === 0 && (
                    <tr><td colSpan={week.length + 3} className="px-2 py-2 text-center text-[11px] text-stone-400">
                      아래에 이름을 넣으세요 — 요일은 나중에 체크해도 됩니다
                    </td></tr>
                  )}
                </tbody>
              </table>
              <div className="flex gap-1 p-1.5 border-t border-sky-100 bg-sky-50/50">
                {/* 이름만 넣으면 바로 줄이 생긴다 — 요일은 안 골라도 된다 */}
                <input value={newName} onChange={e => setNewName(e.target.value.slice(0, 20))}
                  onKeyDown={e => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    const nm = newName.trim();
                    if (nm) { void addName(nm, null); setNewName(''); }
                  }}
                  placeholder="이름 넣고 엔터 (요일은 나중에)"
                  className={`${inp} flex-1 min-w-0 text-[12px] py-0.5`} />
                {/* 지금 치고 있는 사람을 한 번에 — 월요일 치면서 목요일 체크할 때 */}
                {(hit?.babyName || q.trim()) && !boardRows.some(r => r.name === (hit?.babyName || q.trim())) && (
                  <button onClick={() => addName(hit?.babyName || q.trim(), hit?.phone || null)}
                    title="지금 치고 있는 사람을 체크판에 올립니다"
                    className="flex-shrink-0 px-2 rounded bg-sky-600 text-white text-[11px] font-bold">
                    + {hit?.babyName || q.trim()}
                  </button>
                )}
              </div>
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
