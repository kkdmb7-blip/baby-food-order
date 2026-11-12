// 배송 도착 메시지 기본 문구 — 사장님이 글을 안 적고 보낼 때 쓴다(여러 건 한꺼번에).
// 관리화면 입력칸의 기본값과 서버가 같은 문구를 쓰도록 한 곳에 둔다.
// 보관 방법(냉동/냉장)은 확인 안 된 내용이라 넣지 않았다 — 필요하면 사장님이 직접 덧붙인다.
export function defaultArrivalNote(name: string, receive?: string | null) {
  return receive === '픽업'
    ? `${name} 이유식 준비가 끝났습니다. 편하실 때 찾아가 주세요.`
    : `${name} 이유식이 도착했습니다. 문 앞을 확인해 주세요.`;
}
