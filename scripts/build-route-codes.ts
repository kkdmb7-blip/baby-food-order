/*
  배송 순번표(lib/routeCodes.json)를 사장님 엑셀 '전체주소록'(이름·주소·순번)에서 다시 만든다.
  사용: npx tsx scripts/build-route-codes.ts <전체주소록.json> [--write]
    <전체주소록.json> = { rows: [{ name, address, code }] }  (엑셀은 매크로를 열지 않고 값만 읽어 만든다)
  키는 lib/routeCode.ts 의 addrKey 와 같은 규칙 — 규칙을 고치면 이 표도 다시 만들어야 맞는다.
  같은 키에 순번이 여러 개면 가장 많이 쓴 번호(같으면 먼저 나온 번호).
*/
import fs from 'node:fs';
import path from 'node:path';
import { addrKey } from '../lib/routeCode';

const [, , src, flag] = process.argv;
const rows: { name: string; address: string; code: number }[] = JSON.parse(fs.readFileSync(src, 'utf8')).rows;
const tally = new Map<string, Map<number, number>>();
for (const r of rows) {
  const k = addrKey(r.address);
  if (!k) continue;
  if (!tally.has(k)) tally.set(k, new Map());
  const t = tally.get(k)!;
  t.set(r.code, (t.get(r.code) || 0) + 1);
}
const byAddr: Record<string, number> = {};
let conflicts = 0;
for (const [k, t] of tally) {
  const best = [...t.entries()].sort((a, b) => b[1] - a[1])[0];
  if (t.size > 1) conflicts++;
  byAddr[k] = best[0];
}
// 스스로 맞는지: 엑셀 줄마다 그 주소로 찾은 순번 = 엑셀에 적힌 순번?
const ok = rows.filter(r => { const k = addrKey(r.address); return k && byAddr[k] === r.code; }).length;
console.log(`rows ${rows.length} · keys ${Object.keys(byAddr).length} · 키 하나에 번호 여러 개 ${conflicts} · 엑셀과 같은 번호 ${ok}/${rows.length} (${(ok / rows.length * 100).toFixed(1)}%)`);

/* 이름+주소 → 번호. 사장님 번호는 주소가 아니라 '손님마다' 매겨져 있다
   (같은 목동동로 430 603동에 35와 30, 615동에 31과 15.5). 그래서 이름과 주소가 둘 다 같은 줄의 번호를 먼저 쓴다.
   이름만으로는 안 찾는다 — 동명이인이 다른 동네와 섞였던 사고가 있었다(강남 '수아'가 화곡2동으로). */
const byNameAddr: Record<string, number> = {};
const na = new Map<string, Map<number, number>>();
for (const r of rows) {
  const k = addrKey(r.address);
  if (!k || !r.name) continue;
  const key = `${r.name}|${k}`;
  if (!na.has(key)) na.set(key, new Map());
  const t = na.get(key)!;
  t.set(r.code, (t.get(r.code) || 0) + 1);
}
for (const [k, t] of na) byNameAddr[k] = [...t.entries()].sort((a, b) => b[1] - a[1])[0][0];
console.log(`이름+주소 키 ${Object.keys(byNameAddr).length}`);

if (flag === '--write') {
  const out = path.join(__dirname, '..', 'lib', 'routeCodes.json');
  const old = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.writeFileSync(out, JSON.stringify({ ...old, byAddr, byNameAddr }));
  console.log('wrote', out);
}
