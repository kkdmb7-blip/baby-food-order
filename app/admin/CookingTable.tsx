'use client';
import { useState, type ReactNode } from 'react';
import { MENU_TYPES, menuLabel } from '@/lib/supabase';
import { BIG_VOLUME, SMALL_VOLUME, type CookingSheet, type PersonRow } from '@/lib/cookingSheet';
import { AddRow } from './InlineAdd';

/*
  조리표 한 장 — 화면과 종이가 같은 모양을 쓴다.

  전에는 화면 조리표가 따로 그려져 있었다(단계·용량으로 묶은 목록 + 메뉴 합계).
  담는 사람은 종이를 보고, 고치는 사람은 화면을 보는데 두 모양이 달라서 서로 대조가 안 됐다.
  이제 둘 다 이 컴포넌트다. 화면에서는 이름을 눌러 고칠 수 있게 onPick 을 받는다.

  읽는 법
    블록 = 단계. 한 블록을 다 챙기고 다음 블록으로 넘어간다.
    빨간 숫자 = 큰 용량(310/300g). 블록 맨 아래 두 줄이 용량별 합계 — 그만큼 만들면 된다.
    이름 앞 +  = 다른 단계도 같이 시킨 사람(포장 때 한 봉투로)
    이름 뒤 *  = 알레르기
    '미지정'   = 팩수는 있는데 메뉴가 안 정해진 몫
*/

/** 입금 체크판 — 조리표와 같은 표에 입금 여부만 칠한다 (사장님: "조리표랑 똑같이 해서 체크만") */
export type PayState = 'paid' | 'unpaid' | 'openworld' | 'prepaid' | 'skip' | 'postpaid';
const PAY_BG: Record<PayState, string> = {
  paid: 'bg-emerald-200', unpaid: 'bg-white text-rose-700', openworld: 'bg-sky-100 text-sky-900',
  prepaid: 'bg-violet-100 text-violet-900', skip: 'bg-stone-100 text-stone-500',
  postpaid: 'bg-orange-100 text-orange-800', // 후불 손님 — 아직 안 받은 주문
};

export default function CookingTable({ sheet, onPick, onSaved, printedAt, pay, add }: {
  sheet: CookingSheet;
  /** 입금 체크판으로 쓸 때 — 이름 칸 색이 입금 상태가 되고, 이름을 누르면 입금확인을 켜고 끈다.
      tag: 이름 옆 작은 빨간 꼬리표(선결제 마이너스 '−7' 등) */
  pay?: { state: (orderId: string) => PayState; onToggle: (orderId: string) => void; onOpen?: (orderId: string) => void; tag?: (orderId: string) => string | null };
  /** 화면에서만 — 단계 블록 맨 아래 추가 줄(이름·230/300·팩수 → Enter). 종이에 손으로 적은 아이를 그 자리에서 넣는다 */
  add?: { date: string; onAdded: (row: any) => void };
  /** 화면에서만 — 이름을 누르면 그 사람 것을 고친다(여덟 칸 전부 열림) */
  onPick?: (phone: string, orderId: string) => void;
  /** 화면에서만 — 숫자를 칸에서 바로 고친다. 저장되면 부른다 */
  onSaved?: () => void;
  /** 프린트한 시각. 그 뒤에 들어온 줄에 '추가' 를 붙인다 */
  printedAt?: string | null;
}) {
  /* 숫자를 칸에서 바로 고치기 (화면에서만).
     이름을 눌러 여는 판은 그대로 둔다 — 단계를 새로 추가하거나 선결제 잔여를 보려면 그쪽이 낫다.
     여기서는 이미 있는 줄의 팩수만 바꾼다. 서버가 금액·배송비·적립·선결제 잔여를 다시 맞춘다. */
  const [draft, setDraft] = useState<Record<string, Record<string, string>>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // 한 주문이 그날 두 줄로 들어간 옛 복합주문은 칸에서 못 고친다(어느 줄인지 서버가 가릴 수 없다)
  const rowCount = new Map<string, number>();
  for (const sec of sheet.sections) {
    if (sec.part !== 1) continue;
    for (const p of sheet.sections.filter(s => s.stage === sec.stage).flatMap(s => s.list)) {
      rowCount.set(p.orderId, (rowCount.get(p.orderId) || 0) + 1);
    }
  }
  const editable = (p: PersonRow) => !pay && !!onSaved && (rowCount.get(p.orderId) || 0) <= 1;
  // 이름 칸 — 입금 체크판이면 입금 상태 색 + 누르면 체크, 아니면 원래대로(여러 단계 색 + 누르면 고치기)
  const nameCell = (orderId: string, phone: string, color: number | undefined, node: ReactNode, base: string) => {
    if (pay) {
      const st = pay.state(orderId);
      const tag = pay.tag?.(orderId);
      return (
        <td className={`${base} ${PAY_BG[st]} relative`}>
          {/* 이름 = 입금확인 켜고 끄기, 오른쪽 끝 ▸ = 판 열기 — 둘 다 한 번에 (사장님 2026-11-14) */}
          {pay.onOpen && (
            <button onClick={() => pay.onOpen!(orderId)} title="판 열기 — 선결제·택배비·정보"
              className="absolute inset-y-0 right-0 w-5 flex items-center justify-center text-[16px] leading-none text-violet-400 hover:text-violet-800 hover:bg-violet-100/80 print:hidden">▸</button>
          )}
          {/* 마이너스(입금 요청)는 이름 줄 밖, 왼쪽 위 모서리에 작게 — ▸ 와 겹쳐 안 보이고, '추가' 와 같이 있으면 두 줄이 되던 것
              (사장님 2026-11-14 "화살표랑 마이너스 겹치면 안 보여", "황도현은 추가랑 마이너스가 같이 있어 2줄") */}
          {tag && <span className="absolute top-0 left-0 z-10 px-[2px] rounded-br bg-red-500 text-white text-[9px] leading-[11px] font-black pointer-events-none">{tag}</span>}
          <button onClick={() => pay.onToggle(orderId)} title="눌러서 입금확인 켜기/끄기"
            className="w-full text-center whitespace-nowrap hover:underline">
            {st === 'paid' && <span className="text-emerald-800 font-black">✓</span>}
            {/* 선결제에서 뺀 것도 체크 — 사장님 2026-11-14 "선결제도 체크 표기 넣어줘" */}
            {st === 'prepaid' && <span className="text-violet-700 font-black">✓</span>}{node}
          </button>
        </td>
      );
    }
    return (
      <td className={`${base} ${groupBg(color)}`}>
        {onPick ? (
          <button onClick={() => onPick(phone, orderId)} title="눌러서 고치기"
            className="w-full text-center hover:text-amber-700 hover:underline">{node}</button>
        ) : node}
      </td>
    );
  };

  const valueOf = (p: PersonRow, m: string) =>
    draft[p.orderId]?.[m] ?? (p.menus[m] ? String(p.menus[m]) : '');

  async function saveRow(p: PersonRow) {
    const d = draft[p.orderId];
    if (!d) return;
    const menus: Record<string, number> = {};
    let sum = 0;
    for (const m of MENU_TYPES) {
      const n = Number(d[m] ?? p.menus[m] ?? 0) || 0;
      menus[m] = n; sum += n;
    }
    // 바뀐 게 없으면 보내지 않는다
    if (MENU_TYPES.every(m => menus[m] === (p.menus[m] || 0))) {
      setDraft(({ [p.orderId]: _, ...rest }) => rest);
      return;
    }
    if (sum <= 0) { setErr(`${p.name} — 0팩으로는 못 고쳐요. 취소는 이름을 눌러 하세요`); return; }
    setSaving(p.orderId); setErr(null);
    try {
      const r = await fetch('/api/admin/order-edit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: p.orderId, date: sheet.date, menus }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `실패 (${r.status})`);
      setDraft(({ [p.orderId]: _, ...rest }) => rest);
      onSaved?.();
    } catch (e: any) {
      setErr(`${p.name} — ${e?.message || '못 고쳤어요'}`);
    }
    setSaving(null);
  }

  /* 여러 단계를 시킨 사람의 이름 칸 색. 같은 사람 = 같은 색, 옆 사람과는 다른 색이어야 해서
     여덟 가지를 돌려 쓴다. 사장님: "옅은 색으로" — 가장 연한 단계(-100)를 쓴다. 글씨가 살아야 한다.
     인쇄할 때 브라우저가 배경색을 지우는 것은 globals.css 의 print-color-adjust: exact 가 막는다. */
  const GROUP_BG = ['bg-amber-100', 'bg-sky-100', 'bg-emerald-100', 'bg-rose-100',
                    'bg-violet-100', 'bg-lime-100', 'bg-orange-100', 'bg-cyan-100'];
  const groupBg = (c?: number) => (c === undefined ? '' : GROUP_BG[c % GROUP_BG.length]);

  // ── 반찬 자리별 표 (1회 · 정기 · 오픈월드) ──
  type BRow = CookingSheet['banchan'][number];
  const bGroup = (g: BRow['group']) => sheet.banchan.filter(b => b.group === g);
  const shipCls = (s: string) => (s === '픽' ? 'text-emerald-700' : s === '택' ? 'text-stone-900' : 'text-sky-700');
  /* 배송 칸 — 화면에서는 눌러서 빈칸 → 택 → 내 → 빈칸 (서버가 배송 방법·값을 맞춘다). 픽업·당일(당)은 정보 넣기에서.
     2026-11-14 사장님: "아래 추가해서 위로 올라갔을 때 택배도 적을 수 있게" */
  const [shipBusy, setShipBusy] = useState<string | null>(null);
  async function cycleShip(orderId: string, cur: string) {
    if (!add || shipBusy) return;
    const next = cur === '' || cur === '당' ? '택' : cur === '택' ? '내' : '';
    setShipBusy(orderId); setErr(null);
    try {
      const r = await fetch(`/api/orders/${orderId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ship: next }) })
        .then(x => x.json()).catch(e => ({ ok: false, error: e?.message }));
      if (!r.ok) { setErr(`배송 칸을 못 바꿨어요: ${r.error || ''}`); return; }
      add.onAdded(r.row);
    } finally { setShipBusy(null); }
  }
  const shipTd = (orderId: string, s: string) => (
    <td className={`border border-black text-center p-0 text-[12px] font-black ${shipCls(s)}`}>
      {add && s !== '픽' ? (
        <button onClick={() => cycleShip(orderId, s)} disabled={shipBusy === orderId} title="눌러서 빈칸 → 택 → 내"
          className="w-full min-h-[20px] py-[2px] hover:bg-amber-100 disabled:opacity-40">{s}</button>
      ) : <div className="py-[2px]">{s}</div>}
    </td>
  );
  const bName = (b: BRow) => <>{b.needInfo
    ? <span className="underline decoration-yellow-400 decoration-[3px] underline-offset-2" title="연락처·주소를 아직 안 넣었어요 — 이름을 눌러 넣기">{b.name}</span>
    : b.name}{b.single && <span className="ml-0.5 text-[10px] font-bold text-amber-700">낱개</span>}{b.isNew && <span className="ml-0.5 text-[10px] font-black text-amber-700">추가</span>}</>;
  const banchanTable = (title: string, rows: BRow[], withAdd: boolean) => (
    <table className="table-fixed border-collapse text-[14px] leading-tight">
      <colgroup><col style={{ width: 78 }} /><col style={{ width: 22 }} /><col style={{ width: 26 }} /></colgroup>
      <thead>
        <tr>
          <th colSpan={3} className="border border-black px-0.5 py-[2px] text-[13px] text-center whitespace-nowrap">
            {title}<span className="ml-1 font-normal text-[10px] text-stone-600">{rows.length}명</span>
          </th>
        </tr>
        <tr className="bg-stone-200">
          <th className="border border-black px-0 py-[2px] text-[11px]">이 름</th>
          <th className="border border-black px-0 py-[2px] text-[10px]">배송</th>
          <th className="border border-black px-0 py-[2px] text-[10px]">세트</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((b, i) => (
          <tr key={i}>
            {nameCell(b.orderId, b.phone, b.color, bName(b), 'border border-black px-0 py-[2px] text-[13px] font-bold break-all text-center')}
            {shipTd(b.orderId, b.ship)}
            <td className="border border-black text-center py-[2px] font-black">{b.qty}</td>
          </tr>
        ))}
        <tr className="bg-stone-100">
          <td colSpan={2} className="border-2 border-black px-1 py-[2px] text-right font-black text-[11px]">세트</td>
          <td className="border-2 border-black text-center py-[2px] font-black">{rows.reduce((a, b) => a + b.qty, 0)}</td>
        </tr>
        {withAdd && add && <AddRow stage="반찬" date={add.date} onAdded={add.onAdded} cols={3} />}
      </tbody>
    </table>
  );

  // 반찬 종류별로 몇 개를 만들지 — 엑셀 '수반찬 주문내역' 맨 아랫줄과 같은 숫자다.
  // 손님마다 종류별 개수가 달라서(국 둘, 어느 반찬 셋 …) 세트 수만으로는 알 수 없다.
  const itemTotals = () => (
    <table className="table-fixed border-collapse text-[14px] leading-tight">
      <colgroup><col style={{ width: 170 }} /><col style={{ width: 34 }} /></colgroup>
      <thead>
        <tr>
          <th colSpan={2} className="border border-black px-1 py-[2px] text-[13px] text-center">
            반찬 종류별<span className="ml-1 font-normal text-[10px] text-stone-600">이만큼 만듭니다</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {sheet.banchanByItem.map((it, i) => (
          <tr key={it.name}>
            <td className="border border-black px-1 py-[2px] font-bold leading-tight break-words text-[12px]">{i + 1}. {it.name}</td>
            <td className="border border-black text-center py-[2px] font-black">{it.qty}</td>
          </tr>
        ))}
        <tr className="bg-stone-100">
          <td className="border-2 border-black px-1 py-[2px] text-right font-black text-[11px]">합계</td>
          <td className="border-2 border-black text-center py-[2px] font-black">{sheet.banchanByItem.reduce((a, b) => a + b.qty, 0)}</td>
        </tr>
      </tbody>
    </table>
  );

  // 메뉴 변경 — 세트 그대로가 아닌 아이(메뉴 변경·낱개). 엑셀 '주문변경' 시트처럼 반찬마다 몇 개인지 칸으로
  const menuChangeTable = () => {
    const rows = bGroup('메뉴변경');
    const items = sheet.banchanByItem.map(x => x.name);
    const cols = items.length + 4;
    return (
      <table className="table-fixed border-collapse text-[14px] leading-tight">
        <colgroup>
          <col style={{ width: 78 }} /><col style={{ width: 22 }} />
          {items.map(n => <col key={n} style={{ width: 34 }} />)}
          <col style={{ width: 28 }} /><col style={{ width: 52 }} />
        </colgroup>
        <thead>
          <tr>
            <th colSpan={cols} className="border border-black px-0.5 py-[2px] text-[13px] text-center whitespace-nowrap">
              메뉴 변경<span className="ml-1 font-normal text-[10px] text-stone-600">{rows.length}명 · 세트 그대로가 아닌 아이</span>
            </th>
          </tr>
          <tr className="bg-stone-200">
            <th className="border border-black px-0 py-[2px] text-[11px]">이 름</th>
            <th className="border border-black px-0 py-[2px] text-[10px]">배송</th>
            {items.map(n => <th key={n} className="border border-black px-0 py-[2px] text-[10px] leading-none break-all">{n}</th>)}
            <th className="border border-black px-0 py-[2px] text-[10px]">합계</th>
            <th className="border border-black px-0 py-[2px] text-[10px]">비고</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b, i) => (
            <tr key={i}>
              {nameCell(b.orderId, b.phone, b.color, bName(b), 'border border-black px-0 py-[2px] text-[13px] font-bold break-all text-center')}
              {shipTd(b.orderId, b.ship)}
              {items.map(n => <td key={n} className="border border-black text-center py-[2px] font-black">{b.menus[n] || <span className="text-stone-200">·</span>}</td>)}
              <td className="border border-black text-center py-[2px] font-black">{Object.values(b.menus).reduce((a, v) => a + (v || 0), 0)}</td>
              <td className="border border-black text-center py-[2px] text-[10px] font-bold">{b.note || ''}</td>
            </tr>
          ))}
          <tr className="bg-stone-100">
            <td colSpan={2} className="border-2 border-black px-1 py-[2px] text-right font-black text-[11px]">합계</td>
            {items.map(n => <td key={n} className="border-2 border-black text-center py-[2px] font-black">{rows.reduce((a, b) => a + (b.menus[n] || 0), 0) || <span className="text-stone-300">·</span>}</td>)}
            <td className="border-2 border-black text-center py-[2px] font-black">{rows.reduce((a, b) => a + Object.values(b.menus).reduce((x, v) => x + (v || 0), 0), 0)}</td>
            <td className="border-2 border-black" />
          </tr>
        </tbody>
      </table>
    );
  };

  const cell = (v: number, red: boolean) =>
    v ? <span className={red ? 'text-red-600 font-black' : 'font-black'}>{v}</span>
      : <span className="text-stone-200">·</span>;

  return (
    <>
      {onSaved && err && (
        <p className="mb-2 text-[12px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1">
          {err} <button onClick={() => setErr(null)} className="underline ml-1">닫기</button>
        </p>
      )}
      {/* 단계별 블록 — 한 블록을 다 챙기고 다음 블록으로 넘어가면 된다 */}
      {/* ⚠️ 겉 박스에 width 를 박아 두었더니 테두리가 잘려 보였다.
             합계 줄이 border-2(2px)라 border-collapse 에서 표가 colgroup 합보다 2px 넓어지는데,
             박스는 230px 로 고정이라 overflow-hidden 이 그 2px 을 잘라냈다.
             오른쪽 세로선이 아예 없는 것처럼 보였던 게 이것이다.
             박스에서 width 를, 표에서 w-full 을 빼 박스가 표 크기를 따라가게 한다.
             사장님: 주문이 20~30개씩 들어오면 세로가 모자라니 이름·칸을 줄이고, A4 오른쪽에
             남는 여백에 '비고' 칸을 두어 다른 칸이 있다는 표시를 거기 하라고 하셨다.
             블록 = 이름 78 + 배송 22 + 숫자 22x3 = 166(+테두리 2) = 168px.
             '배송' 칸은 사장님이 "이름 바로 옆에 빈칸 하나씩, 픽업인지 택배인지" 라고 하셔서
             넣었다 — 직배송은 기본이라 비우고 픽·택·당 한 글자만 적는다.
             여러 단계를 시킨 사람은 비고 '+N' 대신 이름 칸 배경색으로 묶는다(사장님 요청).
             같은 사람은 블록이 달라도 같은 색이다. 비고 자리 22px 은 이름 칸에 돌려줬다.
             20명씩 끊으면 65명(5·10·20·30)이 여섯 블록 — 168x6 + 틈 40 = 1048px 로 A4 가로
             (여백 빼고 1062px)에 들어간다. 관리자 화면 상자도 그래서 max-w-6xl(안쪽 1120px)이다 —
             5xl(안쪽 992px)일 때는 종이에선 한 줄인데 화면에선 여섯째가 내려가 사장님이 물으셨다.
             처음에 202px·22명으로 했더니 블록이 여섯이라 둘째 줄로 내려가고 세로도 넘쳐
             3장이 나왔다 — 실제 PDF 로 재고 고친 값이다.
             ⚠️ 머리글 '한우' 두 글자는 11px 글씨에 좌우 여백 0 이어야 24px 에 들어간다. */}
      <div className="flex gap-2 items-start flex-wrap">
        {sheet.sections.map(sec => (
          // 겉 상자에 rounded + overflow-hidden 을 줘서 모서리를 둥글게 했었는데, 그 둥근 틀이
          // 표의 네 모서리 테두리를 잘라냈다 (사장님: "각 표 모서리는 왜 다 안 보여"). 틀을 뺐다.
          <div key={sec.key} className="break-inside-avoid">
          <table className="table-fixed border-collapse text-[14px] leading-tight">
            <colgroup>
              <col style={{ width: 78 }} />
              <col style={{ width: 22 }} />
              {MENU_TYPES.map(m => <col key={m} style={{ width: 22 }} />)}
            </colgroup>
            <thead>
              <tr>
                <th colSpan={MENU_TYPES.length + 2} className="border border-black px-0.5 py-[2px] text-[13px] text-center whitespace-nowrap">
                  {sec.stage.replace('단계', '')}{sec.parts > 1 && <span className="text-[10px] font-normal"> {sec.part}/{sec.parts}</span>}
                  <span className="ml-1 font-normal text-[10px] text-stone-600">
                    {SMALL_VOLUME[sec.stage]}/<span className="text-red-600">{BIG_VOLUME[sec.stage]}</span> · {sec.total}명
                  </span>
                </th>
              </tr>
              <tr className="bg-stone-200">
                <th className="border border-black px-0 py-[2px] text-[11px]">이 름</th>
                <th className="border border-black px-0 py-[2px] text-[10px]">배송</th>
                {MENU_TYPES.map(m => (
                  <th key={m} className="border border-black px-0 py-[2px] text-[10px]">{menuLabel(m)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sec.list.map((p, i) => {
                // 줄은 이름 ㄱㄴ순이고 용량은 섞여 있다(사장님 엑셀 방식). 용량 경계 굵은 줄은 그래서 없다.
                // 이름 칸은 한 줄로 고정한다 — 줄 높이가 늘 같아야 22명이 들어간다는 계산이 선다.
                // 픽업·추가·미지정은 작은 꼬리표로 옆에 붙인다.
                const nameNode = (
                  <>
                    {/* 연락처·주소를 아직 안 넣은 아이는 이름 밑 노란 줄 — '정보?' 글자는 칸이 두 줄로 터져서 뺐다(사장님 2026-11-14) */}
                    {p.needInfo
                      ? <span className="underline decoration-yellow-400 decoration-[3px] underline-offset-2" title="연락처·주소를 아직 안 넣었어요 — 이름을 눌러 넣기">{p.name}</span>
                      : p.name}
                    {p.isNew && <span className="ml-0.5 text-[10px] font-black text-amber-700">추가</span>}
                    {p.unspec > 0 && <span className="ml-0.5 text-[10px] font-bold text-red-600">미지정{p.unspec}</span>}
                  </>
                );
                // 받는 방법 한 글자 — 픽(픽업)은 배송차에 실으면 안 되고, 택(택배)은 냉장 포장이 다르다
                return (
                  <tr key={`${p.orderId}-${i}`}>
                    {/* 이름은 가운데 — 칸이 좁아 왼쪽에 붙이면 긴 이름과 짧은 이름이 들쭉날쭉해진다 */}
                    {/* 여러 단계를 시킨 사람은 배경색 — 같은 사람은 다른 블록에서도 같은 색이다 */}
                    {nameCell(p.orderId, p.phone, p.color, nameNode, 'border border-black px-0 py-[2px] text-[13px] font-bold leading-tight break-all text-center')}
                    {shipTd(p.orderId, p.ship)}
                    {MENU_TYPES.map(m => (
                      <td key={m} className={`border border-black text-center ${editable(p) ? 'p-0' : 'py-[2px]'}`}>
                        {editable(p) ? (
                          // 종이와 같은 모양으로 보이되 누르면 바로 고쳐진다
                          <input inputMode="numeric" disabled={saving === p.orderId}
                            value={valueOf(p, m)}
                            onChange={e => {
                              const v = e.target.value.replace(/\D/g, '').slice(0, 2);
                              setDraft(d => ({ ...d, [p.orderId]: { ...(d[p.orderId] || {}), [m]: v } }));
                            }}
                            onBlur={() => saveRow(p)}
                            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                            className={`w-full text-center bg-transparent outline-none font-black py-[2px] text-[14px]
                                        focus:bg-amber-100 disabled:opacity-40
                                        ${p.isBig ? 'text-red-600' : ''}
                                        ${draft[p.orderId]?.[m] !== undefined ? 'bg-amber-50' : ''}`} />
                        ) : cell(p.menus[m], p.isBig)}
                      </td>
                    ))}
                  </tr>
                );
              })}
              {/* 단계별 합계 — 이만큼 만들면 된다.
                  같은 단계가 여러 칸으로 나뉜 경우 마지막 칸에만 붙인다(합은 단계 전체 기준이라
                  칸마다 찍으면 그 칸 합으로 오해해서 그만큼만 만들 위험이 있다). */}
              {sec.part === sec.parts && (<>
                <tr className="bg-stone-100">
                  <td colSpan={2} className="border-2 border-black px-1 py-[2px] text-right font-black text-[11px]">
                    {SMALL_VOLUME[sec.stage]}g
                  </td>
                  {MENU_TYPES.map(m => (
                    <td key={m} className="border-2 border-black text-center py-[2px] font-black">
                      {sec.tot[m].small || <span className="text-stone-300">·</span>}
                    </td>
                  ))}
                </tr>
                <tr className="bg-stone-100">
                  <td colSpan={2} className="border-2 border-black px-1 py-[2px] text-right font-black text-[11px] text-red-600">
                    {BIG_VOLUME[sec.stage]}g
                  </td>
                  {MENU_TYPES.map(m => (
                    <td key={m} className="border-2 border-black text-center py-[2px] font-black text-red-600">
                      {sec.tot[m].big || <span className="text-stone-300">·</span>}
                    </td>
                  ))}
                </tr>
              </>)}
              {add && sec.part === sec.parts && <AddRow stage={sec.stage} date={add.date} onAdded={add.onAdded} cols={MENU_TYPES.length + 2} />}
            </tbody>
          </table>
          </div>
        ))}

        {/* 반찬 — 엑셀 '수반찬 주문내역' 자리 그대로: 왼쪽 1회 주문 | 오른쪽 위 정기배송, 그 아래 오픈월드 | 뒷장 메뉴변경
            (사장님 2026-11-14 "엑셀 파일에는 다 이유가 있어"). 나누는 규칙은 lib/cookingSheet banchanGroupsOf */}
        {sheet.banchan.length > 0 && (
          <div className="break-inside-avoid">{banchanTable('1회 주문', bGroup('1회'), true)}</div>
        )}
        {(bGroup('정기').length > 0 || bGroup('오픈월드').length > 0) && (
          <div className="break-inside-avoid flex flex-col gap-2">
            {bGroup('정기').length > 0 && banchanTable('정기배송', bGroup('정기'), false)}
            {bGroup('오픈월드').length > 0 && banchanTable('오픈월드', bGroup('오픈월드'), false)}
          </div>
        )}

        {/* 입금 표는 셋째 칸에 메뉴 변경을 나란히 (사장님 2026-11-14 "한 줄로 적지 말고 3등분으로") */}
        {pay && bGroup('메뉴변경').length > 0 && <div className="break-inside-avoid">{menuChangeTable()}</div>}
        {!pay && sheet.banchanByItem.length > 0 && <div className="break-inside-avoid">{itemTotals()}</div>}
      </div>

      {/* 입금 표 — 반찬 종류별 합계는 맨 아래로 */}
      {pay && sheet.banchanByItem.length > 0 && <div className="mt-3 break-inside-avoid">{itemTotals()}</div>}

      {/* 뒷장 — 세트 그대로가 아닌 아이(메뉴 변경·낱개). 엑셀 '주문변경' 시트처럼 반찬마다 몇 개인지 칸으로 */}
      {!pay && bGroup('메뉴변경').length > 0 && (
        <div className="mt-3 print:break-before-page break-inside-avoid">{menuChangeTable()}</div>
      )}

      {/* '합쳐 담기' 상자는 뺐다 (사장님: "이 칸은 없애도 돼"). 다른 칸에 줄이 더 있다는 건
          이름 칸 배경색(같은 사람 = 같은 색)으로 보이고, 어느 칸인지는 사장님이 직접 보신다. */}

      {/* 알레르기 표시(이름 옆 '*', 아래 '알레르기 주의' 줄)는 뺐다.
          사장님: "알레르기는 상관없다고, 엄마가 알아서 빼야 한다고. 우린 앞으로 알레르기는 관여 안 해." */}
      {sheet.memos.length > 0 && (
        <div className="mt-1.5 border-2 border-black px-1.5 py-0.5 text-[11px] leading-snug">
          <span className="font-black">메모</span>
          {sheet.memos.map((m, i) => <span key={i} className="ml-2">{m.name}: {m.memo}</span>)}
        </div>
      )}
    </>
  );
}
