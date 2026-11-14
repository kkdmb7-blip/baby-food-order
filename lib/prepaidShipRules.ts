// 택배비 선결제 숫자 — 화면(클라이언트)과 서버(lib/prepaidShip)가 같이 쓴다.
// 2026-11-14 사장님: "보통 30000원 10회 해서 5팩까지는 1회 차감"
export const SHIP_PACKS_PER_BOX = 5;
export const SHIP_CHARGE = { times: 10, won: 30000 };
