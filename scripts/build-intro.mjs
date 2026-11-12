// 상세페이지 HTML → 자사몰(baby-food-order) /  페이지로 옮긴다.
//  1) base64 이미지 9장을 public/intro/ 파일로 빼낸다 (244KB를 번들에서 제거)
//  2) 스마트스토어용으로 뺐던 연락처·주문 동선을 자사몰용으로 되살린다
//  3) <style> + 본문만 추려 app/intro-html.ts 로 내보낸다
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';

const SRC = 'C:/Users/차니파파/Downloads/까꿍디미방 이유식 (수정).html';
const APP = 'C:/Users/차니파파/Desktop/baby-food-order';
let s = readFileSync(SRC, 'utf8');
const log = [], fails = [];

// ── 1. 이미지 추출 ──
// 이미지는 본문에 나오는 순서대로 1,2,3… 번호를 받는다. 그래서 섹션 순서를 바꾸거나
// 사진을 한 장 끼우면 번호가 밀리고, 확장자까지 달라지면(20.jpg → 20.webp) 옛 파일이
// 아무도 안 쓰는 채로 남는다. 실제로 6개 338KB 가 그렇게 배포되고 있었다.
// 매번 비우고 새로 쓴다 — 참조와 파일이 늘 1:1 이 된다.
mkdirSync(`${APP}/public/intro`, { recursive: true });
let wiped = 0;
for (const f of readdirSync(`${APP}/public/intro`)) {
  rmSync(`${APP}/public/intro/${f}`); wiped++;
}
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
log.push(`public/intro 비움 ${wiped}개 → 이미지 ${n}장 추출 (${Math.round(saved / 1024)}KB)`);

// ── 2. 자사몰용 복구 ──
const edits = [
  // 수상 기사 링크는 자사몰에만 단다 — 스마트스토어는 외부 링크를 직거래 유도로 본다.
  // 기사(2023-02-09)는 수상 연도도 주최도 적지 않았다. '2022'·'국민일보 주최' 를
  // 적었던 것을 치워서, 여기 문구는 기사로 확인되는 것만 남긴다.
  ['수상 · 국민일보 기사 링크 (자사몰만)',
`    <span style="font-size:12px;color:var(--fg-soft);">국민일보 2023년 2월 9일 보도</span>`,
`    <a href="https://www.kmib.co.kr/article/20230209500503" target="_blank" rel="noopener"
       style="font-size:12px;color:var(--fg-soft);text-decoration:underline;text-underline-offset:3px;">국민일보 2023년 2월 9일 보도 &rsaquo;</a>`],

  // 자사몰 상단바에만 주문 동선을 단다. 스마트스토어는 외부 링크가 막혀 있고,
  // 어차피 그 페이지 안에 구매 버튼이 따로 붙는다.
  ['상단바 · 주문 링크 (자사몰만)',
`  <p class="w"><strong>주문 안 하셔도 상담만 하셔도 됩니다</strong> · 10년째 같은 주방 · 강서구 화곡동</p>`,
`  <p class="w"><strong>주문 안 하셔도 상담만 하셔도 됩니다</strong> · 10년째 같은 주방 · <a href="/order" style="color:inherit;text-decoration:underline;text-underline-offset:3px;">주문하기</a></p>`],

  ['주문 섹션 · 주문하기 버튼 복구',
`    <p class="cta-info">문의는 평일 오전 9시~오후 5시에 받습니다 · 배송은 3팩부터</p>`,
`    <div class="cta-btns">
      <a href="/order" class="btn-w">주문하러 가기</a>
    </div>
    <p class="cta-info">문의는 평일 오전 9시~오후 5시에 받습니다 · 배송은 3팩부터 · 카카오채널 <strong>까꿍디미방</strong></p>`],

  ['꼬리말 · 전화·이메일 복구 (자사몰은 전자상거래법 직접 적용)',
`      (07760) 서울특별시 강서구 강서로12길 22, 1층 102호`,
`      (07760) 서울특별시 강서구 강서로12길 22, 1층 102호<br>
      전화 02-2696-1228 · 이메일 kkdmb@naver.com`],
];
// 식단표·재료 탭은 자사몰에서만 DB 로 그린다.
// 원본에 @@NAME_START … @@NAME_END 로 구간을 표시해 두었고, 그 구간을 통째로
// 한 줄 슬롯으로 바꾼다. app/page.tsx 가 그 자리에 그 주 식단을 넣어 그린다.
// 스마트스토어는 원본을 그대로 쓰니 정적 표가 남는다 (그쪽은 월초에 붙여넣는 수밖에 없다).
const slots = ['MENU_CALENDAR', 'INGREDIENTS'];
for (const key of slots) {
  const re = new RegExp(`[ \\t]*<!-- @@${key}_START[\\s\\S]*?<!-- @@${key}_END -->\\n?`);
  if (!re.test(s)) { fails.push(`${key} 구간 표시를 원본에서 못 찾음`); continue; }
  s = s.replace(re, `    <!--@${key}-->\n`);
  log.push(`OK  ${key} → live 슬롯 (자사몰만)`);
}

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
// 슬롯이 각각 1개여야 app/page.tsx 가 식단을 꽂을 자리를 찾는다
for (const key of slots) out.push(`  <!--@${key}-->: ${cnt(`<!--@${key}-->`)}건 (1이어야 함)`);
out.push(`  남은 @@구간 표시: ${cnt('@@')}건 (0이어야 함)`);
writeFileSync('build-intro.txt', out.join('\n') + '\n', 'utf8');
