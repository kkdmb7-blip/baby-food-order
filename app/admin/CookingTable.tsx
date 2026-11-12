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
      {/* 네 단계가 한 줄에 들어가야 한다 — 칸이 넓어 완료기가 아래로 내려가고 있었다.
          230px x 4 + 틈 24px = 944px (화면 max-w-5xl 안쪽 992px, A4 가로 1062px 둘 다 들어간다) */}
      <div className="flex gap-2 items-start flex-wrap">
        {sheet.sections.map(sec => (
          // 모서리를 둥글게 — border-collapse 표는 radius 가 안 먹어서 겉을 감싸 잘라낸다
          <div key={sec.key} className="rounded-lg overflow-hidden break-inside-avoid" style={{ width: 230 }}>
          <table className="table-fixed border-collapse text-[18px] leading-tight w-full">
            <colgroup>
              <col style={{ width: 122 }} />
              {MENU_TYPES.map(m => <col key={m} style={{ width: 36 }} />)}
            </colgroup>
            <thead>
              <tr>
                <th colSpan={MENU_TYPES.length + 1} className="border border-black px-2 py-1 text-[17px] text-center">
                  {sec.stage}{sec.parts > 1 && <span className="text-[13px] font-normal"> ({sec.part}/{sec.parts})</span>}
                  <span className="ml-1.5 font-normal text-[13px] text-stone-600">
                    {SMALL_VOLUME[sec.stage]}/<span className="text-red-600">{BIG_VOLUME[sec.stage]}</span>g · {sec.total}명
                  </span>
                </th>
              </tr>
              <tr className="bg-stone-200">
                <th className="border border-black px-1 py-1 text-[15px]">이 름</th>
                {MENU_TYPES.map(m => (
                  <th key={m} className="border border-black px-0.5 py-1 text-[14px]">{menuLabel(m)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sec.list.map((p, i) => {
                const prev = sec.list[i - 1];
                const volChanged = prev && prev.isBig !== p.isBig;
                const nameNode = (
                  <>
                    {p.multi && <span className="text-blue-700 font-black mr-0.5">+</span>}
                    {p.name}{p.allergy && <span className="text-red-600">*</span>}
                    {p.pickup && <span className="ml-1 text-[12px] font-black text-emerald-700">픽업</span>}
                    {printedAt && p.isNew && <span className="ml-1 text-[11px] font-black text-amber-700">추가</span>}
                    {/* 이 사람 줄이 또 어디에 있는지 — 모르면 따로 담거나 하나를 빠뜨린다 */}
                    {p.others.length > 0 && (
                      <span className="block text-[12px] font-black text-blue-700 leading-tight">
                        + {p.others.join(' + ')}
                      </span>
                    )}
                    {/* 메뉴가 안 정해진 팩 — 이름 옆에 붙이면 이름칸이 터져서 아랫줄에 작게 */}
                    {p.unspec > 0 && <span className="block text-[12px] font-bold text-red-600">미지정 {p.unspec}</span>}
                  </>
                );
                return (
                  <tr key={`${p.orderId}-${i}`} className={volChanged ? 'border-t-2 border-t-black' : ''}>
                    {/* 이름은 가운데 — 칸이 좁아 왼쪽에 붙이면 긴 이름과 짧은 이름이 들쭉날쭉해진다 */}
                    <td className="border border-black px-1 py-[7px] font-bold leading-tight break-words text-center">
                      {onPick ? (
                        <button onClick={() => onPick(p.phone)} title="눌러서 고치기"
                          className="w-full text-center hover:text-amber-700 hover:underline">
                          {nameNode}
                        </button>
                      ) : nameNode}
                    </td>
                    {MENU_TYPES.map(m => (
                      <td key={m} className={`border border-black text-center ${editable(p) ? 'p-0' : 'py-[7px]'}`}>
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
                            className={`w-full text-center bg-transparent outline-none font-black py-[7px]
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
                  <td className="border-2 border-black px-2 py-1.5 text-right font-black text-[13px]">
                    {SMALL_VOLUME[sec.stage]}g
                  </td>
                  {MENU_TYPES.map(m => (
                    <td key={m} className="border-2 border-black text-center py-1.5 font-black">
                      {sec.tot[m].small || <span className="text-stone-300">·</span>}
                    </td>
                  ))}
                </tr>
                <tr className="bg-stone-100">
                  <td className="border-2 border-black px-2 py-1.5 text-right font-black text-[13px] text-red-600">
                    {BIG_VOLUME[sec.stage]}g
                  </td>
                  {MENU_TYPES.map(m => (
                    <td key={m} className="border-2 border-black text-center py-1.5 font-black text-red-600">
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
          <div className="rounded-lg overflow-hidden break-inside-avoid" style={{ width: 160 }}>
          <table className="table-fixed border-collapse text-[18px] leading-tight w-full">
            <colgroup>
              <col style={{ width: 122 }} />
              <col style={{ width: 36 }} />
            </colgroup>
            <thead>
              <tr>
                <th colSpan={2} className="border border-black px-2 py-1 text-[17px] text-center">
                  반찬 세트<span className="ml-1.5 font-normal text-[13px] text-stone-600">{sheet.banchan.length}명</span>
                </th>
              </tr>
              <tr className="bg-stone-200">
                <th className="border border-black px-1 py-1 text-[15px]">이 름</th>
                <th className="border border-black px-0.5 py-1 text-[14px]">세트</th>
              </tr>
            </thead>
            <tbody>
              {sheet.banchan.map((b, i) => {
                const bn = (
                  <>
                    {b.others.length > 0 && <span className="text-blue-700 font-black mr-0.5">+</span>}
                    {b.name}
                    {b.others.length > 0 && (
                      <span className="block text-[12px] font-black text-blue-700 leading-tight">
                        + {b.others.join(' + ')}
                      </span>
                    )}
                  </>
                );
                return (
                <tr key={i}>
                  <td className="border border-black px-1 py-[9px] font-bold break-words text-center">
                    {onPick ? (
                      <button onClick={() => onPick(b.phone)} title="눌러서 고치기"
                        className="w-full text-center hover:text-amber-700 hover:underline">{bn}</button>
                    ) : bn}
                  </td>
                  <td className="border border-black text-center py-[7px] font-black">{b.qty}</td>
                </tr>
                );
              })}
              <tr className="bg-stone-100">
                <td className="border-2 border-black px-2 py-1.5 text-right font-black text-[13px]">합계</td>
                <td className="border-2 border-black text-center py-1.5 font-black">{sheet.banchanTotal}</td>
              </tr>
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* 합쳐 담는 사람 — 블록이 나뉘어 있어서, 담을 때는 이 줄대로 한 봉투에 모은다.
          여기 숫자는 위 블록에 이미 들어 있는 것이다. 조리 수량에 더하면 두 배가 된다. */}
      {sheet.multi.length > 0 && (
        <div className="mt-3 border-2 border-blue-700 px-2.5 py-2 text-[14px]">
          <div className="font-black text-blue-700 mb-1">
            + 합쳐 담기 {sheet.multi.length}명
            <span className="ml-1.5 font-normal text-[12px] text-stone-600">
              한 봉투로 모으세요 · 이 숫자는 위 블록에 이미 들어 있습니다(조리 수량에 더하지 마세요)
            </span>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-0.5">
            {sheet.multi.map((m, i) => (
              <span key={i}>
                <span className="font-black">{m.name}</span>
                <span className="ml-1">{m.parts.map(t => `${t.label} ${t.qty}팩`).join(' + ')}</span>
                <span className="ml-1 font-black">= {m.total}팩</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 알레르기 — 하루 분량을 한 솥에 만들어서 특정 재료만 뺄 수는 없다.
          그래서 이 줄은 '빼라' 가 아니라 '이 아이에게 그 재료가 가면 안 된다' 는 표시다.
          (교차오염 주의 같은 당연한 문구는 뺐다 — 조리실에서 보는 종이다) */}
      {sheet.allergies.length > 0 && (
        <div className="mt-2 border-2 border-black px-2.5 py-1.5 text-[14px]">
          <span className="font-black">알레르기 주의</span>
          <span className="ml-2">
            {sheet.allergies.map((a, i) => (
              <span key={i} className="mr-3"><span className="font-black text-red-600">{a.name}</span> {a.items.join('·')}</span>
            ))}
          </span>
        </div>
      )}

      {sheet.memos.length > 0 && (
        <div className="mt-2 border border-black px-2.5 py-1.5 text-[14px]">
          <span className="font-black">메모</span>
          <span className="ml-1.5">
            {sheet.memos.map((m, i) => <span key={i} className="mr-3">{m.name}: {m.memo}</span>)}
          </span>
        </div>
      )}
    </>
  );
}
