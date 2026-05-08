'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  STAGES, STAGE_OPTIONS, MENU_TYPES, MIN_ORDER_QTY, getPrice,
  type StageType, type MenuType, type OrderItem
} from '@/lib/supabase';
import { deliveryDateOptions, formatPhone } from '@/lib/dates';

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8; // 8 = 완료

type WeeklyMenu = { menu_type: MenuType; vegetables: string };

export default function OrderPage() {
  const [step, setStep] = useState<Step>(1);

  // ── 입력값 ─────────────────────────────────────────────────────
  const [babyName, setBabyName] = useState('');
  const [months, setMonths] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [addressDetail, setAddressDetail] = useState('');
  const [doorPw, setDoorPw] = useState('');
  const [stage, setStage] = useState<StageType | null>(null);
  const [volume, setVolume] = useState<number | null>(null);
  const [qtys, setQtys] = useState<Record<MenuType, number>>({ 한우: 0, 닭: 0, 기타단백질: 0 });
  const [deliveryDate, setDeliveryDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [completedId, setCompletedId] = useState<string | null>(null);

  // ── 이번 주 메뉴 (anon fetch) ─────────────────────────────────
  const [weeklyMenus, setWeeklyMenus] = useState<WeeklyMenu[]>([]);
  useEffect(() => {
    fetch('/api/menus/current')
      .then(r => r.json())
      .then(d => { if (d.menus) setWeeklyMenus(d.menus); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [step]);

  // ── 계산 ───────────────────────────────────────────────────────
  const pricePerPack = stage && volume ? getPrice(stage, volume) : 0;
  const totalQty = Object.values(qtys).reduce((s, n) => s + n, 0);
  const totalPrice = totalQty * pricePerPack;
  const dateOpts = useMemo(() => deliveryDateOptions(), []);

  // step 4 → volume 초기화 (단계 바뀌면)
  useEffect(() => { setVolume(null); }, [stage]);

  function setQty(menu: MenuType, val: number) {
    setQtys(prev => ({ ...prev, [menu]: Math.max(0, Math.min(10, val)) }));
  }

  // ── 제출 ───────────────────────────────────────────────────────
  async function submit() {
    setSubmitting(true);
    setServerError(null);
    const items: OrderItem[] = MENU_TYPES
      .filter(m => qtys[m] > 0)
      .map(m => ({ menu: m, qty: qtys[m] }));
    try {
      const r = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baby_name: babyName.trim(),
          months: parseInt(months),
          customer_phone: phone.replace(/[^\d]/g, ''),
          address: address.trim(),
          address_detail: addressDetail.trim(),
          door_password: doorPw.trim(),
          stage,
          volume,
          items,
          total_qty: totalQty,
          total_price: totalPrice,
          delivery_date: deliveryDate,
          order_type: '일반'
        })
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || '저장 실패');
      setCompletedId(d.id);
      setStep(8);
    } catch (e: any) {
      setServerError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  // ── 완료 화면 ─────────────────────────────────────────────────
  if (step === 8 && completedId) {
    return (
      <Wrap>
        <div className="bg-white rounded-2xl p-7 shadow-sm border border-amber-100 text-center">
          <div className="text-5xl mb-4">🍱</div>
          <h1 className="text-xl font-bold text-stone-900 mb-2">주문이 접수됐어요!</h1>
          <p className="text-sm text-stone-500 leading-relaxed mb-6">
            오늘 오후 12~18시 사이에 배송됩니다.<br />
            신선하게 준비할게요 🙂
          </p>
          <div className="bg-amber-50 rounded-xl px-4 py-3 text-xs text-stone-700 leading-loose text-left mb-4">
            <SRow k="아기 이름" v={babyName} />
            <SRow k="단계·용량" v={`${stage} · ${volume}g`} />
            <SRow k="구성" v={MENU_TYPES.filter(m => qtys[m] > 0).map(m => `${m} ${qtys[m]}팩`).join(' · ')} />
            <SRow k="총" v={`${totalQty}팩 · ${totalPrice.toLocaleString()}원`} />
            <SRow k="조리일" v={deliveryDate} />
            <SRow k="받는 곳" v={`${address}${addressDetail ? ' ' + addressDetail : ''}`} />
          </div>
          <p className="text-[11px] text-stone-400">주문번호 {completedId.slice(0, 8)}</p>
        </div>
      </Wrap>
    );
  }

  return (
    <Wrap>
      <header className="mb-6">
        <div className="text-[11px] tracking-[0.3em] text-amber-600 font-bold mb-1">BABY FOOD ORDER</div>
        <h1 className="text-2xl font-bold text-stone-900">이유식 주문</h1>
        <StepBar current={step as number} total={7} />
      </header>

      {/* Step 1 — 아기 정보 */}
      {step === 1 && (
        <Section title="아기 정보를 알려주세요">
          <Field label="아기 이름">
            <input value={babyName} onChange={e => setBabyName(e.target.value)} maxLength={15}
              placeholder="예: 리안이" className={iCls} />
          </Field>
          <Field label="개월수">
            <div className="flex items-center gap-3">
              <input value={months} onChange={e => setMonths(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric" maxLength={2} placeholder="예: 7" className={`${iCls} w-24`} />
              <span className="text-stone-500 text-sm">개월</span>
            </div>
          </Field>
          <PrimaryBtn
            onClick={() => setStep(2)}
            disabled={!babyName.trim() || !months || parseInt(months) <= 0}
          >
            다음
          </PrimaryBtn>
        </Section>
      )}

      {/* Step 2 — 배송 정보 */}
      {step === 2 && (
        <Section title="배송 정보를 입력해주세요">
          <Field label="연락처">
            <input value={phone} onChange={e => setPhone(e.target.value)} inputMode="numeric"
              maxLength={13} placeholder="010-0000-0000" className={iCls} />
          </Field>
          <Field label="주소">
            <input value={address} onChange={e => setAddress(e.target.value)}
              placeholder="서울시 서초구..." className={iCls} />
          </Field>
          <Field label="상세주소">
            <input value={addressDetail} onChange={e => setAddressDetail(e.target.value)}
              placeholder="동·호수 등" className={iCls} />
          </Field>
          <Field label="현관 비밀번호 (선택)">
            <input value={doorPw} onChange={e => setDoorPw(e.target.value)}
              placeholder="예: #1234*" className={iCls} />
          </Field>
          <Row2>
            <BackBtn onClick={() => setStep(1)} />
            <PrimaryBtn
              onClick={() => setStep(3)}
              disabled={!phone.replace(/\D/g,'').match(/^\d{10,11}$/) || !address.trim()}
            >
              다음
            </PrimaryBtn>
          </Row2>
        </Section>
      )}

      {/* Step 3 — 단계 선택 */}
      {step === 3 && (
        <Section title="이유식 단계를 선택해주세요">
          <div className="grid grid-cols-2 gap-3">
            {STAGES.map(s => (
              <ChoiceBtn key={s} active={stage === s} onClick={() => { setStage(s); setStep(4); }}>
                <div className="font-bold text-base">{s}</div>
                <div className="text-[11px] mt-1 opacity-70">
                  {STAGE_OPTIONS[s].map(o => `${o.volume}g·${(o.price/1000).toFixed(s==='완료기'?1:0)}천원`).join(' / ')}
                </div>
              </ChoiceBtn>
            ))}
          </div>
          <BackBtn onClick={() => setStep(2)} />
        </Section>
      )}

      {/* Step 4 — 용량 선택 */}
      {step === 4 && stage && (
        <Section title="용량을 선택해주세요">
          <div className="grid grid-cols-2 gap-3">
            {STAGE_OPTIONS[stage].map(opt => (
              <ChoiceBtn key={opt.volume} active={volume === opt.volume}
                onClick={() => { setVolume(opt.volume); setStep(5); }}>
                <div className="font-bold text-lg">{opt.volume}g</div>
                <div className="text-sm mt-1 opacity-80">{opt.price.toLocaleString()}원 / 팩</div>
              </ChoiceBtn>
            ))}
          </div>
          <BackBtn onClick={() => setStep(3)} />
        </Section>
      )}

      {/* Step 5 — 메뉴별 수량 */}
      {step === 5 && stage && volume && (
        <Section title="메뉴별 수량을 선택해주세요">
          <div className="text-xs text-stone-500 mb-3">팩당 {pricePerPack.toLocaleString()}원 · 최소 {MIN_ORDER_QTY}팩</div>
          <div className="space-y-3">
            {MENU_TYPES.map(menu => {
              const wm = weeklyMenus.find(m => m.menu_type === menu);
              return (
                <div key={menu} className="bg-white rounded-xl border border-amber-100 px-4 py-3">
                  <div className="flex items-center justify-between mb-1">
                    <div>
                      <span className="font-bold text-stone-900">{menu}</span>
                      {wm && <div className="text-[11px] text-stone-500 mt-0.5">{wm.vegetables}</div>}
                    </div>
                    <QtyCtrl value={qtys[menu]} onChange={v => setQty(menu, v)} />
                  </div>
                </div>
              );
            })}
          </div>

          {/* 합계 바 */}
          <div className={`mt-4 rounded-xl px-4 py-3 border-2 ${totalQty >= MIN_ORDER_QTY ? 'bg-amber-500 border-amber-500' : 'bg-white border-amber-200'}`}>
            <div className={`flex justify-between text-sm font-bold ${totalQty >= MIN_ORDER_QTY ? 'text-white' : 'text-stone-900'}`}>
              <span>총 {totalQty}팩</span>
              <span>{totalPrice.toLocaleString()}원</span>
            </div>
            {totalQty > 0 && totalQty < MIN_ORDER_QTY && (
              <div className="text-xs text-amber-700 mt-1">최소 {MIN_ORDER_QTY}팩 이상 주문 가능해요 (현재 {totalQty}팩)</div>
            )}
          </div>

          <Row2>
            <BackBtn onClick={() => setStep(4)} />
            <PrimaryBtn onClick={() => setStep(6)} disabled={totalQty < MIN_ORDER_QTY}>다음</PrimaryBtn>
          </Row2>
        </Section>
      )}

      {/* Step 6 — 조리일 선택 */}
      {step === 6 && (
        <Section title="조리일을 선택해주세요" sub="월·화·목·금 조리 / 당일 오후 12~18시 배송">
          <div className="grid grid-cols-2 gap-3">
            {dateOpts.map(d => (
              <ChoiceBtn key={d.value} active={deliveryDate === d.value}
                onClick={() => { setDeliveryDate(d.value); setStep(7); }}>
                <div className="font-bold text-base">{d.label}</div>
                <div className="text-xs mt-1 opacity-70">{d.value}</div>
              </ChoiceBtn>
            ))}
          </div>
          <BackBtn onClick={() => setStep(5)} />
        </Section>
      )}

      {/* Step 7 — 확인 */}
      {step === 7 && (
        <Section title="주문 내용을 확인해주세요">
          <div className="bg-white rounded-xl border border-amber-100 p-4 text-sm leading-loose divide-y divide-amber-50">
            <SRow k="아기" v={`${babyName} (${months}개월)`} />
            <SRow k="단계·용량" v={`${stage} · ${volume}g`} />
            <SRow k="메뉴" v={MENU_TYPES.filter(m=>qtys[m]>0).map(m=>`${m} ${qtys[m]}팩`).join(' · ')} />
            <SRow k="총" v={`${totalQty}팩 · ${totalPrice.toLocaleString()}원`} />
            <SRow k="조리일" v={deliveryDate} />
            <SRow k="연락처" v={formatPhone(phone)} />
            <SRow k="주소" v={`${address}${addressDetail ? ' ' + addressDetail : ''}`} />
            {doorPw && <SRow k="현관비번" v={doorPw} />}
          </div>
          {serverError && (
            <div className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{serverError}</div>
          )}
          <Row2>
            <BackBtn onClick={() => setStep(6)} />
            <PrimaryBtn onClick={submit} disabled={submitting}>
              {submitting ? '접수 중…' : '주문 완료'}
            </PrimaryBtn>
          </Row2>
        </Section>
      )}
    </Wrap>
  );
}

// ── 공통 컴포넌트 ─────────────────────────────────────────────

function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="max-w-md mx-auto px-5 py-6 pb-28">{children}</div>;
}

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="mb-4">
      <h2 className="text-lg font-bold text-stone-900 mb-1">{title}</h2>
      {sub && <p className="text-xs text-stone-500 mb-3">{sub}</p>}
      {!sub && <div className="mb-3" />}
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block mb-3">
      <span className="text-xs text-stone-600 font-medium mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}

function SRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 py-1.5">
      <span className="text-stone-500 flex-shrink-0">{k}</span>
      <span className="text-stone-900 font-medium text-right">{v}</span>
    </div>
  );
}

function StepBar({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex gap-1 mt-2">
      {Array.from({ length: total }).map((_, i) => (
        <div key={i}
          className={`h-1 flex-1 rounded-full transition-colors ${i + 1 <= current ? 'bg-amber-500' : 'bg-amber-100'}`}
        />
      ))}
    </div>
  );
}

function ChoiceBtn({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick}
      className={`p-4 rounded-xl border-2 text-left transition ${active ? 'bg-amber-500 border-amber-500 text-white' : 'bg-white border-amber-100 hover:border-amber-400'}`}
    >
      {children}
    </button>
  );
}

function PrimaryBtn({ onClick, disabled, children }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="flex-1 py-3.5 bg-amber-500 text-white font-bold rounded-xl shadow-sm active:bg-amber-600 disabled:bg-stone-200 disabled:text-stone-400 transition">
      {children}
    </button>
  );
}

function BackBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="px-5 py-3.5 bg-white border border-amber-100 text-stone-600 font-medium rounded-xl">
      이전
    </button>
  );
}

function Row2({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-2 mt-5">{children}</div>;
}

function QtyCtrl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-2">
      <button onClick={() => onChange(value - 1)} disabled={value <= 0}
        className="w-8 h-8 rounded-lg bg-amber-100 text-amber-800 font-bold text-lg disabled:opacity-30">−</button>
      <span className="w-6 text-center font-bold text-stone-900">{value}</span>
      <button onClick={() => onChange(value + 1)} disabled={value >= 10}
        className="w-8 h-8 rounded-lg bg-amber-100 text-amber-800 font-bold text-lg disabled:opacity-30">+</button>
    </div>
  );
}

const iCls = 'w-full px-3.5 py-3 bg-white border border-amber-100 rounded-xl outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100 transition text-[16px]';
