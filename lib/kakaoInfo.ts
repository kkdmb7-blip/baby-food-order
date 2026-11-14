/*
  카톡으로 받은 손님 정보 붙여넣기 → 칸 채우기 (정보 넣기 판)
  2026-11-14 사장님: "정보 넣기도 카톡 붙여넣으면 정보 파싱되게"

  손님마다 적는 모양이 달라서 두 가지로 읽는다.
    ① '주소: …', '연락처 010…', '공동현관 #1234' 처럼 이름표가 붙은 줄
    ② 이름표가 없으면 모양으로 — 010 번호, '○개월', 시·구·로·길 이 들어간 줄(주소), '101동 1203호'
  못 읽은 칸은 비워 둔다(지어내지 않는다). 사장님이 보고 고친다.
*/
export type KakaoInfo = {
  phone?: string; months?: string; address?: string; detail?: string; door?: string;
  receive?: '배송' | '픽업'; zone?: '직배송' | '당일배송' | '택배익일배송';
};

const PHONE = /01[016789][-\s.)]*\d{3,4}[-\s.]*\d{4}/;
const DETAIL = /(\d{1,4})\s*(?:동|-)\s*(\d{1,5})\s*호?/;
const ADDR_HINT = /(서울|경기|인천|부산|대구|광주|대전|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주|[가-힣]+(시|군|구))\s*\S*\s*.*?([가-힣0-9]+(로|길|동|읍|면|리))\s*\d/;

function label(line: string, re: RegExp): string | null {
  const m = line.match(new RegExp(`^\\s*[-*•·]?\\s*(?:${re.source})\\s*[:：)\\]]?\\s*(.+)$`));
  return m ? m[m.length - 1].trim() : null;
}

export function parseKakaoInfo(text: string): KakaoInfo {
  const out: KakaoInfo = {};
  const lines = String(text || '').split(/\r?\n/).map(l => l.replace(/​/g, '').trim()).filter(Boolean);
  for (const l of lines) {
    let v: string | null;
    if (!out.phone && (v = label(l, /(연락처|전화번호|전화|핸드폰|휴대폰|번호|폰)/))) { const m = v.match(PHONE); if (m) out.phone = m[0].replace(/\D/g, ''); continue; }
    if (!out.door && (v = label(l, /(공동\s*현관\s*(비번|비밀번호)?|현관\s*(비번|비밀번호)?|출입\s*(비번|비밀번호)?|비번|비밀번호)/))) { out.door = v.slice(0, 30); continue; }
    if (!out.detail && (v = label(l, /(상세\s*주소|동\s*호수|동호수|상세)/))) { out.detail = v.slice(0, 100); continue; }
    if (!out.address && (v = label(l, /(배송지\s*주소|받는\s*주소|주소지|주소|배송지)/))) { out.address = v.slice(0, 200); continue; }
    if (!out.months && (v = label(l, /(개월\s*수|개월|월령|아기\s*개월)/))) { const m = v.match(/\d{1,2}/); if (m) out.months = m[0]; continue; }
    if (!out.receive && (v = label(l, /(받는\s*방법|수령\s*방법|배송\s*방법|수령)/))) {
      if (/픽업|방문/.test(v)) out.receive = '픽업';
      else if (/택배/.test(v)) { out.receive = '배송'; out.zone = '택배익일배송'; }
      continue;
    }
  }
  // 이름표 없는 줄 — 모양으로
  const all = lines.join('\n');
  if (!out.phone) { const m = all.match(PHONE); if (m) out.phone = m[0].replace(/\D/g, ''); }
  if (!out.months) { const m = all.match(/(\d{1,2})\s*개월/); if (m) out.months = m[1]; }
  if (!out.address) {
    const l = lines.find(x => ADDR_HINT.test(x) && !PHONE.test(x));
    if (l) out.address = l.slice(0, 200);
  }
  // 주소 줄 끝에 '101동 1203호' 가 붙어 있으면 떼어 상세로
  if (out.address && !out.detail) {
    const m = out.address.match(/[,\s]\s*((\d{1,4})\s*동\s*(\d{1,5})\s*호.*)$/);
    if (m) { out.detail = m[1].trim(); out.address = out.address.slice(0, m.index).replace(/[,\s]+$/, ''); }
  }
  if (!out.detail) { const l = lines.find(x => DETAIL.test(x) && /동|호/.test(x) && x !== out.address && !PHONE.test(x)); if (l) out.detail = l.match(/\d{1,4}\s*동\s*\d{1,5}\s*호?/)?.[0]; }
  if (!out.door) { const m = all.match(/(?:공동\s*현관|현관|비번|비밀번호)[^0-9#*]{0,6}([#*]?\d[\d#*]{2,9}[#*]?)/); if (m) out.door = m[1]; }
  if (!out.receive && /픽업/.test(all)) out.receive = '픽업';
  if (!out.zone && /택배/.test(all) && out.receive !== '픽업') { out.receive = '배송'; out.zone = '택배익일배송'; }
  if (!out.zone && out.address) out.zone = /강서구|양천구/.test(out.address) ? '직배송' : undefined;
  return out;
}
