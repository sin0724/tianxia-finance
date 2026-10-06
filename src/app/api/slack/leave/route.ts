/**
 * Slack `/연차` 슬래시 커맨드
 *
 * Slack App 설정 → Slash Commands → Request URL:
 *   https://your-domain/api/slack/leave
 *
 * 사용법:
 *   /연차              신청 창 열기 (맨 위에 내 잔여 연차가 보인다)
 *   /연차 취소         취소할 휴가를 골라서 취소
 *   /연차 조회         잔여 연차를 글로 확인 (= /연차현황)
 *   /연차현황          내 연차 현황 정리 — 같은 Request URL 로 별도 커맨드 등록
 *   /연차 12/25        창을 안 거치고 바로 신청 (익숙한 사람용)
 *   /연차 도움말       사용법
 *
 * 실제 신청·취소 처리는 applyForLeave() / reviewLeaveRequest() 한 곳으로 모여 있어
 * 모달과 텍스트 커맨드의 검증 기준이 갈라지지 않는다.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { verifySlackRequest, fetchSlackUserName, openSlackModal } from '@/lib/slack'
import { parseLeaveCommand, formatRange } from '@/lib/leave/calc'
import { getLeaveBalance, isLeaveEligible, type LeaveBalanceEmployee } from '@/lib/leave/balance'
import { applyForLeave, fetchCancellableRequests } from '@/lib/leave/apply'
import { buildLeaveModal, buildLeaveCancelModal } from '@/lib/leave/modal'
import { DEDUCTING_TYPES, LEAVE_TYPE_LABEL, periodLabel, promotionDate, todayISO } from '@/lib/leave/policy'

const admin = createAdminClient()

function ephemeral(text: string) {
  return Response.json({ response_type: 'ephemeral', text })
}

const HELP_TEXT = [
  '*연차 사용법*',
  '`/연차` — 신청 창 열기 (내 잔여 연차도 함께 보입니다)',
  '`/연차 취소` — 취소할 휴가 고르기',
  '`/연차현황` — 내 연차 현황 정리 (발생·사용·잔여·사용 내역)',
  '',
  '*바로 신청하기 (창 없이)*',
  '`/연차 12/25` — 하루',
  '`/연차 12/25~12/27 가족여행` — 기간 (사유는 선택)',
  '`/연차 반차 12/25 오전` — 반차 (0.5일)',
  '`/연차 병가 12/25` — 병가 (연차에서 차감되지 않음)',
  '`/연차 무급 12/25` — 무급휴가',
  '',
  '날짜는 `12/25`, `2026-12-25`, `오늘`, `내일` 형식을 인식합니다.',
  '주말·공휴일은 자동으로 일수에서 빠집니다.',
].join('\n')

const STATUS_MARK: Record<string, string> = {
  pending: '⏳ 대기', approved: '✅ 승인', rejected: '❌ 반려', cancelled: '↩️ 취소',
}

/** `/연차현황` · `/연차 조회` 응답 — 본인에게만 보이는 연차 요약 */
async function buildLeaveStatusText(employee: LeaveBalanceEmployee): Promise<string> {
  const today = todayISO()
  const title = `*${employee.name}님의 연차 현황* (${today} 기준)`

  if (!isLeaveEligible(employee)) {
    return [
      title,
      '> 아르바이트는 연차가 발생하지 않습니다.',
      '> 쉬실 때는 `/연차` 에서 무급휴가·병가·특별휴가로 신청해주세요.',
    ].join('\n')
  }
  if (!employee.hired_at) {
    return '⚠️ 입사일이 등록되어 있지 않아 연차를 계산할 수 없습니다. 관리자에게 문의해주세요.'
  }

  const balance = await getLeaveBalance(admin, employee, today)
  if (!balance.period) {
    return `${title}\n> 입사일(${employee.hired_at}) 이전이라 아직 연차가 없습니다.`
  }

  // 이번 연차연도에 시작하는 신청 — 잔여 집계와 같은 기준(시작일이 속한 기간)으로 보여준다
  const { data: requests } = await admin
    .from('leave_requests')
    .select('leave_type, start_date, end_date, days, status')
    .eq('employee_id', employee.id)
    .gte('start_date', balance.period.start)
    .lte('start_date', balance.period.end)
    .in('status', ['approved', 'pending'])
    .order('start_date', { ascending: true })

  const extras = [
    balance.carriedOver ? `이월 ${balance.carriedOver}일` : '',
    balance.adjustment ? `조정 ${balance.adjustment > 0 ? '+' : ''}${balance.adjustment}일` : '',
  ].filter(Boolean)

  const lines = [
    title,
    `> 남은 연차: *${balance.remaining}일*`,
    `> 총 ${balance.total}일 = 발생 ${balance.granted}일${extras.length ? ` + ${extras.join(' + ')}` : ''}`,
    `> 사용 ${balance.used}일${balance.pending > 0 ? ` · 승인대기 ${balance.pending}일` : ''}`,
    `> 발생 근거: ${balance.basis}`,
    `> 기준 기간: ${periodLabel(balance.period)}`,
  ]
  if (balance.nextAccrualAt) lines.push(`> 다음 연차 발생: ${balance.nextAccrualAt} (그달 개근 시 +1일)`)
  if (balance.expiresAt && balance.remaining > 0) {
    lines.push(`> ⚠️ 남은 연차는 *${balance.period.end}* 까지 사용하지 않으면 ${balance.expiresAt}에 소멸됩니다.`)
  }

  // 사용 촉진 일정 — 언제 안내가 오는지 미리 알 수 있게
  const { data: promotions } = await admin
    .from('leave_promotions')
    .select('stage, notified_at, plan_submitted_at')
    .eq('employee_id', employee.id)
    .eq('period_start', balance.period.start)
  const sentStage = (n: 1 | 2) => promotions?.find((p) => p.stage === n)
  const promoLine = ([1, 2] as const).map((n) => {
    const sent = sentStage(n)
    return sent
      ? `${n}차 ${sent.notified_at.slice(0, 10)} 안내됨`
      : `${n}차 ${promotionDate(balance.period!, n)} 예정`
  })
  if (sentStage(1)) promoLine.push(sentStage(1)!.plan_submitted_at ? '사용 계획 제출함' : '사용 계획 미제출')
  lines.push(`> 사용 촉진: ${promoLine.join(' · ')}`)

  const rows = requests ?? []
  const upcoming = rows.filter((r) => r.end_date >= today)
  const past = rows.filter((r) => r.end_date < today)

  const fmt = (r: (typeof rows)[number]) => {
    const label = LEAVE_TYPE_LABEL[r.leave_type] ?? r.leave_type
    const deducts = (DEDUCTING_TYPES as readonly string[]).includes(r.leave_type)
    return `• ${formatRange(r.start_date, r.end_date)} ${label} ${r.days}일${deducts ? '' : ' (미차감)'} — ${STATUS_MARK[r.status] ?? r.status}`
  }

  if (upcoming.length > 0) lines.push('', '*예정된 휴가*', ...upcoming.map(fmt))
  if (past.length > 0) lines.push('', '*이번 기간 사용 내역*', ...past.map(fmt))
  if (rows.length === 0) lines.push('', '_이번 기간에 사용하거나 신청한 휴가가 없습니다._')

  return lines.join('\n')
}

/** Slack 사용자를 직원과 연결. 미연결이면 이름이 같은 재직 직원에 자동 매핑한다. */
async function resolveEmployee(slackUserId: string, slackUserName: string) {
  const { data: linked } = await admin
    .from('employees')
    .select('id, name, hired_at, work_days, employee_type, slack_user_id')
    .eq('slack_user_id', slackUserId)
    .maybeSingle()

  if (linked) return linked

  // 자동 매핑 — Slack 표시 이름(없으면 핸들)과 직원 이름이 정확히 같을 때만.
  // 동명이인이 둘 다 재직 중이면 매칭을 포기하고 관리자가 직접 연결하게 둔다.
  const candidates = [await fetchSlackUserName(slackUserId), slackUserName].filter(Boolean) as string[]

  for (const name of candidates) {
    const { data: match } = await admin
      .from('employees')
      .select('id, name, hired_at, work_days, employee_type, slack_user_id')
      .eq('active', true)
      .is('slack_user_id', null)
      .eq('name', name.trim())
      .maybeSingle()

    if (match) {
      await admin.from('employees').update({ slack_user_id: slackUserId }).eq('id', match.id)
      return { ...match, slack_user_id: slackUserId }
    }
  }

  return null
}

export async function POST(request: Request) {
  const rawBody = await request.text()

  const verified = verifySlackRequest(rawBody, request.headers)
  if (!verified.ok) return Response.json({ error: verified.reason }, { status: 401 })

  const params = new URLSearchParams(rawBody)
  const text = (params.get('text') ?? '').trim()
  const slackUserId = params.get('user_id') ?? ''
  const slackUserName = params.get('user_name') ?? ''
  const triggerId = params.get('trigger_id') ?? ''
  const channelId = params.get('channel_id') ?? ''

  // `/연차현황` 은 같은 URL 로 등록한 별도 커맨드 — 인자 없이 본인 현황만 보여준다
  const isStatusCommand = (params.get('command') ?? '').replace(/^\//, '') === '연차현황'

  const parsed = isStatusCommand ? { kind: 'balance' as const } : parseLeaveCommand(text)
  if (parsed.kind === 'help') return ephemeral(HELP_TEXT)
  if (parsed.kind === 'error') return ephemeral(`❌ ${parsed.message}\n\n${HELP_TEXT}`)

  const employee = await resolveEmployee(slackUserId, slackUserName)
  if (!employee) {
    return ephemeral(
      [
        '❌ Slack 계정과 연결된 직원 정보가 없습니다.',
        '관리자에게 아래 ID 를 전달해 "직원 관리"에서 연결을 요청해주세요.',
        `> Slack ID: \`${slackUserId}\``,
      ].join('\n'),
    )
  }

  // ── 취소 — 취소할 휴가를 고르는 창 ───────────────────────────────
  if (parsed.kind === 'cancel') {
    const requests = await fetchCancellableRequests(admin, employee.id, todayISO())
    const opened = await openSlackModal(
      triggerId,
      buildLeaveCancelModal({ requests, channelId, userId: slackUserId }),
    )
    if (!opened.ok) return ephemeral(`❌ 창을 열지 못했습니다 (${opened.error}). 잠시 후 다시 시도해주세요.`)
    return new Response('', { status: 200 })
  }

  // ── 인자 없이 `/연차` — 신청 창 ─────────────────────────────────
  if (text === '' && !isStatusCommand) {
    const balance = await getLeaveBalance(admin, employee)
    const opened = await openSlackModal(
      triggerId,
      buildLeaveModal({ balance, today: todayISO(), channelId, userId: slackUserId }),
    )
    if (!opened.ok) return ephemeral(`❌ 창을 열지 못했습니다 (${opened.error}). 잠시 후 다시 시도해주세요.`)
    return new Response('', { status: 200 })
  }

  // ── `/연차 조회` — 글로 확인 (`/연차현황` 과 같은 내용) ─────────────
  if (parsed.kind === 'balance') return ephemeral(await buildLeaveStatusText(employee))

  // ── `/연차 12/25 …` — 창 없이 바로 신청 ─────────────────────────
  const result = await applyForLeave(admin, {
    employee,
    leaveType: parsed.leaveType,
    start: parsed.start,
    end: parsed.end,
    reason: parsed.reason,
    via: 'slack',
  })

  return ephemeral(result.ok ? result.text : `❌ ${result.text}`)
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
