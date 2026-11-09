import { STAGES, type StageType } from './supabase';

/**
 * 카톡으로 받은 주문서 양식을 읽어 주문 입력칸을 채운다.
 *
 * 사장님이 쓰시는 양식은 이렇게 생겼다.
 *   1️⃣ 조리일 : 11월9일
 *   2️⃣ 아기이름 : 양서은
 *   3️⃣ 개 월 수 : 6개월20일
 *   4️⃣ 주 소 : 서울시 양천구 ... 103동703호
 *   5️⃣ 현관비번 :703키0731키
 *   6️⃣ 연 락 처 :010 5502 2953
 *   7️⃣ 단계(종류) :중기1단계
 *   8️⃣ 용 량 : ex(230g 또는 300g, 유아식은[반찬]으로기재 : 230g
 *
 * 손님이 손으로 고쳐 보내기 때문에 양식이 조금씩 흐트러진다. 실제로 겪은 것들:
 *   - 라벨 안에 띄어쓰기가 들어간다("개 월 수", "연 락 처")
 *   - 콜론 앞뒤 공백이 제각각이다
 *   - 8번 줄에는 안내문("ex(230g 또는 300g...)")이 그대로 남아 있고 진짜 값은 맨 뒤에 온다
 *   - 번호가 이모지일 수도, 그냥 숫자일 수도 있다
 *
 * 못 읽은 칸은 비워서 돌려준다. 멋대로 채우면 사장님이 틀린 걸 모르고 넘긴다.
 */

export type ParsedKakaoOrder = {
  delivery_date: string;   // YYYY-MM-DD
  baby_name: string;
  months: string;          // 숫자 문자열 (입력칸에 그대로 넣기 위해)
  address: string;
  door_password: string;
  customer_phone: string;  // 숫자만
  stage: StageType | '';
  volume: string;          // '230' | '240' | '300' | '310'
  isBanchan: boolean;      // 유아식(반찬) 주문인지
};

export type ParseField = keyof ParsedKakaoOrder;

export const EMPTY_PARSED: ParsedKakaoOrder = {
  delivery_date: '', baby_name: '', months: '', address: '',
  door_password: '', customer_phone: '', stage: '', volume: '', isBanchan: false,
};

/** 라벨 안의 공백을 지워서 "개 월 수" 와 "개월수" 를 같게 본다. */
function squash(s: string): string {
  return s.replace(/\s+/g, '');
}

/**
 * 한 줄에서 값 부분만 떼어낸다.
 * 콜론이 여러 개면 마지막 것을 기준으로 삼는다 — 8번 줄의 안내문이
 * "...으로기재 : 230g" 처럼 콜론을 하나 더 갖고 있기 때문.
 */
function valueOf(line: string): string {
  const i = line.lastIndexOf(':');
  return i < 0 ? '' : line.slice(i + 1).trim();
}

/** 줄 맨 앞의 번호(1️⃣, 1., 1) 와 라벨을 떼어내고 라벨만 돌려준다. */
function labelOf(line: string): string {
  const i = line.lastIndexOf(':');
  const head = i < 0 ? line : line.slice(0, i);
  return squash(head.replace(/^[\s\d.)\-]*/, '').replace(/[0-9️⃣]/g, ''));
}

/**
 * "11월9일" → 올해(또는 가까운 다음 해) 11-09.
 * 지난 날짜로 읽히면 조리일이 과거가 되어 주문이 조용히 묻히므로,
 * 오늘보다 60일 넘게 지난 날짜는 다음 해로 넘긴다.
 */
function parseDate(raw: string, today: string): string {
  const v = squash(raw);
  let mo = 0, da = 0;

  const ymd = v.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  const md = v.match(/(\d{1,2})월\s*(\d{1,2})일?/) || v.match(/^(\d{1,2})[./-](\d{1,2})$/);

  if (ymd) {
    const d = `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
    return isValidDate(d) ? d : '';
  }
  if (md) { mo = Number(md[1]); da = Number(md[2]); }
  if (!mo || !da || mo > 12 || da > 31) return '';

  const year = Number(today.slice(0, 4));
  const mk = (y: number) => `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
  let out = mk(year);
  if (!isValidDate(out)) return '';
  // 한참 지난 날짜면 내년 것으로 본다(12월에 1월 주문을 받는 경우)
  if (daysBetween(today, out) < -60) out = mk(year + 1);
  return isValidDate(out) ? out : '';
}

function isValidDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const [y, m, da] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, da));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === da;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
}

/** "6개월20일" → 6 · "7" → 7 */
function parseMonths(raw: string): string {
  const m = squash(raw).match(/(\d{1,2})\s*개?월?/);
  return m ? String(Number(m[1])) : '';
}

/** "중기1단계" / "중기 1" / "후기" → STAGES 중 하나 */
function parseStage(raw: string): StageType | '' {
  const v = squash(raw);
  if (!v) return '';
  const exact = STAGES.find(s => v.includes(squash(s)));
  if (exact) return exact;
  if (/중기.*1|1.*중기/.test(v)) return '중기1단계';
  if (/중기.*2|2.*중기/.test(v)) return '중기2단계';
  if (v.includes('완료')) return '완료기';
  if (v.includes('후기')) return '후기';
  if (v.includes('중기')) return '중기1단계';
  return '';
}

/**
 * 용량. 8번 줄엔 안내문이 섞여 있어서 "230g 또는 300g" 둘 다 잡힌다.
 * 안내문은 콜론 앞에 있으므로 valueOf() 로 이미 잘려 나가지만,
 * 손님이 안내문을 지우고 쓰면 형태가 또 달라져서 마지막 숫자를 값으로 본다.
 */
function parseVolume(raw: string): { volume: string; isBanchan: boolean } {
  const v = squash(raw);
  if (/반찬|유아식/.test(v)) return { volume: '', isBanchan: true };
  const all = v.match(/\d{3}/g);
  if (!all) return { volume: '', isBanchan: false };
  const ok = all.filter(x => ['230', '240', '300', '310'].includes(x));
  const pick = ok.length ? ok[ok.length - 1] : '';
  return { volume: pick, isBanchan: false };
}

export function parseKakaoOrder(text: string, today: string): ParsedKakaoOrder {
  const out: ParsedKakaoOrder = { ...EMPTY_PARSED };
  if (!text) return out;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.indexOf(':') < 0) continue;
    const label = labelOf(line);
    const value = valueOf(line);
    if (!value) continue;

    if (label.includes('조리일') || label.includes('배송일') || label.includes('날짜')) {
      out.delivery_date = parseDate(value, today);
    } else if (label.includes('아기이름') || label.includes('아가이름') || label.includes('이름')) {
      out.baby_name = value.slice(0, 20);
    } else if (label.includes('개월수') || label.includes('월령')) {
      out.months = parseMonths(value);
    } else if (label.includes('주소')) {
      out.address = value.slice(0, 200);
    } else if (label.includes('현관') || label.includes('비번') || label.includes('공동현관')) {
      out.door_password = value.slice(0, 30);
    } else if (label.includes('연락처') || label.includes('전화') || label.includes('번호')) {
      out.customer_phone = value.replace(/\D/g, '').slice(0, 11);
    } else if (label.includes('단계') || label.includes('종류')) {
      out.stage = parseStage(value);
    } else if (label.includes('용량')) {
      const v = parseVolume(value);
      out.volume = v.volume;
      out.isBanchan = v.isBanchan;
    }
  }
  return out;
}

/** 아직 못 읽은 칸들 — 화면에 "이건 직접 넣어주세요" 로 띄운다. */
export function missingFields(p: ParsedKakaoOrder): ParseField[] {
  const need: ParseField[] = ['delivery_date', 'baby_name', 'months', 'address', 'customer_phone'];
  if (!p.isBanchan) need.push('stage', 'volume');
  return need.filter(k => !p[k]);
}

export const FIELD_LABEL: Record<ParseField, string> = {
  delivery_date: '조리일', baby_name: '아기 이름', months: '개월수', address: '주소',
  door_password: '현관 비번', customer_phone: '연락처', stage: '단계', volume: '용량',
  isBanchan: '반찬',
};
