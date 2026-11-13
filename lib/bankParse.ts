import * as XLSX from 'xlsx';

/*
  은행 거래내역 파일(국민은행 '거래내역조회' .xls) → 입금 줄 목록.
  첫 몇 줄은 계좌 요약이고, '거래일시'·'입금액' 이 있는 줄이 머리줄이다.
  머리줄 위치를 찾아서 읽으므로 요약 줄 수가 바뀌어도 된다.
  출금은 버리고 입금만 돌려준다.
*/
export type BankDeposit = {
  deposited_at: string;   // ISO (+09:00)
  depositor: string;
  amount: number;
  balance_after: number | null;
  bank_memo: string | null;
};

export function parseBankFile(buf: ArrayBuffer | Buffer): { rows: BankDeposit[]; error?: string } {
  const wb = XLSX.read(buf, { type: buf instanceof ArrayBuffer ? 'array' : 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { rows: [], error: '시트가 없어요' };
  const grid: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const hi = grid.findIndex(r => r.some(c => String(c).replace(/\s/g, '') === '거래일시') && r.some(c => String(c).includes('입금액')));
  if (hi < 0) return { rows: [], error: "'거래일시'·'입금액' 머리줄을 못 찾았어요 — 국민은행 거래내역 파일이 맞는지 확인해 주세요" };
  const head = grid[hi].map(c => String(c).replace(/\s/g, ''));
  const col = (name: string) => head.findIndex(h => h.startsWith(name));
  const cAt = col('거래일시'), cWho = col('보낸분'), cIn = col('입금액'), cBal = col('잔액'), cMemo = col('메모'), cJeok = col('적요'), cBr = col('처리점');
  const num = (v: any) => {
    const n = Number(String(v).replace(/[,\s원]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const rows: BankDeposit[] = [];
  for (const r of grid.slice(hi + 1)) {
    const at = String(r[cAt] ?? '').trim();
    const m = at.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!m) continue;
    const amount = num(r[cIn]);
    if (amount <= 0) continue;
    const p = (s: string | undefined, w = 2) => String(s ?? '0').padStart(w, '0');
    rows.push({
      deposited_at: `${m[1]}-${p(m[2])}-${p(m[3])}T${p(m[4])}:${m[5]}:${p(m[6])}+09:00`,
      depositor: String(r[cWho] ?? '').trim(),
      amount: Math.round(amount),
      balance_after: cBal >= 0 && String(r[cBal]).trim() !== '' ? Math.round(num(r[cBal])) : null,
      bank_memo: [cMemo, cJeok, cBr].filter(i => i >= 0).map(i => String(r[i] ?? '').trim()).filter(Boolean).join(' · ') || null,
    });
  }
  return { rows };
}
