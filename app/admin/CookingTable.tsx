'use client';
import { useState } from 'react';
import { MENU_TYPES, menuLabel } from '@/lib/supabase';
import { BIG_VOLUME, SMALL_VOLUME, type CookingSheet, type PersonRow } from '@/lib/cookingSheet';

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

export default function CookingTable({ sheet, onPick, onSaved, printedAt }: {
  sheet: CookingSheet;
  /** 화면에서만 — 이름을 누르면 그 사람 것을 고친다(여덟 칸 전부 열림) */
  onPick?: (phone: string) => void;
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
  const editable = (p: PersonRow) => !!onSaved && (rowCount.get(p.orderId) || 0) <= 1;

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
                    {p.name}
                    {printedAt && p.isNew && <span className="ml-0.5 text-[10px] font-black text-amber-700">추가</span>}
                    {p.unspec > 0 && <span className="ml-0.5 text-[10px] font-bold text-red-600">미지정{p.unspec}</span>}
                  </>
                );
                // 받는 방법 한 글자 — 픽(픽업)은 배송차에 실으면 안 되고, 택(택배)은 냉장 포장이 다르다
                const shipCls = p.ship === '픽' ? 'text-emerald-700' : p.ship === '택' ? 'text-stone-900' : 'text-sky-700';
                return (
                  <tr key={`${p.orderId}-${i}`}>
                    {/* 이름은 가운데 — 칸이 좁아 왼쪽에 붙이면 긴 이름과 짧은 이름이 들쭉날쭉해진다 */}
                    {/* 여러 단계를 시킨 사람은 배경색 — 같은 사람은 다른 블록에서도 같은 색이다 */}
                    <td className={`border border-black px-0 py-[2px] text-[13px] font-bold leading-tight break-all text-center ${groupBg(p.color)}`}>
                      {onPick ? (
                        <button onClick={() => onPick(p.phone)} title="눌러서 고치기"
                          className="w-full text-center hover:text-amber-700 hover:underline">
                          {nameNode}
                        </button>
                      ) : nameNode}
                    </td>
                    <td className={`border border-black text-center py-[2px] text-[12px] font-black ${shipCls}`}>{p.ship}</td>
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
            </tbody>
          </table>
          </div>
        ))}

        {sheet.banchan.length > 0 && (
          <div className="break-inside-avoid">
          <table className="table-fixed border-collapse text-[14px] leading-tight">
            <colgroup>
              <col style={{ width: 78 }} />
              <col style={{ width: 22 }} />
              <col style={{ width: 26 }} />
            </colgroup>
            <thead>
              <tr>
                <th colSpan={3} className="border border-black px-0.5 py-[2px] text-[13px] text-center whitespace-nowrap">
                  반찬 세트<span className="ml-1 font-normal text-[10px] text-stone-600">{sheet.banchan.length}명</span>
                </th>
              </tr>
              <tr className="bg-stone-200">
                <th className="border border-black px-0 py-[2px] text-[11px]">이 름</th>
                <th className="border border-black px-0 py-[2px] text-[10px]">배송</th>
                <th className="border border-black px-0 py-[2px] text-[10px]">수</th>
              </tr>
            </thead>
            <tbody>
              {sheet.banchan.map((b, i) => {
                const bn = <>{b.name}{b.single && <span className="ml-0.5 text-[10px] font-bold text-amber-700">낱개</span>}</>;
                return (
                <tr key={i}>
                  <td className={`border border-black px-0 py-[2px] text-[13px] font-bold break-all text-center ${groupBg(b.color)}`}>
                    {onPick ? (
                      <button onClick={() => onPick(b.phone)} title="눌러서 고치기"
                        className="w-full text-center hover:text-amber-700 hover:underline">{bn}</button>
                    ) : bn}
                  </td>
                  <td className={`border border-black text-center py-[2px] text-[12px] font-black ${b.ship === '픽' ? 'text-emerald-700' : b.ship === '택' ? 'text-stone-900' : 'text-sky-700'}`}>{b.ship}</td>
                  {/* 낱개는 세트가 아니라 개수다 — 이름 옆 '낱개' 꼬리표로 구분한다 */}
                  <td className="border border-black text-center py-[2px] font-black">{b.qty}</td>
                </tr>
                );
              })}
              <tr className="bg-stone-100">
                <td colSpan={2} className="border-2 border-black px-1 py-[2px] text-right font-black text-[11px]">
                  세트{sheet.banchanSingleTotal > 0 && <span className="text-amber-700"> · 낱개</span>}
                </td>
                <td className="border-2 border-black text-center py-[2px] font-black">
                  {sheet.banchanTotal}
                  {sheet.banchanSingleTotal > 0 && (
                    <span className="block text-[10px] text-amber-700 leading-none">{sheet.banchanSingleTotal}개</span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
          </div>
        )}

        {/* 반찬 종류별로 몇 개를 만들지 — 엑셀 '수반찬 주문내역' 맨 아랫줄과 같은 숫자다.
            손님마다 종류별 개수가 달라서(국 둘, 어느 반찬 셋 …) 세트 수만으로는 알 수 없다. */}
        {sheet.banchanByItem.length > 0 && (
          <div className="break-inside-avoid">
            <table className="table-fixed border-collapse text-[14px] leading-tight">
              <colgroup><col style={{ width: 170 }} /><col style={{ width: 34 }} /></colgroup>
              <thead>
                <tr>
                  <th colSpan={2} className="border border-black px-1 py-[2px] text-[13px] text-center">
                    반찬 종류별
                    <span className="ml-1 font-normal text-[10px] text-stone-600">이만큼 만듭니다</span>
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
                  <td className="border-2 border-black text-center py-[2px] font-black">
                    {sheet.banchanByItem.reduce((a, b) => a + b.qty, 0)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

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
