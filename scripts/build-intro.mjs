// 상세페이지 HTML → 자사몰(baby-food-order) /  페이지로 옮긴다.
//  1) base64 이미지 9장을 public/intro/ 파일로 빼낸다 (244KB를 번들에서 제거)
//  2) 스마트스토어용으로 뺐던 연락처·주문 동선을 자사몰용으로 되살린다
//  3) <style> + 본문만 추려 app/intro-html.ts 로 내보낸다
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const SRC = 'C:/Users/차니파파/Downloads/까꿍디미방 이유식 (수정).html';
const APP = 'C:/Users/차니파파/Desktop/baby-food-order';
let s = readFileSync(SRC, 'utf8');
const log = [], fails = [];

// ── 1. 이미지 추출 ──
mkdirSync(`${APP}/public/intro`, { recursive: true });
const EXT = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp' };
let n = 0, saved = 0;
s = s.replace(/data:image\/(\w+);base64,([A-Za-z0-9+/=]+)/g, (_, type, b64) => {
  n++;
  const ext = EXT[type] || type;
  const buf = Buffer.from(b64, 'base64');
  writeFileSync(`${APP}/public/intro/${n}.${ext}`, buf);
  saved += buf.length;
  return `/intro/${n}.${ext}`;
});
log.push(`이미지 ${n}장 추출 → public/intro/ (${Math.round(saved / 1024)}KB)`);

// ── 2. 자사몰용 복구 ──
const edits = [
  ['상단바 · 주문 동선 추가',
`<strong>체험팩 1팩 무료</strong> · 배송비 3,000원만 · 한 가정 1회 · 강서구 10년 수제 이유식`,
`<strong>체험팩 1팩 무료</strong> · 배송비 3,000원만 · 한 가정 1회 · 강서구 10년 수제 이유식`],

  ['주문 섹션 · 주문하기 버튼 복구',
`    <p class="cta-info">문의는 평일 오전 9시~오후 5시에 받습니다</p>`,
`    <div class="cta-btns">
      <a href="/order" class="btn-w">주문하러 가기</a>
    </div>
    <p class="cta-info">문의는 평일 오전 9시~오후 5시에 받습니다 · 카카오채널 <strong>까꿍디미방</strong></p>`],

  ['꼬리말 · 전화·이메일 복구 (자사몰은 전자상거래법 직접 적용)',
`      (07760) 서울특별시 강서구 강서로12길 22, 1층 102호`,
`      (07760) 서울특별시 강서구 강서로12길 22, 1층 102호<br>
      전화 02-2696-1228 · 이메일 kkdmb@naver.com`],
];
for (const [name, from, to] of edits) {
  const c = s.split(from).length - 1;
  if (c !== 1) { fails.push(`${name} — ${c}군데`); continue; }
  s = s.replace(from, to);
  log.push(`OK  ${name}`);
}

// ── 3. style + 본문 추리기 ──
// 파일 구조: <title>…</title> <meta> <link rel=preconnect> <link rel=stylesheet(구글폰트)> <style>…</style> 본문 <script>…</script>
const fontHref = (s.match(/https:\/\/fonts\.googleapis\.com\/css2\?[^"]+/) || [])[0];
// 파일 맨 앞 <head> 에는 아티팩트 껍데기의 작은 <style> 이 하나 더 있다.
// 구글폰트 <link> 뒤에 오는 것이 이 페이지의 진짜 디자인 CSS다.
const afterFont = s.indexOf('fonts.googleapis.com');
const styleStart = s.indexOf('<style>', afterFont);
const bodyStart = s.indexOf('<!-- ═══ 상단 알림바 ═══ -->');
const scriptStart = s.lastIndexOf('<script>');
const scriptEnd = s.lastIndexOf('</script>') + '</script>'.length;
if (styleStart < 0 || bodyStart < 0 || scriptStart < 0) throw new Error('구간을 못 찾음');

const styleBlock = s.slice(styleStart, s.indexOf('</style>', styleStart) + '</style>'.length);
const bodyBlock = s.slice(bodyStart, scriptStart).trimEnd();
const scriptBlock = s.slice(scriptStart, scriptEnd);

const ts = `// 상세페이지 본문. 원본은 Downloads/까꿍디미방 이유식 (수정).html 이고,
// scripts 로 옮겨 붙인 것이라 손으로 고치지 말고 원본을 고친 뒤 다시 생성할 것.
export const INTRO_FONT_HREF = ${JSON.stringify(fontHref)};

export const INTRO_STYLE = ${JSON.stringify(styleBlock)};

export const INTRO_BODY = ${JSON.stringify(bodyBlock)};

// <script> 껍데기를 벗긴 알맹이. next/script 로 실어야 클라이언트 이동 때도 함수가 산다.
export const INTRO_SCRIPT = ${JSON.stringify(scriptBlock.replace(/^<script>/, '').replace(/<\/script>$/, '').trim())};
`;
writeFileSync(`${APP}/app/intro-html.ts`, ts, 'utf8');

const out = [...log, ''];
if (fails.length) out.push('[실패]', ...fails, '');
out.push(`구글폰트: ${fontHref ? '있음' : '없음'}`);
out.push(`style ${Math.round(styleBlock.length / 1024)}KB / 본문 ${Math.round(bodyBlock.length / 1024)}KB / script ${scriptBlock.length}자`);
out.push(`app/intro-html.ts ${Math.round(ts.length / 1024)}KB 생성`);
out.push('');
const cnt = k => (styleBlock + bodyBlock).split(k).length - 1;
out.push('[확인]');
out.push(`  남은 base64: ${cnt('data:image')}건 (0이어야 함)`);
out.push(`  /intro/ 참조: ${cnt('/intro/')}건`);
out.push(`  /order 링크: ${cnt('href="/order"')}건`);
out.push(`  카카오채널: ${cnt('카카오채널')}건`);
out.push(`  전화·이메일: ${cnt('02-2696-1228')} · ${cnt('kkdmb@naver.com')}건`);
writeFileSync('build-intro.txt', out.join('\n') + '\n', 'utf8');
