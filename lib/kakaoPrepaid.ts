/*
  카톡(플러스친구) 메모장의 선결제 정리를 그대로 읽는다 (2026-11-13)

  사장님: "지금 플러스친구 메모장에 이렇게 정리하고 있어 … 앱에서 이렇게 복사해서 붙여넣으면 저장되게"

      8/21 중230ᆞ50입              ← 충전: 단계·용량 · 팩수 + '입'
      8/24 50-3-6-3-6=32           ← 사용: 앞 잔여 − 주문들 = 남은 팩
      9/7 17-3-6-6-6=-4            ← 마이너스 = 먼저 가져가고 다음 입금에서 메움
      9/1 8-3-4=1    4개는 300     ← 뒤에 붙은 글은 메모
      10/25 96000원 2회입금 …      ← 숫자 계산이 아닌 줄은 메모
      ㅡㅡㅡㅡㅡㅡㅡㅡ후230         ← 줄긋기 = 용량이 달라서 따로 세는 묶음이 새로 시작

  적힌 계산은 고치지 않는다. 대신 두 가지를 맞춰 보고 다르면 알린다.
    ① 빼기가 맞는지 (50-3-6-3-6 이 정말 32인지)
    ② 시작 숫자가 앞 줄 결과(+그 사이 입금)와 같은지
  잔여는 적힌 마지막 결과를 그대로 쓴다 — 메모장이 원본이다.
*/

export type MemoRow = {
  line: number;          // 몇째 줄 (1부터)
  date: string | null;   // '8/21'
  kind: '입' | '사용' | '메모' | '구분';
  packs: number;         // 입 = +N, 사용 = −합계
  before: number | null; // 사용 줄의 적힌 시작 숫자
  after: number | null;  // 이 줄 뒤 잔여 (적힌 값)
  label?: string;        // 입 줄의 단계·용량 ('중기 230g')
  note?: string;         // 뒤에 붙은 글
  problem?: string;      // 계산이 안 맞을 때
};
export type MemoTrack = { label: string | null; rows: MemoRow[]; balance: number; charged: number; used: number };
export type MemoParse = { tracks: MemoTrack[]; problems: number; unread: number };

const STAGE: Record<string, string> = {
  중: '중기', 중기: '중기', 중1: '중기1', 중2: '중기2', 중기1: '중기1', 중기2: '중기2',
  후: '후기', 후기: '후기', 완: '완료기', 완료: '완료기', 완료기: '완료기', 초: '초기', 초기: '초기',
};
const stageRe = '(중기1|중기2|중기|중1|중2|중|후기|후|완료기|완료|완|초기|초)';
// 가운데 점은 'ᆞ'(아래아), '·', '.', 공백 등 여러 가지로 찍힌다
const SEP = '[\\sᆞㆍ·・.,]*';

export function labelOf(stage?: string | null, vol?: string | null): string | null {
  const st = stage ? STAGE[stage] || stage : '';
  const v = vol ? `${vol}g` : '';
  return [st, v].filter(Boolean).join(' ') || null;
}

export function parseKakaoPrepaid(text: string): MemoParse {
  const tracks: MemoTrack[] = [];
  let cur: MemoTrack = { label: null, rows: [], balance: 0, charged: 0, used: 0 };
  let pendingIn = 0;       // 마지막 사용 줄 뒤로 들어온 입금 — 다음 사용 줄 시작 숫자를 맞춰볼 때 더한다
  let known = false;       // 잔여를 알고 있는가 (묶음 첫 줄 전에는 모른다)
  let problems = 0, unread = 0;

  const lines = String(text || '').replace(/\r/g, '').split('\n');
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;

    // 줄긋기 — 새 묶음
    const sep = line.match(/^[ㅡ\-─—=_~]{4,}\s*(.*)$/);
    if (sep) {
      if (cur.rows.length) tracks.push(cur);
      const m = sep[1].replace(/\s/g, '').match(new RegExp(`^${stageRe}?(\\d{3})?`));
      cur = { label: m && (m[1] || m[2]) ? labelOf(m[1], m[2]) : (sep[1].trim() || null), rows: [], balance: 0, charged: 0, used: 0 };
      cur.rows.push({ line: i + 1, date: null, kind: '구분', packs: 0, before: null, after: null, note: sep[1].trim() || undefined });
      pendingIn = 0; known = false;
      return;
    }

    const dm = line.match(/^(\d{1,2})\s*[\/.]\s*(\d{1,2})\s*(.*)$/);
    const date = dm ? `${Number(dm[1])}/${Number(dm[2])}` : null;
    const rest = (dm ? dm[3] : line).trim();

    // 충전: '중230ᆞ50입', '후300 20입', '50입'
    const cm = rest.match(new RegExp(`^${stageRe}?\\s*(\\d{3})?${SEP}(\\d{1,3})\\s*입(?!금)\\s*(.*)$`));
    if (cm && (cm[1] || cm[2] || Number(cm[3]) > 0)) {
      const n = Number(cm[3]);
      const label = labelOf(cm[1], cm[2]);
      if (label) cur.label = label;
      cur.balance = (known ? cur.balance : 0) + n;
      known = true;
      pendingIn += n;
      cur.charged += n;
      cur.rows.push({ line: i + 1, date, kind: '입', packs: n, before: null, after: cur.balance, label: label || undefined, note: cm[4] || undefined });
      return;
    }

    // 사용: '50-3-6-3-6=32', '-5-3-4=-12'
    const um = rest.match(/^(-?\d+)((?:\s*-\s*\d+)+)\s*=\s*(-?\d+)\s*(.*)$/);
    if (um) {
      const start = Number(um[1]);
      const parts = (um[2].match(/\d+/g) || []).map(Number);
      const end = Number(um[3]);
      const sum = parts.reduce((a, b) => a + b, 0);
      const msgs: string[] = [];
      if (start - sum !== end) msgs.push(`계산이 ${start - sum}인데 ${end}로 적힘`);
      if (known && start !== cur.balance) msgs.push(`앞 줄까지 ${cur.balance}팩인데 ${start}에서 시작`);
      if (msgs.length) problems++;
      cur.used += sum;
      cur.balance = end; known = true; pendingIn = 0;
      cur.rows.push({ line: i + 1, date, kind: '사용', packs: -sum, before: start, after: end, note: um[4] || undefined, problem: msgs.join(' · ') || undefined });
      return;
    }

    // 그 밖 — 메모로 남긴다 (날짜 없는 줄도)
    if (!dm) unread++;
    cur.rows.push({ line: i + 1, date, kind: '메모', packs: 0, before: null, after: known ? cur.balance : null, note: rest || line });
  });
  if (cur.rows.length) tracks.push(cur);
  return { tracks, problems, unread };
}

/** 저장용 요약 — 묶음마다 단계·용량과 남은 팩 */
export function memoSummary(p: MemoParse) {
  return p.tracks.filter(t => t.rows.some(r => r.kind === '입' || r.kind === '사용'))
    .map(t => ({ label: t.label, balance: t.balance, charged: t.charged, used: t.used }));
}
