import webpush from 'web-push';
import type { SupabaseClient } from '@supabase/supabase-js';

let configured = false;
function ensureConfigured() {
  if (configured) return;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!pub || !priv || !subject) return; // 미설정 시 조용히 스킵 (알림은 부가기능이라 주문 흐름을 막으면 안 됨)
  webpush.setVapidDetails(subject, pub, priv);
  configured = true;
}

// 홈 화면 상태배너와 같은 문구로 통일
export function statusPushText(status: string, deliveryDate: string): { title: string; body: string } | null {
  if (status === '준비중') return { title: '🧑‍🍳 주문을 준비하고 있어요!', body: `${deliveryDate} 배송분` };
  if (status === '배송중') return { title: '🚚 배송을 출발했어요!', body: `${deliveryDate} 배송분 · 곧 도착합니다` };
  if (status === '배송완료') return { title: '✅ 배송이 완료됐어요!', body: `${deliveryDate} 배송분` };
  if (status === '취소') return { title: '❌ 주문이 취소됐어요', body: `${deliveryDate} 배송분` };
  return null;
}

// 배송상태 변경 시 해당 연락처로 구독된 모든 기기에 푸시 발송 — 실패해도 호출부 흐름은 막지 않음
export async function sendStatusPush(sb: SupabaseClient, phone: string, title: string, body: string) {
  try {
    ensureConfigured();
    if (!configured) return;
    const { data: subs } = await sb
      .from('baby_food_push_subscriptions').select('id, endpoint, p256dh, auth').eq('customer_phone', phone);
    if (!subs || subs.length === 0) return;

    const payload = JSON.stringify({ title, body, url: '/order' });
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload
        );
      } catch (e: any) {
        // 만료/삭제된 구독(410/404)은 정리
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          await sb.from('baby_food_push_subscriptions').delete().eq('id', s.id);
        } else {
          console.error('[push send]', e?.message || e);
        }
      }
    }));
  } catch (e) { console.error('[sendStatusPush]', e); }
}
