# 이유식 주문 시스템

카카오톡 플친 [주문하기] 버튼 → 모바일 주문폼 → 관리자 페이지.

**스택**: Next.js 14 (App Router) + Supabase + Tailwind + Resend (이메일).

---

## 디렉터리

```
app/
  order/page.tsx          # 고객 주문폼 (6단계)
  admin/
    page.tsx              # 관리자 대시보드 (서버 컴포넌트)
    AdminClient.tsx       # 클라이언트 — 상태 변경·필터·다운로드
    login/page.tsx        # 비밀번호 로그인
    print/
      PrintAuto.tsx       # 진입 시 자동 인쇄 다이얼로그
      quantity/page.tsx   # 단계별 수량 합계 + 제작 상세표
      labels/page.tsx     # 배송 라벨 (2단 그리드)
  api/
    orders/route.ts       # POST 신규 주문 (anon), GET 목록 (admin)
    orders/[id]/route.ts  # PATCH 상태 변경 (admin)
    auth/route.ts         # POST 로그인, DELETE 로그아웃
    notify/route.ts       # 신규 주문 → 관리자 메일 (Resend)
    export/route.ts       # 엑셀 다운로드 (xlsx)
lib/
  supabase.ts             # service / anon 클라이언트
  auth.ts                 # 쿠키 기반 admin 세션
  dates.ts                # KST 헬퍼 + 배송일 옵션
supabase/
  schema.sql              # baby_food_orders 테이블 + RLS
```

---

## 1. 셋업 (5분)

### 1-1. 의존성 설치

```bash
npm install
```

### 1-2. Supabase 테이블 생성

Supabase 대시보드 → SQL Editor → `supabase/schema.sql` 내용 실행.

> 같은 프로젝트(ymghmfkqctckxxysxkvy)에 silk PDF 주문용 `orders` 테이블이 이미 있어
> **`baby_food_orders`** 라는 다른 이름으로 만들었습니다. 충돌 없음.

### 1-3. Supabase service_role 키 확보

Supabase 대시보드 → Project Settings → API →
- `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
- `anon public` → `NEXT_PUBLIC_SUPABASE_ANON_KEY` (지금은 미사용이지만 추후 대비)
- `service_role` → `SUPABASE_SERVICE_ROLE_KEY` (**절대 클라이언트 노출 금지**)

### 1-4. .env.local 작성

```bash
cp .env.local.example .env.local
# 값 채우기
```

| 변수 | 필수 | 설명 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | https://ymghmfkqctckxxysxkvy.supabase.co |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | sb_publishable_... |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | eyJhbGc... (서버 전용) |
| `ADMIN_PASSWORD` | ✅ | 관리자 비밀번호 (강하게) |
| `ADMIN_EMAIL` | ✅ | 신규주문 알림 받을 메일 |
| `RESEND_API_KEY` | 선택 | re_... — 없으면 메일 알림만 스킵 |
| `NOTIFY_FROM_EMAIL` | 선택 | 발신자 (Resend 도메인 인증 필요) |
| `NEXT_PUBLIC_STORE_NAME` | 선택 | 라벨 프린트에 표시될 가게명 |

### 1-5. 로컬 실행

```bash
npm run dev
# http://localhost:3000  → 자동으로 /order 로 리다이렉트
```

---

## 2. 사용 흐름

### 고객 (모바일)
1. 카톡 플친 [주문하기] → `https://your-domain.com/order`
2. 6단계 버튼 선택 → 주문 완료

### 관리자
1. `/admin/login` 비밀번호 입력 → 8시간 유효 쿠키
2. `/admin` 주문 목록 (배송일 그룹·상태 뱃지)
3. 상태 뱃지 클릭 = **다음 상태로 이동** (접수→준비중→배송완료→접수)
   또는 우측 select 로 직접 지정
4. 액션 버튼:
   - **📋 오늘 수량 프린트** — 단계별 합계 + 주문 상세 (제작용)
   - **🏷 배송 라벨** — 2단 그리드 라벨
   - **📊 엑셀 다운로드** — 조회 기간 전체 xlsx

---

## 3. Vercel 배포

1. GitHub 레포 푸시
2. [vercel.com](https://vercel.com) → New Project → 레포 import
3. **Environment Variables** 섹션에 위 7개 변수 모두 등록 (Production + Preview + Development 다 체크)
4. Deploy

> ⚠️ **Vercel Hobby plan**은 상업용 사용 ToS 위반이에요. 매출 발생하면 **Pro $20/월** 전환.
> 카톡 플친에서 트래픽 들어오면 Pro 가는 게 안전합니다.

### 카톡 플친 [주문하기] 버튼 연결

카카오톡 채널 관리자센터 → 비즈도구 → 메시지/링크 → 배포된 URL `https://your-domain.com/order` 연결.

---

## 4. 보안 요약

- `baby_food_orders` 테이블 RLS **enabled**, anon 정책 없음 → 직접 INSERT 불가
- 모든 쓰기는 `/api/orders` 서버 라우트가 service_role 키로 처리
- 관리자 페이지는 `httpOnly` 쿠키 세션 (8시간) — service_role 키는 서버에만 머묾
- `ADMIN_PASSWORD` 평문 비교지만 service_role 키 노출 안 되므로 비밀번호 leak 시에도 DB 직접 변경 불가

---

## 5. 추가하기 좋은 것 (현 시점 미포함)

- **결제 연동** — 포트원 V2 등 (현재는 무통장/현금배송 가정)
- **카톡 알림톡** — 주문 접수 즉시 고객에게 (Aligo, NHN 등)
- **주문 수정/취소 페이지** — 고객 본인용 mypage
- **재고 관리** — stage별 일일 한도 + 마감 표시
- **할인/쿠폰** — 코드 입력 → 가격 조정
- **반복 주문** — 매주 같은 메뉴 자동 발생
