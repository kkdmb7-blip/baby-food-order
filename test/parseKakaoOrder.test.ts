import { parseKakaoOrder, missingFields } from '../lib/parseKakaoOrder';

const TODAY = '2026-11-09';
const out: string[] = [];
let pass = 0, fail = 0;

function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; out.push(`  OK   ${name} = ${g}`); }
  else { fail++; out.push(`  FAIL ${name}\n         받음: ${g}\n         기대: ${w}`); }
}

// ── 1. 사장님이 실제로 받으신 주문서 그대로 ──
const real = `주문서양식 복사해서 링크들어가신후 카톡주시면됩니다🙂주 문 서 양 식


1️⃣ 조리일 : 11월9일
2️⃣ 아기이름 : 양서은
3️⃣ 개 월 수 : 6개월20일
4️⃣ 주 소 : 서울시 양천구 화곡로25 신동아파밀리에 아파트 103동703호
5️⃣ 현관비번 :703키0731키
6️⃣ 연 락 처 :010 5502 2953
7️⃣ 단계(종류) :중기1단계
8️⃣ 용 량 : ex(230g 또는 300g, 유아식은[반찬]으로기재 : 230g


✅️ 입금은 반드시 '아가이름+조리일' 로 해주세요`;

out.push('[1] 실제 주문서');
const a = parseKakaoOrder(real, TODAY);
check('조리일', a.delivery_date, '2026-11-09');
check('아기이름', a.baby_name, '양서은');
check('개월수', a.months, '6');
check('주소', a.address, '서울시 양천구 화곡로25 신동아파밀리에 아파트 103동703호');
check('현관비번', a.door_password, '703키0731키');
check('연락처', a.customer_phone, '01055022953');
check('단계', a.stage, '중기1단계');
check('용량', a.volume, '230');
check('반찬여부', a.isBanchan, false);
check('빠진칸', missingFields(a), []);

// ── 2. 반찬(유아식) 주문 ──
out.push('', '[2] 유아식(반찬)');
const b = parseKakaoOrder(`1️⃣ 조리일 : 11월11일
2️⃣ 아기이름 : 김민수
3️⃣ 개 월 수 : 14개월
4️⃣ 주 소 : 서울시 강서구 화곡동 1
6️⃣ 연 락 처 : 010-1234-5678
7️⃣ 단계(종류) : 완료기
8️⃣ 용 량 : 반찬`, TODAY);
check('조리일', b.delivery_date, '2026-11-11');
check('개월수', b.months, '14');
check('단계', b.stage, '완료기');
check('반찬여부', b.isBanchan, true);
check('용량', b.volume, '');
check('빠진칸', missingFields(b), []);

// ── 3. 양식이 흐트러진 경우 (번호 없음, 콜론 붙음, 300g) ──
out.push('', '[3] 흐트러진 양식');
const c = parseKakaoOrder(`조리일:2026-12-01
아기이름:박하늘
개월수:11개월 3일
주소:경기도 고양시 어딘가 101-1202
현관비번: 1234*
연락처:01098765432
단계(종류):후기
용량:300g`, TODAY);
check('조리일', c.delivery_date, '2026-12-01');
check('아기이름', c.baby_name, '박하늘');
check('개월수', c.months, '11');
check('연락처', c.customer_phone, '01098765432');
check('단계', c.stage, '후기');
check('용량', c.volume, '300');

// ── 4. 해 넘어가는 날짜 (12월에 1월 주문) ──
out.push('', '[4] 해 넘김');
const d = parseKakaoOrder('조리일 : 1월5일', '2026-12-20');
check('내년으로 넘김', d.delivery_date, '2027-01-05');
const d2 = parseKakaoOrder('조리일 : 12월25일', '2026-12-20');
check('올해 유지', d2.delivery_date, '2026-12-25');

// ── 5. 못 읽는 경우는 비워둔다 (멋대로 채우지 않는다) ──
out.push('', '[5] 못 읽으면 비움');
const e = parseKakaoOrder(`조리일 : 13월40일
아기이름 :
단계(종류) : 몰라요
용량 : 999g`, TODAY);
check('잘못된 날짜', e.delivery_date, '');
check('빈 이름', e.baby_name, '');
check('모르는 단계', e.stage, '');
check('모르는 용량', e.volume, '');
check('빠진칸 알림', missingFields(e).length > 0, true);

// ── 6. 중기2단계 / 240 / 310 ──
out.push('', '[6] 나머지 단계·용량');
const f = parseKakaoOrder('단계(종류) : 중기 2단계\n용 량 : 240g', TODAY);
check('중기2', f.stage, '중기2단계');
check('240', f.volume, '240');
const g = parseKakaoOrder('단계(종류) : 중기2\n용 량 : 310', TODAY);
check('중기2 축약', g.stage, '중기2단계');
check('310', g.volume, '310');

out.push('', `통과 ${pass} / 실패 ${fail}`);
console.log(out.join('\n'));
if (fail) process.exit(1);
