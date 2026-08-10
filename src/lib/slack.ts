/**
 * Slack 웹훅 공용 유틸 — 서명 검증과 메시지 전송.
 *
 * 환경변수:
 *   SLACK_SIGNING_SECRET   Slack App의 Signing Secret (요청 위조 방지 — 반드시 설정할 것)
 *   SLACK_BOT_TOKEN        xoxb- 로 시작하는 봇 토큰 (승인 요청 카드 전송·DM 알림용, 선택)
 *   SLACK_LEAVE_CHANNEL    연차 승인 요청을 받을 채널 ID (예: C01ABCDEF, 선택)
 */

import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Slack 요청 서명 검증 (HMAC-SHA256).
 *
 * SLACK_SIGNING_SECRET 이 설정되지 않았으면 검증을 건너뛴다. 개발 편의를 위한 것이며
 * 운영에서는 반드시 설정해야 한다 — 없으면 누구나 이 URL로 연차를 신청·승인할 수 있다.
 */
export function verifySlackRequest(rawBody: string, headers: Headers): { ok: true } | { ok: false; reason: string } {
  const signingSecret = process.env.SLACK_SIGNING_SECRET
  if (!signingSecret) {
    console.warn('[slack] SLACK_SIGNING_SECRET 미설정 — 서명 검증을 건너뜁니다. 운영에서는 반드시 설정하세요.')
    return { ok: true }
  }

  const timestamp = headers.get('x-slack-request-timestamp') ?? ''
  const signature = headers.get('x-slack-signature') ?? ''
  if (!timestamp || !signature) return { ok: false, reason: 'Missing signature headers' }

  // 5분 이상 된 요청 거부 (replay attack 방지)
  const now = Math.floor(Date.now() / 1000)
  const ts = parseInt(timestamp, 10)
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) return { ok: false, reason: 'Request too old' }

  const computed = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`
  const a = Buffer.from(computed)
  const b = Buffer.from(signature)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'Invalid signature' }

  return { ok: true }
}

export type SlackBlock = Record<string, unknown>

/** 채널에 메시지 전송. 봇 토큰이 없으면 no-op (앱 화면에서 승인하면 되므로 치명적이지 않다). */
export async function postSlackMessage(
  channel: string,
  text: string,
  blocks?: SlackBlock[],
): Promise<{ channel: string; ts: string } | null> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token || !channel) return null

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel, text, blocks }),
    })
    const data = await res.json()
    if (!data.ok) {
      console.error('[slack] chat.postMessage 실패:', data.error)
      return null
    }
    return { channel: data.channel, ts: data.ts }
  } catch (e) {
    console.error('[slack] chat.postMessage 예외:', e)
    return null
  }
}

/** 기존 메시지 갱신 — 승인/반려 후 버튼을 결과 텍스트로 바꾼다 */
export async function updateSlackMessage(
  channel: string,
  ts: string,
  text: string,
  blocks?: SlackBlock[],
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) return

  try {
    const res = await fetch('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel, ts, text, blocks }),
    })
    const data = await res.json()
    if (!data.ok) console.error('[slack] chat.update 실패:', data.error)
  } catch (e) {
    console.error('[slack] chat.update 예외:', e)
  }
}

/** 신청자에게 DM — 승인/반려 결과 통보 */
export async function dmSlackUser(userId: string, text: string): Promise<void> {
  if (!process.env.SLACK_BOT_TOKEN || !userId) return
  await postSlackMessage(userId, text) // chat.postMessage 는 채널 자리에 사용자 ID 를 받으면 DM 을 연다
}

/** Slack 사용자의 표시 이름 조회 — 직원 자동 매핑에 쓴다 */
export async function fetchSlackUserName(userId: string): Promise<string | null> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) return null

  try {
    const res = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json()
    if (!data.ok) return null
    const p = data.user?.profile ?? {}
    return p.real_name ?? p.display_name ?? data.user?.name ?? null
  } catch {
    return null
  }
}
