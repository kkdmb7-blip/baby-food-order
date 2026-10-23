/*
  이름에 조사를 붙인다.

  왜 필요한가: 손님께 보내는 문구를 `${babyName}가 잘 먹었는지` 로 만들었더니
  실제로 "민준가 이유식 잘 먹었는지" 가 나왔다. 받침이 있는 이름에는 '이' 가 붙는다.
  가게가 보내는 문장이 어색하면 성의 없이 보낸 것으로 읽힌다 — 아이 이름이 들어가는
  문장이라 더 그렇다.

  한글 음절은 0xAC00 부터 (초성×21×28 + 중성×28 + 종성) 순으로 놓여 있어서,
  (코드 - 0xAC00) % 28 이 0 이면 받침이 없다.
  한글이 아닌 이름(영문·숫자)은 판단할 근거가 없으니 조사를 빼고 돌려준다.
*/

function hasFinalConsonant(ch: string): boolean | null {
  const c = ch.charCodeAt(0);
  if (c < 0xac00 || c > 0xd7a3) return null;   // 한글 음절이 아니다
  return (c - 0xac00) % 28 !== 0;
}

/** 이/가 — "민준이", "시우가" */
export function withSubject(name: string): string {
  const n = (name || '').trim();
  if (!n) return '';
  const f = hasFinalConsonant(n[n.length - 1]);
  if (f === null) return n;                     // 모르면 조사를 붙이지 않는다
  return n + (f ? '이' : '가');
}

/** 은/는 — "민준은", "시우는" */
export function withTopic(name: string): string {
  const n = (name || '').trim();
  if (!n) return '';
  const f = hasFinalConsonant(n[n.length - 1]);
  if (f === null) return n;
  return n + (f ? '은' : '는');
}
