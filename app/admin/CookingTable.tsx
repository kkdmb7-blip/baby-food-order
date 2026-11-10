'use client';
import { MENU_TYPES, menuLabel } from '@/lib/supabase';
import { BIG_VOLUME, SMALL_VOLUME, type CookingSheet } from '@/lib/cookingSheet';

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

export default function CookingTable({ sheet, onPick, printedAt }: {
  sheet: CookingSheet;
  /** 화면에서만 — 이름을 누르면 그 사람 것을 고친다 */
  onPick?: (phone: string) => void;
  /** 프린트한 시각. 그 뒤에 들어온 줄에 '추가' 를 붙인다 */
  printedAt?: string | null;
}) {
  const cell = (v: number, red: boolean) =>
    v ? <span className={red ? 'text-red-600 font-black' : 'font-black'}>{v}</span>
      : <span className="text-stone-200">·</span>;

  return (
    <>
      {/* 단계별 블록 — 한 블록을 다 챙기고 다음 블록으로 넘어가면 된다 */}
      <div className="flex gap-3 items-start flex-wrap">
        {sheet.sections.map(sec => (
          <table key={sec.key} className="table-fixed border-collapse text-[18px] leading-tight break-inside-avoid" style={{ width: 244 }}>
            <colgroup>
              <col style={{ width: 130 }} />
              {MENU_TYPES.map(m => <col key={m} style={{ width: 38 }} />)}
            </colgroup>
            <thead>
              <tr>
                <th colSpan={MENU_TYPES.length + 1} className="border border-black px-2 py-1 text-[17px] text-left">
                  {sec.stage}{sec.parts > 1 && <span className="text-[13px] font-normal"> ({sec.part}/{sec.parts})</span>}
                  <span className="ml-1.5 font-normal text-[13px] text-stone-600">
                    {SMALL_VOLUME[sec.stage]}/<span className="text-red-600">{BIG_VOLUME[sec.stage]}</span>g · {sec.total}명
                  </span>
                </th>
              </tr>
              <tr className="bg-stone-200">
                <th className="border border-black px-2 py-1 w-[130px] text-[15px]">이 름</th>
                {MENU_TYPES.map(m => (
                  <th key={m} className="border border-black px-1 py-1 w-[38px] text-[14px]">{menuLabel(m)}</th>
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
                    {/* 메뉴가 안 정해진 팩 — 이름 옆에 붙이면 이름칸이 터져서 아랫줄에 작게 */}
                    {p.unspec > 0 && <span className="block text-[12px] font-bold text-red-600">미지정 {p.unspec}</span>}
                  </>
                );
                return (
                  <tr key={`${p.orderId}-${i}`} className={volChanged ? 'border-t-2 border-t-black' : ''}>
                    <td className="border border-black px-2 py-[7px] font-bold leading-tight break-words">
                      {onPick ? (
                        <button onClick={() => onPick(p.phone)} title="눌러서 고치기"
                          className="text-left w-full hover:text-amber-700 hover:underline">
                          {nameNode}
                        </button>
                      ) : nameNode}
                    </td>
                    {MENU_TYPES.map(m => (
                      <td key={m} className="border border-black text-center py-[7px]">
                        {cell(p.menus[m], p.isBig)}
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
        ))}

        {sheet.banchan.length > 0 && (
          <table className="table-fixed border-collapse text-[18px] leading-tight break-inside-avoid" style={{ width: 168 }}>
            <colgroup>
              <col style={{ width: 130 }} />
              <col style={{ width: 38 }} />
            </colgroup>
            <thead>
              <tr>
                <th colSpan={2} className="border border-black px-2 py-1 text-[17px] text-left">
                  반찬 세트<span className="ml-1.5 font-normal text-[13px] text-stone-600">{sheet.banchan.length}명</span>
                </th>
              </tr>
              <tr className="bg-stone-200">
                <th className="border border-black px-2 py-1 w-[130px] text-[15px]">이 름</th>
                <th className="border border-black px-1 py-1 w-[38px] text-[14px]">세트</th>
              </tr>
            </thead>
            <tbody>
              {sheet.banchan.map((b, i) => (
                <tr key={i}>
                  <td className="border border-black px-2 py-[9px] font-bold break-words">
                    {onPick ? (
                      <button onClick={() => onPick(b.phone)} title="눌러서 고치기"
                        className="text-left w-full hover:text-amber-700 hover:underline">{b.name}</button>
                    ) : b.name}
                  </td>
                  <td className="border border-black text-center py-[7px] font-black">{b.qty}</td>
                </tr>
              ))}
              <tr className="bg-stone-100">
                <td className="border-2 border-black px-2 py-1.5 text-right font-black text-[13px]">합계</td>
                <td className="border-2 border-black text-center py-1.5 font-black">{sheet.banchanTotal}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      {/* 여러 단계를 같이 시킨 사람 — 블록이 나뉘어 있어서 포장할 때 합쳐야 한다 */}
      {sheet.multi.length > 0 && (
        <div className="mt-3 border-2 border-blue-700 px-2.5 py-1.5 text-[14px]">
          <span className="font-black text-blue-700">+ 여러 단계 함께 주문 — 포장할 때 한 봉투로 합쳐주세요</span>
          <span className="ml-2">
            {sheet.multi.map((m, i) => (
              <span key={i} className="mr-3"><span className="font-black">{m.name}</span> {m.stages.join(' + ')}</span>
            ))}
          </span>
        </div>
      )}

      {/* 알레르기 — 재료를 빼드리는 게 아니라(불가) 교차오염 주의용 */}
      {sheet.allergies.length > 0 && (
        <div className="mt-2 border-2 border-black px-2.5 py-1.5 text-[14px]">
          <span className="font-black">알레르기 주의</span>
          <span className="text-[12px] text-stone-600 ml-1">(재료 제거 불가 — 조리도구·교차오염 주의)</span>
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
