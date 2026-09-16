/**
 * Slack `/결제` 슬래시 커맨드 — 결제 등록 모달을 연다.
 *
 * Slack App 설정 → Slash Commands → Request URL:
 *   https://your-domain/api/slack/payment
 *
 * 예전에는 `/결제 상호명 금액 담당자 메모` 형식의 텍스트 파싱이었으나,
 * 팀이 쓰던 워크플로우 폼과 항목을 맞추기 위해 모달 입력으로 바꿨다.
 * 실제 등록은 제출 시점에 /api/slack/interactive 의 view_submission 이 처리한다.
 *
 * 텍스트를 함께 친 경우(`/결제 ABC마케팅`)에는 상호명 자리에 미리 채워주지 않는다 —
 * 모달의 initial_value 로 넘기면 옛 형식과 새 형식이 섞여 헷갈리기 때문이다.
 *
 *   /결제 취소    입금완료로 잘못 올린 건을 골라 수금 예정(미입금·잔금)으로 되돌린다
 *                 (등록 직후라면 안내 메시지의 "되돌리기" 버튼이 더 빠르다)
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { verifySlackRequest, openSlackModal } from '@/lib/slack'
import { buildPaymentModal, buildRevertModal } from '@/lib/payments/modal'
import { fetchRecentConfirmedPayments } from '@/lib/payments/revert'

const REVERT_KEYWORDS = /^(취소|되돌리기|되돌림|revert|undo)$/i

const admin = createAdminClient()

export async function POST(request: Request) {
  const rawBody = await request.text()

  const verified = verifySlackRequest(rawBody, request.headers)
  if (!verified.ok) return Response.json({ error: verified.reason }, { status: 401 })

  const params = new URLSearchParams(rawBody)
  const text = (params.get('text') ?? '').trim()
  const triggerId = params.get('trigger_id') ?? ''
  const channelId = params.get('channel_id') ?? ''
  const userId = params.get('user_id') ?? ''

  if (!triggerId) {
    return Response.json({
      response_type: 'ephemeral',
      text: '❌ 모달을 열 수 없습니다 (trigger_id 없음). 다시 시도해주세요.',
    })
  }

  // ── `/결제 취소` — 되돌릴 건을 고르는 창 ─────────────────────────
  if (REVERT_KEYWORDS.test(text)) {
    const candidates = await fetchRecentConfirmedPayments(admin)
    const opened = await openSlackModal(
      triggerId,
      buildRevertModal({ candidates, channelId, userId }),
    )
    if (!opened.ok) {
      return Response.json({
        response_type: 'ephemeral',
        text: `❌ 되돌리기 창을 열지 못했습니다 (${opened.error}). 잠시 후 다시 시도해주세요.`,
      })
    }
    return new Response('', { status: 200 })
  }

  // 담당자 드롭다운 — 재직 중인 직원. 대장 순번을 따르고 없으면 이름 순.
  const { data: employees } = await admin
    .from('employees')
    .select('name, sort_order')
    .eq('active', true)
    .order('sort_order', { ascending: true, nullsFirst: false })
    .order('name')

  const managers = (employees ?? []).map((e) => e.name).filter(Boolean)
  const today = new Date().toLocaleDateString('sv-SE') // YYYY-MM-DD

  const result = await openSlackModal(
    triggerId,
    buildPaymentModal({ today, managers, channelId, userId }),
  )

  if (!result.ok) {
    return Response.json({
      response_type: 'ephemeral',
      text: [
        `❌ 결제 등록 창을 열지 못했습니다 (${result.error}).`,
        result.error === 'SLACK_BOT_TOKEN 미설정'
          ? '관리자: Railway 에 SLACK_BOT_TOKEN 을 설정해주세요.'
          : '잠시 후 다시 시도해주세요.',
      ].join('\n'),
    })
  }

  // 모달이 떴으므로 빈 200 으로 조용히 끝낸다 (채널에 남는 메시지 없음)
  return new Response('', { status: 200 })
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
