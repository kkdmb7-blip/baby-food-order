import type { WeekMenu, DayMenu } from './weeklyMenu';

/*
  상세페이지(자사몰)의 식단표·재료 탭을 DB 값으로 그린다.

  왜 HTML 문자열로 만드나
    상세페이지 본문은 app/intro-html.ts 에 문자열로 들어 있고 통째로
    dangerouslySetInnerHTML 로 꽂힌다. 재료 탭 버튼이 onclick="switchIng(...)" 를
    쓰는데 이건 React 엘리먼트로 바꾸면 안 먹는다(속성이 아니라 핸들러가 된다).
    같은 문자열 안에서 치환하면 기존 스크립트와 CSS 가 그대로 산다.

  클래스는 원본 정적 표에 있던 것을 그대로 쓴다 —
    .menu-calendar .cal-head .cal-dh .cal-body .cal-cell .cal-date .cal-menu
    .ingredient-tabs .ing-tab .ing-tags .ing-tag
*/

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── 원산지 ────────────────────────────────────────────────────
// 페이지의 '원산지' 섹션에 적어 둔 것과 같은 목록이다. 거기 없는 재료는 국내산이라고
// 페이지가 명시하고 있으므로 여기서도 그렇게 처리한다.
// 이유식 기준이다 — 새우·소고기는 반찬에만 수입을 쓰고 이유식은 국내산이라
// 이 표에 넣지 않는다.
const IMPORTED_IN_BABYFOOD: Record<string, string> = {
  '메로생선': '원양', '메로': '원양', '대구살': '원양', '대구': '원양',
  '연어': '노르웨이',
  '단호박': '뉴질랜드',
  '렌틸콩': '캐나다', '오트밀': '캐나다', '흰강낭콩': '캐나다', '햄프시드': '캐나다',
  '병아리콩': '이집트',
  '퀴노아': '페루', '아마란스': '페루', '아보카도': '페루',
  '파로': '이탈리아',
  '치아씨드': '멕시코',
  '테프': '에티오피아',
};

// DB 에 적힌 대로면 '한우육수 · 채소상탕 · 느타리' 처럼 붙어 있다.
// 손님이 읽는 자리라 띄우고 풀어서 적는다 (정적 표에서도 그렇게 적었다).
const DISPLAY: Record<string, string> = {
  '한우육수': '한우 육수', '닭육수': '닭 육수', '소고기육수': '소고기 육수',
  '채소상탕': '채소 육수', '상탕': '채소 육수', '채수': '채소 육수',
  '느타리': '느타리버섯', '팽이': '팽이버섯', '만가닥': '만가닥버섯',
};

function originOf(name: string): string | null {
  return IMPORTED_IN_BABYFOOD[name] ?? null;
}

function splitIngredients(raw: string): string[] {
  return String(raw || '')
    .split(/[,·]/)
    .map(t => t.trim())
    .filter(Boolean);
}

// ── 식단표 ────────────────────────────────────────────────────
const DOW_KOR = ['월', '화', '수', '목', '금'];

function cellHtml(d: DayMenu | undefined): string {
  if (!d) return `<div class="cal-cell"></div>`;
  const lines = d.isBanchan
    ? [`<span style="color:var(--brown);font-weight:700;">유아식</span>`,
       ...d.lines.map(l => `<span>${esc(l)}</span>`)]
    : d.lines.map(l => `<span>${esc(l)}</span>`);
  // 오늘 칸은 테두리로만 표시한다 — 색을 더 넣으면 유아식 표시와 섞인다
  const today = d.isToday ? ` style="box-shadow:inset 0 0 0 2px var(--green);border-radius:10px;"` : '';
  return `<div class="cal-cell"${today}><span class="cal-date">${d.dayNum}</span>`
    + `<div class="cal-menu">${lines.join('')}</div></div>`;
}

function shift(iso: string, n: number): string {
  return new Date(new Date(iso + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
}

function fmtKor(iso: string): string {
  return `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일`;
}

export function renderMenuCalendar(weeks: WeekMenu[]): string {
  if (!weeks.length) {
    // 지난 식단을 보여주는 것보다 없다고 말하는 게 낫다
    return `    <p class="sub" style="margin-top:-6px;">이번 주 식단은 문의해 주시면 바로 알려드립니다.</p>
    <p class="sub">재료 궁합을 보고 식단을 짜고, 한 주 안에서 같은 재료가 겹치지 않게 작성합니다.</p>`;
  }

  const all = weeks.flatMap(w => w.days);
  const first = all[0].date;
  const last = all[all.length - 1].date;

  // 주마다 월~금 다섯 칸을 반드시 채운다. 식단이 없는 날은 빈 칸 —
  // 안 그러면 달력 열이 밀려서 수요일이 다른 요일 자리에 간다.
  const cells: string[] = [];
  for (const w of weeks) {
    const byDate = new Map(w.days.map(d => [d.date, d]));
    for (let i = 0; i < 5; i++) cells.push(cellHtml(byDate.get(shift(w.monday, i))));
  }

  const note = weeks.length < 2
    ? '다음 주 식단은 준비되는 대로 이 자리에 올립니다. 미리 알고 싶으시면 문의해 주세요.'
    : '그 이후 식단은 문의하시면 알려드립니다.';

  return `    <p class="sub" style="margin-top:-6px;"><b>${fmtKor(first)} ~ ${fmtKor(last)}</b> 식단입니다.</p>
    <p class="sub">재료 궁합을 보고 식단을 짜고, 한 주 안에서 같은 재료가 겹치지 않게 작성합니다. ${note}</p>

    <div class="menu-calendar">
      <div class="cal-head">
        ${DOW_KOR.map(d => `<div class="cal-dh">${d}</div>`).join('')}
      </div>
      <div class="cal-body">
        ${cells.join('\n        ')}
      </div>
    </div>`;
}

// ── 재료 투명성 ───────────────────────────────────────────────
// 기존 스크립트(switchIng)가 ing-beef / ing-chicken / ing-pork 라는 고정 id 와
// ['beef','chicken','pork'] 고정 배열을 쓴다. 메뉴가 세 가지라 그대로 맞춰 쓴다.
const TAB_KEYS = ['beef', 'chicken', 'pork'];

export function renderIngredients(day: DayMenu | null): string {
  if (!day || !day.menus.length) {
    return `    <p class="sub">그날 들어간 재료는 식단표의 메뉴 이름으로 확인하실 수 있습니다. 더 자세한 재료는 문의해 주세요.</p>`;
  }
  const menus = day.menus.slice(0, TAB_KEYS.length);

  const tabs = menus.map((m, i) =>
    `<button class="ing-tab${i === 0 ? ' active' : ''}" onclick="switchIng(this,'${TAB_KEYS[i]}')">${esc(m.name)}</button>`
  ).join('\n      ');

  const panels = menus.map((m, i) => {
    // 이유식은 쌀로 쑨다. DB 재료줄에는 안 적혀 있는데 손님이 보는 표에는 있어야 한다.
    const names = splitIngredients(m.ingredients);
    if (!names.some(n => n.startsWith('쌀'))) names.push('쌀');
    const tags = names.map(n => {
      const label = DISPLAY[n] || n;
      const origin = originOf(n);
      return origin
        ? `<span class="ing-tag" style="color:var(--accent);border-color:var(--accent);">${esc(label)} (${esc(origin)})</span>`
        : `<span class="ing-tag">${esc(label)} (국내산)</span>`;
    }).join('\n      ');
    return `    <div id="ing-${TAB_KEYS[i]}" class="ing-tags"${i === 0 ? '' : ' style="display:none"'}>
      ${tags}
    </div>`;
  }).join('\n');

  return `    <div class="ingredient-tabs">
      ${tabs}
    </div>

${panels}`;
}

// ── 슬롯 채우기 ───────────────────────────────────────────────
export function fillIntroSlots(
  body: string,
  data: { weeks: WeekMenu[]; ingDay: DayMenu | null },
): string {
  return body
    .replace('<!--@MENU_CALENDAR-->', () => renderMenuCalendar(data.weeks))
    .replace('<!--@INGREDIENTS-->', () => renderIngredients(data.ingDay));
}

/** 그날 메뉴를 쓴 제목·설명 (검색 결과에 뜨는 글) */
export function introDescription(weeks: WeekMenu[]): string | null {
  const all = weeks.flatMap(w => w.days).filter(d => !d.isBanchan);
  if (!all.length) return null;
  const names = all[all.length - 1].lines.slice(0, 3).join(' · ');
  return names || null;
}
