/**
 * Slack 인터랙티브 컴포넌트 수신 — 연차 승인/반려 버튼
 *
 * Slack App 설정 → Interactivity & Shortcuts → Request URL:
 *   https://your-domain/api/slack/interactive
 *
 * 승인 권한:
 *   SLACK_LEAVE_APPROVERS 에 Slack 사용자 ID 를 쉼표로 나열하면 그 사람만 버튼을 누를 수 있다.
 *   비워두면 카드가 올라간 채널에 들어올 수 있는 사람 누구나 승인할 수 있으므로,
 *   SLACK_LEAVE_CHANNEL 은 관리자만 있는 비공개 채널로 두는 것을 권한다.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { verifySlackRequest } from '@/lib/slack'
import { reviewLeaveRequest } from '@/lib/leave/review'

const admin = createAdminClient()

type BlockActionsPayload = {
  type: string
  user?: { id?: string; name?: string; username?: string }
  actions?: { action_id?: string; value?: string }[]
  response_url?: string
}

/** response_url 로 임시 메시지 회신 — 버튼을 누른 사람에게만 보인다 */
async function replyEphemeral(responseUrl: string | undefined, text: string) {
  if (!responseUrl) return
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
    })
  } catch (e) {
    console.error('[slack] response_url 회신 실패:', e)
  }
}

export async function POST(request: Request) {
  const rawBody = await request.text()

  const verified = verifySlackRequest(rawBody, request.headers)
  if (!verified.ok) return Response.json({ error: verified.reason }, { status: 401 })

  const payloadRaw = new URLSearchParams(rawBody).get('payload')
  if (!payloadRaw) return new Response('', { status: 200 })

  let payload: BlockActionsPayload
  try {
    payload = JSON.parse(payloadRaw)
  } catch {
    return new Response('', { status: 200 })
  }

  if (payload.type !== 'block_actions') return new Response('', { status: 200 })

  const action = payload.actions?.[0]
  const actionId = action?.action_id ?? ''
  const requestId = action?.value ?? ''

  if (actionId !== 'leave_approve' && actionId !== 'leave_reject') {
    return new Response('', { status: 200 })
  }
  if (!requestId) {
    await replyEphemeral(payload.response_url, '❌ 신청 ID를 읽을 수 없습니다.')
    return new Response('', { status: 200 })
  }

  // 승인자 제한
  const allowlist = (process.env.SLACK_LEAVE_APPROVERS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean)
  const clickerId = payload.user?.id ?? ''

  if (allowlist.length > 0 && !allowlist.includes(clickerId)) {
    await replyEphemeral(payload.response_url, '❌ 연차를 승인할 권한이 없습니다.')
    return new Response('', { status: 200 })
  }

  const reviewer = payload.user?.name ?? payload.user?.username ?? (clickerId || 'Slack')

  const result = await reviewLeaveRequest(admin, {
    id: requestId,
    action: actionId === 'leave_approve' ? 'approve' : 'reject',
    reviewer,
  })

  if (!result.ok) await replyEphemeral(payload.response_url, `❌ ${result.message}`)

  // 성공 시엔 원본 메시지가 이미 결과로 갱신되므로 별도 회신을 하지 않는다
  return new Response('', { status: 200 })
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
