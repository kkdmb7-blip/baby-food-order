'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  STAGES, STAGE_OPTIONS, MENU_TYPES, MIN_ORDER_QTY, getPrice, getBanchanPrice, banchanLineTotal, tierOf, menuLabel, PACK_SURCHARGE,
  hanwooAllowed, othersNeededForHanwoo, HANWOO_MAX_RATIO,
  shippingFeeFor, packsToFreeShipping, SHIPPING_FEE, FREE_SHIPPING_QTY,
  type StageType, type MenuType, type PriceTier
} from '@/lib/supabase';
import { weekDateOptions, weekMonday, deliveryDateOptions, formatPhone, allWeekDays, kstToday } from '@/lib/dates';
// Supabase 주소·공개 열쇠는 여기 한 군데서만 온다 — 전에는 이 파일 네 곳에 그대로 박혀 있었다
import { SB_URL, SB_ANON_KEY } from '@/lib/publicEnv';
// 3,650줄짜리 한 파일이라 고치다 엉뚱한 데를 건드리기 쉬웠다 —
// 화면 상태를 안 쓰는 것부터 떼어냈다(동작은 그대로).
import {
  uid, emptyMenus, newSet, newDate, setQty, setQtyTotal,
  isBanchanSet, isFilledSet, setPrice, dateQty, datePrice,
  type MenuSel, type OrderSet, type DateOrder,
} from '@/lib/orderDraft';
import {
  loadSaved, doSave, loadAddrBook, saveAddrBook,
  saveDraft, loadDraft, clearDraft, introSeen, markIntroSeen,
  ACQ_SOURCE_KEY, REF_CODE_KEY,
  type SavedInfo, type SavedAddress,
} from '@/lib/orderStorage';
import {
  Wrap, Logo, AdminLink, Section, Field, SRow, StepBar,
  PrimaryBtn, BackBtn, Row2, QtyCtrl, StatBtn, ReactionCtrl, AllergyBadge,
  iCls, iSmCls,
} from './ui';
import { ALLERGENS, COMMON_KEYS, allergenByKey, matchSeriousAllergens } from '@/lib/allergens';
import { menuForStage, bannedInMidStage } from '@/lib/midStage';
import {
  recommendStage, stageGuide, stageTransitionNote,
  loadDiary, setFoodStatus, foodKeysByStatus, testingDays, type Diary, type FoodStatus,
  saveLastOrder, loadLastOrder, daysSinceLastOrder, type SavedSet,
  loadReactions, setReaction, likedMenuNames, type MenuReaction, type MenuReactions,
  SYMPTOMS, loadSymptoms, addSymptom, removeSymptom, type SymptomEntry,
  loadSeenStatus, saveSeenStatus, hasSeenStatusRecord,
} from '@/lib/personalize';
import { addPhoto, listPhotos, deletePhoto, type PhotoMeta } from '@/lib/album';
/*
  주문 화면에서 쓰는 큰 조각들 — 정기배송 신청, 달력, 알레르기 등록, 식단일기,
  정기배송 회차 손보기.

  왜 따로 뒀나
    app/order/page.tsx 가 3,650줄이라 고치다 엉뚱한 데를 건드리기 쉬웠다.
    이 다섯은 page.tsx 안의 것을 하나도 쓰지 않고 받은 props 로만 도는 조각이라,
    그대로 옮겨도 동작이 달라지지 않는다.
*/

export function RegularSetup({ phone, babyName, initial, onSaved }: {
  phone: string;
  babyName: string;
  initial: {
    is_regular?: boolean; regular_schedule?: any; postal_code?: string | null;
    address?: string | null; address_detail?: string | null; door_password?: string | null;
  } | null;
  onSaved: () => void;
}) {
  const sched = initial?.regular_schedule || {};
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<StageType | null>(sched.stage ?? null);
  const [volume, setVolume] = useState<number | null>(sched.volume ?? null);
  // 요일 → 메뉴별 팩수. 팩수만 받으면 자동 주문이 조리표에 "메뉴 미지정"으로 떠서 조리를 못 함.
  const DAYS = ['월', '화', '목', '금'] as const;
  const emptyDayMenus = () => ({ 한우: 0, 닭: 0, 기타단백질: 0 } as Record<MenuType, number>);
  const initMenus: Record<string, Record<MenuType, number>> =
    { 월: emptyDayMenus(), 화: emptyDayMenus(), 목: emptyDayMenus(), 금: emptyDayMenus() };
  (sched.slots || []).forEach((s: any) => {
    if (!(s.day in initMenus)) return;
    if (Array.isArray(s.menus) && s.menus.length > 0) {
      s.menus.forEach((m: any) => { if (m?.menu in initMenus[s.day]) initMenus[s.day][m.menu as MenuType] = Number(m.qty) || 0; });
    } else if (Number(s.qty) > 0) {
      initMenus[s.day].한우 = Number(s.qty); // 메뉴 구분 없이 저장됐던 예전 신청 — 한우로 옮겨두고 고치게 함
    }
  });
  const [dayMenus, setDayMenus] = useState(initMenus);
  const dayQty = (day: string) => MENU_TYPES.reduce((a, m) => a + (dayMenus[day]?.[m] || 0), 0);
  // 받는 요일이 하나라도 있고, 받는 요일 전부가 최소 팩수를 넘어야 자동 주문이 서버 검증을 통과함
  const regularValid = DAYS.some(d => dayQty(d) > 0) && DAYS.every(d => dayQty(d) === 0 || dayQty(d) >= MIN_ORDER_QTY);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const isActive = !!initial?.is_regular;

  // 주소·지역 tier (가격 노출 조건)
  const [postalCode, setPostalCode] = useState(initial?.postal_code || '');
  const [addr, setAddr] = useState(initial?.address || '');
  const [addrDetail, setAddrDetail] = useState(initial?.address_detail || '');
  const [regDoorPw, setRegDoorPw] = useState(initial?.door_password || '');
  const [tier, setTier] = useState<PriceTier | null>(null);
  const [checking, setChecking] = useState(false);
  const DIRECT_GU = ['강서구', '양천구'];

  async function resolveTier(pc: string) {
    if (!/^\d{5}$/.test(pc)) { setTier(null); return; }
    setChecking(true);
    try {
      const SB = SB_URL, KEY = SB_ANON_KEY;
      const rows = await fetch(`${SB}/rest/v1/dubal_zones?postal_code=eq.${pc}&select=sido,gu`, {
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      }).then(r => r.json());
      const row = Array.isArray(rows) ? rows[0] : null;
      const kind = row && String(row.sido || '').includes('서울') && DIRECT_GU.some(g => String(row.gu || '').includes(g))
        ? '직배송' : '기타';
      setTier(kind === '직배송' ? '직배송' : '기타');
    } catch { setTier(null); }
    finally { setChecking(false); }
  }
  useEffect(() => { if (initial?.postal_code) resolveTier(initial.postal_code); }, []);

  function openPostcode() {
    const daum = (window as any).daum;
    if (!daum?.Postcode) { alert('주소 검색을 불러오는 중이에요. 잠시 후 다시 눌러주세요.'); return; }
    new daum.Postcode({
      oncomplete: (data: any) => {
        setAddr(data.roadAddress || data.address || '');
        setPostalCode(data.zonecode || '');
        resolveTier(data.zonecode || '');
      },
    }).open();
  }

  async function save(active: boolean) {
    setSaving(true); setMsg(null);
    try {
      const slots = DAYS.filter(d => dayQty(d) > 0).map(day => ({ day, menus: dayMenus[day] }));
      const r = await fetch('/api/my/regular', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone, baby_name: babyName, active, stage, volume, slots,
          postal_code: postalCode, address: addr, address_detail: addrDetail, door_password: regDoorPw,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || '저장 실패');
      // 예전엔 "신청됐어요"만 띄우고 실제 주문은 자정에야 바뀌어서, 바로 확인해보면
      // 팩수가 그대로라 저장이 안 된 것처럼 보였음 — 몇 건이 반영됐는지 같이 알려준다.
      const s = d.sync;
      const moved = s ? s.created + s.updated + s.revived + s.cancelled : 0;
      setMsg(!active ? '정기배송이 해지됐어요'
        : moved > 0 ? `정기배송이 저장됐어요! 예정된 주문 ${moved}건에 바로 반영했어요.`
        : '정기배송이 저장됐어요! (예정된 주문은 매일 자정에 만들어져요)');
      onSaved();
    } catch (e: any) { setMsg(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div className="bg-white rounded-2xl border border-emerald-200 overflow-hidden mb-4">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-4 py-3 text-left">
        <div className="flex items-center gap-2">
          <span className="text-lg">🔁</span>
          <span className="text-sm font-bold text-stone-800">정기배송</span>
          {isActive
            ? <span className="text-[11px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">이용중</span>
            : <span className="text-[11px] text-stone-400">미신청</span>}
        </div>
        <span className="text-stone-400 text-sm">{open ? '∧' : '∨'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-emerald-50 pt-3 space-y-3">
          <p className="text-[11px] text-stone-500 leading-relaxed">
            매주 원하는 요일·수량을 등록하면 자동으로 주문돼요. 배송지·단계·용량과 요일별 팩 수를 골라주세요.
          </p>
          {/* 배송지 (tier 확정용) */}
          <div>
            <button onClick={openPostcode} type="button"
              className="w-full py-2.5 bg-emerald-50 border border-emerald-300 rounded-xl text-emerald-800 font-bold text-xs active:bg-emerald-100">
              🔍 배송지 검색 {postalCode ? '(다시 찾기)' : ''}
            </button>
            {(addr || postalCode) && (
              <div className="mt-1.5 text-xs text-stone-700 bg-white border border-stone-200 rounded-lg px-3 py-2">
                {postalCode && <span className="text-stone-400">[{postalCode}] </span>}{addr || '등록된 배송지'}
                {checking && <span className="ml-1 text-stone-400">확인 중…</span>}
                {tier === '직배송' && <span className="ml-1 text-amber-600 font-bold">· 직배송</span>}
                {tier === '기타' && <span className="ml-1 text-emerald-600 font-bold">· 당일/택배</span>}
              </div>
            )}
            {/* 자동 주문에 그대로 실려 나가는 주소 — 동·호수가 없으면 배송을 못 함 */}
            <input value={addrDetail} onChange={e => setAddrDetail(e.target.value)} maxLength={50}
              placeholder="상세주소 (동·호수)"
              className="mt-1.5 w-full px-3 py-2 bg-white border border-stone-200 rounded-lg text-[16px] outline-none focus:border-emerald-400" />
            <input value={regDoorPw} onChange={e => setRegDoorPw(e.target.value)} maxLength={20}
              placeholder="현관 비밀번호 (선택)"
              className="mt-1.5 w-full px-3 py-2 bg-white border border-stone-200 rounded-lg text-[16px] outline-none focus:border-emerald-400" />
          </div>
          {/* 단계 */}
          <div className="grid grid-cols-4 gap-1.5">
            {STAGES.map(st => (
              <button key={st} onClick={() => { setStage(st); setVolume(null); }}
                className={`py-2 rounded-lg text-[11px] font-bold border ${stage === st ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-white border-stone-200 text-stone-600'}`}>
                {st.replace('중기1단계', '중1').replace('중기2단계', '중2').replace('완료기', '완료')}
              </button>
            ))}
          </div>
          {/* 용량 (가격은 배송지 확정 후 표시) */}
          {stage && (
            <>
              {tier === null && (
                <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">💡 배송지 입력 후 가격이 표시돼요</div>
              )}
              <div className="grid grid-cols-2 gap-1.5">
                {STAGE_OPTIONS[stage].map(o => (
                  <button key={o.volume} onClick={() => setVolume(o.volume)}
                    className={`py-2 rounded-lg text-xs border ${volume === o.volume ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-white border-stone-200 text-stone-600'}`}>
                    {o.volume}g{tier !== null ? ` · ${getPrice(stage!, o.volume, tier).toLocaleString()}원` : ''}
                  </button>
                ))}
              </div>
            </>
          )}
          {/* 요일별 메뉴 팩수 — 조리표에 한우/닭/기타가 찍히게 하려면 여기서 나눠 받아야 함 */}
          <div className="space-y-2">
            {DAYS.map(day => {
              const q = dayQty(day);
              return (
                <div key={day} className={`rounded-xl px-3 py-2 border ${q > 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-stone-50 border-stone-100'}`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-bold text-stone-700">{day}요일</span>
                    <span className={`text-[11px] font-bold ${q > 0 ? 'text-emerald-700' : 'text-stone-400'}`}>{q > 0 ? `${q}팩` : '안 받음'}</span>
                  </div>
                  <div className="space-y-1">
                    {MENU_TYPES.map(m => (
                      <div key={m} className="flex items-center justify-between">
                        <span className="text-xs text-stone-600">{menuLabel(m)}</span>
                        <QtyCtrl value={dayMenus[day][m]}
                          onChange={v => setDayMenus(p => ({ ...p, [day]: { ...p[day], [m]: Math.max(0, Math.min(10, v)) } }))} />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {/* 1회 배송 최소 팩수 — 자동 주문도 같은 규칙을 타므로 신청 때 미리 알려준다 */}
          {DAYS.some(d => dayQty(d) > 0 && dayQty(d) < MIN_ORDER_QTY) && (
            <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 leading-relaxed">
              받는 요일은 하루 {MIN_ORDER_QTY}팩 이상이어야 해요 ({DAYS.filter(d => dayQty(d) > 0 && dayQty(d) < MIN_ORDER_QTY).map(d => `${d} ${dayQty(d)}팩`).join(', ')})
            </div>
          )}
          {msg && <div className="text-xs text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2">{msg}</div>}
          <div className="flex gap-2">
            <button onClick={() => save(true)} disabled={saving || !stage || !volume || !postalCode || !addr || !regularValid}
              className="flex-1 py-2.5 bg-emerald-500 text-white text-sm font-bold rounded-xl disabled:bg-stone-200">
              {saving ? '저장 중…' : (!postalCode || !addr) ? '배송지를 입력해주세요' : !regularValid ? `받는 요일마다 ${MIN_ORDER_QTY}팩 이상 담아주세요` : isActive ? '변경 저장' : '정기배송 신청'}
            </button>
            {isActive && (
              <button onClick={() => save(false)} disabled={saving}
                className="px-4 py-2.5 border border-stone-200 text-stone-500 text-sm font-medium rounded-xl">해지</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── C. 월간 식단 캘린더 (4주치 kkakung_history 조회) ──────────────
export function MonthCalendar({
  reactions, allergies, onGoOrder,
}: { reactions: MenuReactions; allergies: string[]; onGoOrder: () => void }) {
  const [byDate, setByDate] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [openDate, setOpenDate] = useState<string | null>(null);
  // 세 번째 메뉴 타입은 데이터상 'other'로 들어옴 ('p3'는 예전 표기) — 둘 다 받아준다
  const TYPE_KOR: Record<string, string> = { hanwoo: '한우', chicken: '닭', p3: '기타단백질', other: '기타단백질' };
  const DOW_KOR: Record<number, string> = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금' };

  const weeks = useMemo(() => [0, 1, 2, 3].map(w => weekMonday(w)), []);
  const todayStr = useMemo(() => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10), []);

  useEffect(() => {
    const SB = SB_URL, KEY = SB_ANON_KEY;
    Promise.all(weeks.map(mon =>
      fetch(`${SB}/rest/v1/kkakung_history?id=eq.${mon}&select=id,yusik`, {
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      }).then(r => r.json()).catch(() => [])
    )).then(results => {
      const map: Record<string, any> = {};
      results.forEach(rows => {
        const sched = rows?.[0]?.yusik?.schedule;
        if (Array.isArray(sched)) sched.forEach((d: any) => { if (d.date) map[d.date] = d; });
      });
      setByDate(map);
      setLoading(false);
    });
  }, [weeks]);

  if (loading) return <div className="text-center py-10 text-stone-400 text-sm">식단을 불러오는 중…</div>;

  return (
    <div className="space-y-4">
      {weeks.map((mon, wi) => {
        const monTs = new Date(mon + 'T00:00:00Z').getTime();
        // 월~금 (0~4)
        const days = [0, 1, 2, 3, 4].map(off => {
          const ts = monTs + off * 86400000;
          const d = new Date(ts);
          const value = d.toISOString().slice(0, 10);
          const dow = d.getUTCDay();
          return { value, dow, label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, data: byDate[value] };
        });
        const monD = new Date(monTs);
        return (
          <div key={mon}>
            <div className="text-xs font-bold text-violet-700 mb-2">
              {wi === 0 ? '이번 주' : wi === 1 ? '다음 주' : `${monD.getUTCMonth() + 1}/${monD.getUTCDate()} 주`}
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {days.map(day => {
                const isBanchan = day.dow === 3;
                const menus = day.data?.menus || [];
                const hasBanchan = isBanchan && (day.data?.items?.length || day.data?.soup);
                const has = menus.length > 0 || hasBanchan;
                const isPast = day.value < todayStr;
                const isOpen = openDate === day.value;
                return (
                  <button key={day.value} onClick={() => has && setOpenDate(isOpen ? null : day.value)}
                    className={`rounded-lg border p-1.5 text-left min-h-[52px] transition ${
                      isPast ? 'bg-stone-50 border-stone-100 opacity-50'
                      : isBanchan ? 'bg-emerald-50 border-emerald-200'
                      : has ? 'bg-white border-violet-200 hover:border-violet-400' : 'bg-stone-50 border-stone-100'}`}>
                    <div className="text-[10px] font-bold text-stone-500">{day.label}({DOW_KOR[day.dow]})</div>
                    {isBanchan ? (
                      <div className="text-[9px] text-emerald-600 font-bold mt-0.5">{hasBanchan ? '반찬' : ''}</div>
                    ) : has ? (
                      <div className="flex flex-wrap gap-0.5 mt-0.5">
                        {menus.slice(0, 3).map((m: any, i: number) => (
                          <span key={i} className={`text-[8px] font-bold px-1 py-0.5 rounded ${
                            TYPE_KOR[m.type] === '한우' ? 'bg-amber-100 text-amber-800'
                            : TYPE_KOR[m.type] === '닭' ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-violet-100 text-violet-800'}`}>
                            {TYPE_KOR[m.type] || m.type}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[9px] text-stone-300 mt-0.5">예정</div>
                    )}
                  </button>
                );
              })}
            </div>

            {/* 펼친 날짜 상세 */}
            {days.some(d => d.value === openDate) && (() => {
              const day = days.find(d => d.value === openDate)!;
              const menus = day.data?.menus || [];
              return (
                <div className="mt-2 bg-white border border-violet-200 rounded-xl p-3 space-y-2">
                  <div className="text-xs font-bold text-violet-700">{day.label}({DOW_KOR[day.dow]}) 메뉴</div>
                  {day.dow === 3 ? (
                    <div className="text-xs text-stone-700 space-y-1">
                      {(day.data?.items || []).map((it: any, i: number) => (
                        <div key={i}>🍱 {it.name}<AllergyBadge ingredients={it.ingredients || ''} allergies={allergies} /></div>
                      ))}
                      {day.data?.soup && <div>🍲 {day.data.soup.name}</div>}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {menus.map((m: any, i: number) => (
                        <div key={i} className="text-xs text-stone-700">
                          <span className="font-bold">{TYPE_KOR[m.type] || m.type}</span> · {m.name}
                          {reactions[m.name] === 'like' && ' 👍'}
                          <div className="text-[10px] text-stone-400">{m.ingredients}</div>
                          {/* 여기는 단계를 고르기 전 화면이라 재료를 지우지 않고, 중기에 빠진다는 것만 알린다 */}
                          {bannedInMidStage(m.ingredients).length > 0 && (
                            <div className="text-[10px] text-amber-700">중기는 {bannedInMidStage(m.ingredients).join('·')}를 빼고 만들어요</div>
                          )}
                          <AllergyBadge ingredients={m.ingredients || ''} allergies={allergies} />
                        </div>
                      ))}
                    </div>
                  )}
                  <button onClick={onGoOrder} className="w-full py-2 bg-violet-500 text-white text-xs font-bold rounded-lg">이 메뉴 주문하러 가기 →</button>
                </div>
              );
            })()}
          </div>
        );
      })}
    </div>
  );
}

// ── 공통 컴포넌트 ─────────────────────────────────────────────────
// Wrap·Logo·AdminLink·Section·Field·SRow·StepBar·PrimaryBtn·BackBtn·Row2·QtyCtrl
// 은 app/order/ui.tsx 로 옮겼다
// ── 알레르기 등록 UI ──────────────────────────────────────────────
export function AllergyEditor({
  allergies, toggle, open, setOpen,
}: { allergies: string[]; toggle: (k: string) => void; open: boolean; setOpen: (v: boolean) => void }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? ALLERGENS : ALLERGENS.filter(a => COMMON_KEYS.includes(a.key) || allergies.includes(a.key));
  return (
    <div className="bg-white rounded-2xl border border-rose-100 overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-4 py-3 text-left">
        <div className="flex items-center gap-2">
          <span className="text-lg">🚫</span>
          <span className="text-sm font-bold text-stone-800">알레르기 설정</span>
          {allergies.length > 0
            ? <span className="text-[11px] font-bold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-full">{allergies.length}개 등록</span>
            : <span className="text-[11px] text-stone-400">미설정</span>}
        </div>
        <span className="text-stone-400 text-sm">{open ? '∧' : '∨'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-rose-50 pt-3">
          <p className="text-[11px] text-stone-500 mb-3 leading-relaxed">
            아기가 못 먹는 재료를 골라두면, 메뉴에 그 재료가 들어있을 때 <span className="text-rose-600 font-bold">빨간 경고</span>로 알려드려요. 한 번 설정하면 계속 유지되고, 다시 눌러 해제할 수 있어요.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {shown.map(a => {
              const on = allergies.includes(a.key);
              return (
                <button key={a.key} onClick={() => toggle(a.key)}
                  className={`px-2.5 py-1.5 rounded-full text-xs font-medium border transition ${
                    on ? 'bg-rose-500 border-rose-500 text-white' : 'bg-white border-stone-200 text-stone-600 hover:border-rose-300'}`}>
                  {a.emoji} {a.label}{on ? ' ✓' : ''}
                </button>
              );
            })}
          </div>
          {!showAll && (
            <button onClick={() => setShowAll(true)} className="mt-3 text-[11px] text-rose-500 underline underline-offset-2">
              + 더 많은 재료 보기 (전체 {ALLERGENS.length}종)
            </button>
          )}
          {allergies.length > 0 && (
            <div className="mt-3 text-[11px] text-stone-500">
              등록됨: {allergies.map(k => allergenByKey(k)?.label).filter(Boolean).join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 재료 도감 (먹어본 재료 트래킹 + 알레르기 첫도입 도우미 + 이상반응 기록) ──
export function FoodDiary({
  diary, update, open, setOpen, symptoms, onLog, onDel,
}: {
  diary: Diary; update: (k: string, s: FoodStatus) => void; open: boolean; setOpen: (v: boolean) => void;
  symptoms: SymptomEntry[]; onLog: (foodKey: string, symptom: string) => void; onDel: (idx: number) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [logKey, setLogKey] = useState<string>(''); // 이상반응 기록할 재료 선택
  const safe = foodKeysByStatus(diary, 'safe');
  const testing = foodKeysByStatus(diary, 'testing');
  const allergic = foodKeysByStatus(diary, 'allergic');
  const shown = showAll
    ? ALLERGENS
    : ALLERGENS.filter(a => COMMON_KEYS.includes(a.key) || diary[a.key]);
  return (
    <div className="bg-white rounded-2xl border border-emerald-100 overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-4 py-3 text-left">
        <div className="flex items-center gap-2">
          <span className="text-lg">📖</span>
          <span className="text-sm font-bold text-stone-800">우리 아기 재료 도감</span>
          <span className="text-[11px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">먹어본 {safe.length}종</span>
        </div>
        <span className="text-stone-400 text-sm">{open ? '∧' : '∨'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-emerald-50 pt-3 space-y-3">
          <p className="text-[11px] text-stone-500 leading-relaxed">
            새 재료는 <span className="font-bold text-amber-600">🧪 테스트</span>로 시작하세요. 흔히 한 번에 한 가지만, <span className="font-bold">3일간</span> 간격을 두고 이상반응(발진·설사 등)을 지켜보라고 하는데, 정확한 기준은 다니시는 소아과에 확인하시는 걸 권장드려요. 괜찮으면 <span className="font-bold text-emerald-600">✅ 안전</span>, 이상하면 <span className="font-bold text-rose-600">🚫 알레르기</span> — 알레르기로 표시하면 메뉴 경고에 자동 반영돼요.
          </p>

          {/* 테스트중 — 3일 관찰 가이드 */}
          {testing.length > 0 && (
            <div className="bg-amber-50 rounded-xl p-3 space-y-2">
              <div className="text-[11px] font-bold text-amber-700">🧪 테스트 관찰중</div>
              {testing.map(k => {
                const a = allergenByKey(k); if (!a) return null;
                const days = testingDays(diary[k]);
                return (
                  <div key={k} className="flex items-center justify-between gap-2">
                    <div className="text-xs text-stone-700 min-w-0 flex-1">
                      <div className="font-medium truncate">{a.emoji} {a.label}</div>
                      <div className="text-[10px] text-amber-600">
                        {days === 0 ? '오늘 시작' : `${days}일째`}{days >= 3 ? ' · 관찰 완료!' : ` (3일 중 ${days}일)`}
                      </div>
                    </div>
                    <div className="flex gap-1 flex-shrink-0">
                      <button onClick={() => update(k, 'safe')} className="text-[11px] font-bold text-emerald-700 bg-emerald-100 px-2 py-1 rounded whitespace-nowrap">✅ 안전</button>
                      <button onClick={() => update(k, 'allergic')} className="text-[11px] font-bold text-rose-700 bg-rose-100 px-2 py-1 rounded whitespace-nowrap">🚫 알레르기</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* 요약 */}
          <div className="flex gap-2 text-[11px]">
            <span className="text-emerald-600">✅ 안전 {safe.length}</span>
            <span className="text-amber-600">🧪 테스트 {testing.length}</span>
            <span className="text-rose-600">🚫 알레르기 {allergic.length}</span>
          </div>

          {/* B. 이상반응 기록 */}
          <div className="bg-rose-50 rounded-xl p-3 space-y-2">
            <div className="text-[11px] font-bold text-rose-700">🩹 이상반응 기록</div>
            <p className="text-[10px] text-stone-500">재료를 고르고 증상을 누르면 오늘 날짜로 기록돼요.</p>
            <select value={logKey} onChange={e => setLogKey(e.target.value)}
              className="w-full text-xs border border-rose-200 rounded-lg px-2 py-1.5 bg-white">
              <option value="">재료 선택…</option>
              {ALLERGENS.map(a => <option key={a.key} value={a.key}>{a.emoji} {a.label}</option>)}
            </select>
            {logKey && (
              <div className="flex flex-wrap gap-1">
                {SYMPTOMS.map(sym => (
                  <button key={sym} onClick={() => { onLog(logKey, sym); setLogKey(''); }}
                    className="text-[11px] px-2 py-1 rounded-full bg-white border border-rose-200 text-rose-700 font-medium hover:bg-rose-100">
                    {sym}
                  </button>
                ))}
              </div>
            )}
            {symptoms.length > 0 && (
              <div className="space-y-1 pt-1 border-t border-rose-100">
                {symptoms.slice(0, 8).map((s, i) => (
                  <div key={i} className="flex items-center justify-between text-[11px] text-stone-600">
                    <span>{s.date} · <b>{allergenByKey(s.foodKey)?.label ?? s.foodKey}</b> → {s.symptom}</span>
                    <button onClick={() => onDel(i)} className="text-stone-300 px-1">✕</button>
                  </div>
                ))}
                {symptoms.length > 8 && <div className="text-[10px] text-stone-400">외 {symptoms.length - 8}건</div>}
              </div>
            )}
          </div>

          {/* 재료별 상태 지정 */}
          <div className="space-y-1.5">
            {shown.map(a => {
              const st = diary[a.key]?.status ?? 'none';
              return (
                <div key={a.key} className="flex items-center justify-between gap-2">
                  <span className={`text-xs font-medium min-w-0 truncate ${st === 'allergic' ? 'text-rose-600' : st === 'safe' ? 'text-emerald-700' : 'text-stone-600'}`}>
                    {a.emoji} {a.label}
                  </span>
                  <div className="flex gap-1 flex-shrink-0">
                    <StatBtn on={st === 'testing'} onClick={() => update(a.key, st === 'testing' ? 'none' : 'testing')} cls="amber">🧪</StatBtn>
                    <StatBtn on={st === 'safe'} onClick={() => update(a.key, st === 'safe' ? 'none' : 'safe')} cls="emerald">✅</StatBtn>
                    <StatBtn on={st === 'allergic'} onClick={() => update(a.key, st === 'allergic' ? 'none' : 'allergic')} cls="rose">🚫</StatBtn>
                  </div>
                </div>
              );
            })}
          </div>
          {!showAll && (
            <button onClick={() => setShowAll(true)} className="text-[11px] text-emerald-600 underline underline-offset-2">
              + 더 많은 재료 보기 (전체 {ALLERGENS.length}종)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
// StatBtn·ReactionCtrl·AllergyBadge·iCls·iSmCls 는 app/order/ui.tsx 로 옮겼다

// ── 정기배송 "이번 회차만" 조정 ───────────────────────────────────
// 한 주만 쉬거나 수량만 줄이려고 정기배송 자체를 해지해버리는 일이 있었음.
// 여기서 손댄 회차는 서버가 regular_locked를 켜서 자정 크론이 원래대로 되돌리지 않는다.
export function RegularOccurrence({ order, phone, babyName, onDone }: {
  order: any; phone: string; babyName: string; onDone: () => void;
}) {
  const cur: Record<MenuType, number> = { 한우: 0, 닭: 0, 기타단백질: 0 };
  for (const d of (order.items || [])) {
    for (const s of (d.sets || [])) {
      for (const m of (s.menus || [])) if (m?.menu in cur) cur[m.menu as MenuType] += Number(m.qty) || 0;
    }
  }
  const [open, setOpen] = useState(false);
  const [qtys, setQtys] = useState<Record<MenuType, number>>(cur);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const total = MENU_TYPES.reduce((a, m) => a + (qtys[m] || 0), 0);

  async function send(action: 'skip' | 'update') {
    if (action === 'skip' && !confirm(`${order.delivery_date} 회차를 건너뛸까요?\n정기배송은 그대로 유지돼요.`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/my/regular-occurrence', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order_id: order.id, phone: phone.replace(/\D/g, ''), baby_name: babyName,
          action, menus: qtys,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) { setMsg(d.error || '변경 실패'); return; }
      setOpen(false);
      onDone();
    } catch (e: any) { setMsg(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="mt-2">
      <div className="flex gap-2">
        <button onClick={() => setOpen(v => !v)} disabled={busy}
          className="flex-1 py-2 text-[11px] font-bold text-amber-700 border border-amber-200 bg-amber-50 rounded-lg">
          이번 회차만 수량 변경
        </button>
        <button onClick={() => send('skip')} disabled={busy}
          className="flex-1 py-2 text-[11px] font-bold text-stone-600 border border-stone-200 rounded-lg">
          {busy ? '처리 중…' : '이번 회차 건너뛰기'}
        </button>
      </div>
      <p className="text-[10px] text-stone-400 mt-1.5 leading-relaxed">
        이번 회차만 바뀌고 정기배송은 그대로예요. 아예 그만두시려면 위 정기배송에서 해지해주세요.
      </p>
      {open && (
        <div className="mt-2 bg-white border border-amber-200 rounded-xl p-3 space-y-2">
          <div className="text-[11px] font-bold text-stone-700">
            {order.stage} {order.volume}g · {order.delivery_date}
          </div>
          {MENU_TYPES.map(m => (
            <div key={m} className="flex items-center justify-between">
              <span className="text-xs text-stone-600">{menuLabel(m)}</span>
              <QtyCtrl value={qtys[m]} onChange={v => setQtys(p => ({ ...p, [m]: Math.max(0, Math.min(10, v)) }))} />
            </div>
          ))}
          <div className="text-[11px] font-bold text-amber-700 text-right">합계 {total}팩</div>
          <button onClick={() => send('update')} disabled={busy || total === 0}
            className="w-full py-2 bg-amber-500 text-white text-xs font-bold rounded-lg disabled:bg-stone-200">
            {busy ? '저장 중…' : '이번 회차만 저장'}
          </button>
        </div>
      )}
      {msg && <div className="mt-1.5 text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-1.5 leading-relaxed">{msg}</div>}
    </div>
  );
}
