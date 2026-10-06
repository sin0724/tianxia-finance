/**
 * Slack 인터랙티브 컴포넌트 수신
 *   - block_actions   : 연차 승인/반려 버튼, 결제 "되돌리기" 버튼
 *   - view_submission : `/결제` 모달 제출, 입금 되돌리기 모달 제출
 *
 * Slack App 설정 → Interactivity & Shortcuts → Request URL:
 *   https://your-domain/api/slack/interactive
 *
 * 연차 승인 권한:
 *   SLACK_LEAVE_APPROVERS 에 Slack 사용자 ID 를 쉼표로 나열하면 그 사람만 버튼을 누를 수 있다.
 *   비워두면 카드가 올라간 채널에 들어올 수 있는 사람 누구나 승인할 수 있으므로,
 *   SLACK_LEAVE_CHANNEL 은 관리자만 있는 비공개 채널로 두는 것을 권한다.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import {
  verifySlackRequest, postSlackMessage, dmSlackUser, openSlackModal, updateSlackMessage,
  type SlackBlock,
} from '@/lib/slack'
import { reviewLeaveRequest } from '@/lib/leave/review'
import { applyForLeave } from '@/lib/leave/apply'
import {
  PLAN_BUTTON, PLAN_MODAL_CALLBACK, PLAN_FIELD, buildPlanModal, readPlanSubmission,
} from '@/lib/leave/promotion'
import {
  LEAVE_MODAL_CALLBACK, LEAVE_CANCEL_CALLBACK, LEAVE_FIELD,
  readLeaveSubmission, readCancelSubmission,
} from '@/lib/leave/modal'
import {
  PAYMENT_MODAL_CALLBACK, PAYMENT_REVERT_CALLBACK, PAYMENT_REVERT_BUTTON, FIELD, REVERT_FIELD,
  readSubmission, readRevertSubmission, buildRevertModal, revertButtonBlock,
} from '@/lib/payments/modal'
import { registerPayment, formatKRW } from '@/lib/payments/register'
import {
  revertPaymentConfirmation, fetchConfirmedPayment, isRevertStatus, REVERT_STATUS_LABEL,
} from '@/lib/payments/revert'

const admin = createAdminClient()

type SlackUser = { id?: string; name?: string; username?: string }

type InteractivePayload = {
  type: string
  user?: SlackUser
  trigger_id?: string
  actions?: { action_id?: string; value?: string }[]
  response_url?: string
  /** block_actions — 버튼이 붙어 있던 메시지. 되돌린 뒤 이 메시지를 갱신한다 */
  channel?: { id?: string }
  message?: { ts?: string; text?: string; blocks?: { type?: string; text?: { text?: string } }[] }
  view?: {
    callback_id?: string
    private_metadata?: string
    state?: { values?: Record<string, Record<string, never>> }
  }
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

/** 결과를 커맨드를 친 채널에 올리고, 실패하면 신청자 DM 으로 대신 보낸다 */
async function announce(channelId: string, userId: string, text: string, blocks?: SlackBlock[]) {
  const posted = channelId ? await postSlackMessage(channelId, text, blocks) : null
  if (!posted && userId) await postSlackMessage(userId, text, blocks) // 사용자 ID 를 채널 자리에 넣으면 DM
}

export async function POST(request: Request) {
  const rawBody = await request.text()

  const verified = verifySlackRequest(rawBody, request.headers)
  if (!verified.ok) return Response.json({ error: verified.reason }, { status: 401 })

  const payloadRaw = new URLSearchParams(rawBody).get('payload')
  if (!payloadRaw) return new Response('', { status: 200 })

  let payload: InteractivePayload
  try {
    payload = JSON.parse(payloadRaw)
  } catch {
    return new Response('', { status: 200 })
  }

  if (payload.type === 'view_submission') {
    switch (payload.view?.callback_id) {
      case PAYMENT_MODAL_CALLBACK:  return handlePaymentSubmission(payload)
      case PAYMENT_REVERT_CALLBACK: return handleRevertSubmission(payload)
      case LEAVE_MODAL_CALLBACK:    return handleLeaveSubmission(payload)
      case LEAVE_CANCEL_CALLBACK:   return handleLeaveCancel(payload)
      case PLAN_MODAL_CALLBACK:     return handlePlanSubmission(payload)
      default: return new Response('', { status: 200 })
    }
  }
  if (payload.type === 'block_actions') {
    if (payload.actions?.[0]?.action_id === PAYMENT_REVERT_BUTTON) return handleRevertButton(payload)
    if (payload.actions?.[0]?.action_id === PLAN_BUTTON) return handlePlanButton(payload)
    return handleLeaveButton(payload)
  }

  return new Response('', { status: 200 })
}

/** 모달 제출자를 직원으로 찾는다 — 창을 열 때 이미 연결된 사람만 열 수 있으므로 조회만 한다 */
async function findEmployeeBySlackId(slackUserId: string) {
  const { data } = await admin
    .from('employees')
    .select('id, name, hired_at, work_days, employee_type, slack_user_id')
    .eq('slack_user_id', slackUserId)
    .maybeSingle()
  return data
}

// ─────────────────────────────────────────────────────────────
// `/연차` 신청 모달 제출
// ─────────────────────────────────────────────────────────────
async function handleLeaveSubmission(payload: InteractivePayload) {
  const values = (payload.view?.state?.values ?? {}) as Parameters<typeof readLeaveSubmission>[0]
  const input = readLeaveSubmission(values)

  if (!input.start) {
    return Response.json({ response_action: 'errors', errors: { [LEAVE_FIELD.start]: '시작일을 선택해주세요.' } })
  }
  if (input.end < input.start) {
    return Response.json({ response_action: 'errors', errors: { [LEAVE_FIELD.end]: '종료일이 시작일보다 빠릅니다.' } })
  }
  const isHalf = input.leaveType === 'half_am' || input.leaveType === 'half_pm'
  if (isHalf && input.end !== input.start) {
    return Response.json({ response_action: 'errors', errors: { [LEAVE_FIELD.end]: '반차는 하루만 신청할 수 있습니다. 종료일을 비워주세요.' } })
  }

  const slackUserId = payload.user?.id ?? ''
  const employee = await findEmployeeBySlackId(slackUserId)
  if (!employee) {
    return Response.json({
      response_action: 'errors',
      errors: { [LEAVE_FIELD.start]: 'Slack 계정과 연결된 직원 정보가 없습니다. 관리자에게 문의해주세요.' },
    })
  }

  // 검증은 여기서 끝내고 모달에 오류를 되돌려준다 — 창이 닫힌 뒤엔 알릴 방법이 마땅치 않다
  const result = await applyForLeave(admin, {
    employee,
    leaveType: input.leaveType,
    start: input.start,
    end: input.end,
    reason: input.reason,
    via: 'slack',
  })

  if (!result.ok) {
    const field = result.field === 'balance' ? LEAVE_FIELD.type : LEAVE_FIELD.start
    return Response.json({ response_action: 'errors', errors: { [field]: result.text } })
  }

  // 접수 결과는 본인에게 DM 으로 — 모달은 채널에 아무 흔적을 남기지 않는다
  await dmSlackUser(slackUserId, result.text)
  return new Response('', { status: 200 })
}

// ─────────────────────────────────────────────────────────────
// `/연차 취소` 모달 제출
// ─────────────────────────────────────────────────────────────
async function handleLeaveCancel(payload: InteractivePayload) {
  const values = (payload.view?.state?.values ?? {}) as Parameters<typeof readLeaveSubmission>[0]
  const requestId = readCancelSubmission(values)
  if (!requestId) return new Response('', { status: 200 })

  const slackUserId = payload.user?.id ?? ''
  const employee = await findEmployeeBySlackId(slackUserId)
  if (!employee) return new Response('', { status: 200 })

  // 남의 신청을 취소하지 못하게 본인 것인지 확인한다
  const { data: target } = await admin
    .from('leave_requests')
    .select('id, employee_id')
    .eq('id', requestId)
    .maybeSingle()

  if (!target || target.employee_id !== employee.id) {
    return Response.json({
      response_action: 'errors',
      errors: { [LEAVE_FIELD.target]: '본인이 신청한 휴가만 취소할 수 있습니다.' },
    })
  }

  const result = await reviewLeaveRequest(admin, {
    id: requestId,
    action: 'cancel',
    reviewer: employee.name,
    memo: '신청자 취소',
  })

  if (!result.ok) {
    return Response.json({ response_action: 'errors', errors: { [LEAVE_FIELD.target]: result.message } })
  }

  return new Response('', { status: 200 })
}

// ─────────────────────────────────────────────────────────────
// 연차 사용 촉진 — DM 의 "사용 계획 제출" 버튼 → 모달 → 제출
// ─────────────────────────────────────────────────────────────

/** 촉진 이력이 버튼을 누른 본인 것인지 확인하고 돌려준다 */
async function findOwnPromotion(promotionId: string, slackUserId: string) {
  if (!promotionId) return null
  const { data } = await admin
    .from('leave_promotions')
    .select('id, employee_id, stage, unused_days, period_start, period_end, plan_text, employees(name, slack_user_id)')
    .eq('id', promotionId)
    .maybeSingle()
  const owner = data?.employees as unknown as { name: string; slack_user_id: string | null } | null
  if (!data || owner?.slack_user_id !== slackUserId) return null
  return { ...data, employeeName: owner.name }
}

async function handlePlanButton(payload: InteractivePayload) {
  const promotion = await findOwnPromotion(payload.actions?.[0]?.value ?? '', payload.user?.id ?? '')
  if (!promotion) {
    await replyEphemeral(payload.response_url, '❌ 본인의 연차 촉진 안내가 아닙니다.')
    return new Response('', { status: 200 })
  }

  // 1·2차 어느 쪽에서 눌러도 그 연도 1차 행에 계획을 모은다 (2차 안내가 1차 계획을 보여주므로)
  const { data: first } = await admin
    .from('leave_promotions')
    .select('plan_text')
    .eq('employee_id', promotion.employee_id)
    .eq('period_start', promotion.period_start)
    .eq('stage', 1)
    .maybeSingle()

  const opened = await openSlackModal(payload.trigger_id ?? '', buildPlanModal({
    promotionId: promotion.id,
    unused: Number(promotion.unused_days),
    periodEnd: promotion.period_end,
    current: first?.plan_text ?? promotion.plan_text,
  }))
  if (!opened.ok) await replyEphemeral(payload.response_url, `❌ 창을 열지 못했습니다 (${opened.error}).`)
  return new Response('', { status: 200 })
}

async function handlePlanSubmission(payload: InteractivePayload) {
  const slackUserId = payload.user?.id ?? ''
  const promotion = await findOwnPromotion(payload.view?.private_metadata ?? '', slackUserId)
  const plan = readPlanSubmission((payload.view?.state?.values ?? {}) as Parameters<typeof readPlanSubmission>[0])

  if (!promotion) {
    return Response.json({ response_action: 'errors', errors: { [PLAN_FIELD]: '본인의 연차 촉진 안내가 아닙니다.' } })
  }
  if (!plan) {
    return Response.json({ response_action: 'errors', errors: { [PLAN_FIELD]: '사용 계획을 입력해주세요.' } })
  }

  const submittedAt = new Date().toISOString()
  // 1차 행이 없으면(2차부터 시작된 경우) 누른 행에 저장한다
  const { data: updated } = await admin
    .from('leave_promotions')
    .update({ plan_text: plan, plan_submitted_at: submittedAt })
    .eq('employee_id', promotion.employee_id)
    .eq('period_start', promotion.period_start)
    .eq('stage', 1)
    .select('id')
  if (!updated || updated.length === 0) {
    await admin
      .from('leave_promotions')
      .update({ plan_text: plan, plan_submitted_at: submittedAt })
      .eq('id', promotion.id)
  }

  const quoted = `> ${plan.replace(/\n/g, '\n> ')}`

  await dmSlackUser(slackUserId, [
    '✅ 연차 사용 계획이 제출되었습니다.',
    quoted,
    '_계획한 날짜가 다가오면 `/연차` 로 신청해주세요._',
  ].join('\n'))

  const channel = process.env.SLACK_LEAVE_CHANNEL
  if (channel) {
    await postSlackMessage(channel, [
      `📝 *연차 사용 계획 제출* — ${promotion.employeeName}`,
      `> 미사용 ${promotion.unused_days}일 · 사용 기한 ${promotion.period_end}`,
      quoted,
    ].join('\n'))
  }

  return new Response('', { status: 200 })
}

// ─────────────────────────────────────────────────────────────
// `/결제` 모달 제출
// ─────────────────────────────────────────────────────────────
async function handlePaymentSubmission(payload: InteractivePayload) {
  if (payload.view?.callback_id !== PAYMENT_MODAL_CALLBACK) {
    return new Response('', { status: 200 })
  }

  const values = (payload.view?.state?.values ?? {}) as Parameters<typeof readSubmission>[0]
  const input = readSubmission(values)

  // ── 검증은 반드시 동기로 — 여기서만 모달에 오류를 되돌려줄 수 있다 ──
  const errors: Record<string, string> = {}

  if (!input.date) errors[FIELD.date] = '날짜를 선택해주세요.'
  if (!input.clientName) errors[FIELD.client] = '상호명을 입력해주세요.'
  if (!input.manager) errors[FIELD.manager] = '담당자를 선택해주세요.'

  const amount = parseFloat(input.amountRaw.replace(/[,원\s]/g, ''))
  if (!Number.isFinite(amount) || amount <= 0) {
    errors[FIELD.amount] = '금액을 숫자로 입력해주세요.'
  }

  if (Object.keys(errors).length > 0) {
    return Response.json({ response_action: 'errors', errors })
  }

  let meta: { channelId?: string; userId?: string } = {}
  try {
    meta = JSON.parse(payload.view?.private_metadata ?? '{}')
  } catch { /* 메타 없으면 DM 으로 떨어진다 */ }

  const channelId = meta.channelId ?? ''
  const userId = meta.userId ?? payload.user?.id ?? ''
  const userName = payload.user?.name ?? payload.user?.username ?? ''

  // ── 등록은 응답을 보낸 뒤 이어서 처리한다 ─────────────────────────
  // 시트 기재 + 클라이언트/프로젝트 연결은 3초를 넘길 수 있는데,
  // Slack 이 타임아웃을 띄우면 사용자가 다시 제출해 중복 등록으로 이어진다.
  // Railway 는 상시 실행 프로세스라 응답 후에도 작업이 안전하게 끝난다.
  void (async () => {
    try {
      const result = await registerPayment(admin, {
        date: input.date,
        clientName: input.clientName,
        representative: input.representative,
        phone: input.phone,
        manager: input.manager,
        amount,
        memo: input.memo,
        status: input.status,
      })

      if (!result.ok) {
        await announce(channelId, userId, `❌ 결제 등록 실패 — ${result.message}`)
        return
      }

      const emoji =
        input.status === '잔금처리요망' ? '⚠️' :
        input.status === '미입금' ? '🔴' :
        input.status === '추가계약' ? '🔁' : '✅'

      const text = [
        `${emoji} *결제 등록 완료*${userName ? ` — @${userName}` : ''}`,
        `> 날짜: ${input.date}`,
        `> 상호명: *${input.clientName}*`,
        input.representative ? `> 대표자: ${input.representative}` : '',
        input.phone ? `> 전화번호: ${input.phone}` : '',
        `> 담당자: ${input.manager}`,
        `> 금액: *${formatKRW(amount)}* (부가세 포함)`,
        `> 상태: ${input.status}${result.projectCreated ? ' · 신규 프로젝트 자동 생성' : ''}`,
        input.memo ? `> 특이사항: ${input.memo}` : '',
        result.sheetRow ? `> 시트 ${result.sheetRow}행에 기재됨` : '',
        result.warning ? `\n⚠️ ${result.warning}` : '',
      ].filter(Boolean).join('\n')

      // 입금 확정(입금완료·추가계약)으로 올린 건에만 "되돌리기" 버튼 — 실수로 체크했을 때 바로 수금 예정으로 돌릴 수 있게.
      // 미입금·잔금은 웹의 수금 관리 탭에서 "입금 확정"으로 처리하는 반대 방향이라 버튼이 없다.
      const isConfirmed = input.status === '입금완료' || input.status === '추가계약'
      const blocks: SlackBlock[] | undefined =
        isConfirmed && result.paymentId
          ? [
              { type: 'section', text: { type: 'mrkdwn', text } },
              revertButtonBlock(result.paymentId),
            ]
          : undefined

      await announce(channelId, userId, text, blocks)
    } catch (e) {
      console.error('[slack] 결제 등록 처리 실패:', e)
      await announce(
        channelId, userId,
        `❌ 결제 등록 중 오류가 발생했습니다: ${e instanceof Error ? e.message : '알 수 없는 오류'}`,
      )
    }
  })()

  // 빈 200 → 모달이 닫힌다
  return new Response('', { status: 200 })
}

// ─────────────────────────────────────────────────────────────
// 결제 등록 메시지의 "입금 상태 되돌리기" 버튼 → 확인 모달
// ─────────────────────────────────────────────────────────────
async function handleRevertButton(payload: InteractivePayload) {
  const paymentId = payload.actions?.[0]?.value ?? ''
  const triggerId = payload.trigger_id ?? ''
  const channelId = payload.channel?.id ?? ''
  const messageTs = payload.message?.ts
  // 등록 메시지 본문 — 되돌린 뒤 버튼만 떼고 내용은 그대로 남기기 위해 모달 메타로 넘긴다
  const messageText = payload.message?.blocks?.find((b) => b.type === 'section')?.text?.text
    ?? payload.message?.text

  if (!paymentId || !triggerId) {
    await replyEphemeral(payload.response_url, '❌ 결제 정보를 읽을 수 없습니다. `/결제 취소` 로 목록에서 골라주세요.')
    return new Response('', { status: 200 })
  }

  // 버튼이 눌린 건 하나만 모달에 보여준다 — 다른 건과 헷갈려 잘못 되돌리는 일이 없게
  const target = await fetchConfirmedPayment(admin, paymentId)
  if (!target) {
    await replyEphemeral(payload.response_url, 'ℹ️ 이 건은 이미 수금 예정으로 바뀌었거나 삭제되었습니다. 결제 내역 화면에서 확인해주세요.')
    return new Response('', { status: 200 })
  }

  const opened = await openSlackModal(
    triggerId,
    buildRevertModal({ target, channelId, userId: payload.user?.id ?? '', messageTs, messageText }),
  )
  if (!opened.ok) {
    await replyEphemeral(payload.response_url, `❌ 되돌리기 창을 열지 못했습니다 (${opened.error}). \`/결제 취소\` 로 다시 시도해주세요.`)
  }
  return new Response('', { status: 200 })
}

// ─────────────────────────────────────────────────────────────
// 입금 되돌리기 모달 제출 — 버튼·`/결제 취소` 공통
// ─────────────────────────────────────────────────────────────
async function handleRevertSubmission(payload: InteractivePayload) {
  const values = (payload.view?.state?.values ?? {}) as Parameters<typeof readRevertSubmission>[0]
  const input = readRevertSubmission(values)

  let meta: { channelId?: string; userId?: string; messageTs?: string; messageText?: string; paymentId?: string } = {}
  try {
    meta = JSON.parse(payload.view?.private_metadata ?? '{}')
  } catch { /* 메타 없으면 DM 으로 떨어진다 */ }

  // 버튼에서 열렸으면 메타에, 목록에서 골랐으면 select 값에 ID 가 있다
  const paymentId = meta.paymentId || input.paymentId
  if (!paymentId) {
    return Response.json({ response_action: 'errors', errors: { [REVERT_FIELD.target]: '되돌릴 결제를 선택해주세요.' } })
  }
  const status = input.status
  if (!isRevertStatus(status)) {
    return Response.json({ response_action: 'errors', errors: { [REVERT_FIELD.status]: '상태를 선택해주세요.' } })
  }

  const channelId = meta.channelId ?? ''
  const userId = meta.userId ?? payload.user?.id ?? ''
  const userName = payload.user?.name ?? payload.user?.username ?? ''

  // 시트 검색·수정이 3초를 넘길 수 있어 모달은 먼저 닫고 이어서 처리한다 (등록과 같은 이유)
  void (async () => {
    try {
      const result = await revertPaymentConfirmation(admin, { paymentId, status })

      if (!result.ok) {
        await announce(channelId, userId, `❌ 입금 되돌리기 실패 — ${result.message}`)
        return
      }

      const p = result.payment
      const label = REVERT_STATUS_LABEL[status]
      const text = [
        `↩️ *입금 상태 되돌림*${userName ? ` — @${userName}` : ''}`,
        `> 상호명: *${p.clientName}*`,
        `> 금액: *${formatKRW(p.amount)}*`,
        `> 날짜: ${p.paymentDate}${p.manager ? ` · 담당자: ${p.manager}` : ''}`,
        p.projectName ? `> 프로젝트: ${p.projectName}` : '',
        `> 입금완료 → *${label}* — 결제 내역의 수금 관리 탭으로 옮겨졌고 프로젝트 입금액에서 빠졌습니다.`,
        result.sheetRow ? `> 시트 ${result.sheetRow}행 입금상태도 바꿨습니다` : '',
        result.warning ? `\n⚠️ ${result.warning}` : '',
      ].filter(Boolean).join('\n')

      await announce(channelId, userId, text)

      // 원래 "결제 등록 완료" 메시지에서 버튼을 떼고 되돌린 흔적을 남긴다 — 두 번 눌리지 않게
      if (channelId && meta.messageTs) {
        const body = meta.messageText || `결제 등록 — ${p.clientName} ${formatKRW(p.amount)}`
        const note = `↩️ *${label}* 으로 되돌려짐${userName ? ` — @${userName}` : ''}`
        await updateSlackMessage(channelId, meta.messageTs, `${body}\n${note}`, [
          { type: 'section', text: { type: 'mrkdwn', text: body } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: note }] },
        ])
      }
    } catch (e) {
      console.error('[slack] 입금 되돌리기 처리 실패:', e)
      await announce(
        channelId, userId,
        `❌ 입금 되돌리기 중 오류가 발생했습니다: ${e instanceof Error ? e.message : '알 수 없는 오류'}`,
      )
    }
  })()

  return new Response('', { status: 200 })
}

// ─────────────────────────────────────────────────────────────
// 연차 승인/반려 버튼
// ─────────────────────────────────────────────────────────────
async function handleLeaveButton(payload: InteractivePayload) {
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
