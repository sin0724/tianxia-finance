/**
 * Slack `/연차` 슬래시 커맨드
 *
 * Slack App 설정 → Slash Commands → Request URL:
 *   https://your-domain/api/slack/leave
 *
 * 사용법:
 *   /연차              신청 창 열기 (맨 위에 내 잔여 연차가 보인다)
 *   /연차 취소         취소할 휴가를 골라서 취소
 *   /연차 조회         잔여 연차를 글로 확인
 *   /연차 12/25        창을 안 거치고 바로 신청 (익숙한 사람용)
 *   /연차 도움말       사용법
 *
 * 실제 신청·취소 처리는 applyForLeave() / reviewLeaveRequest() 한 곳으로 모여 있어
 * 모달과 텍스트 커맨드의 검증 기준이 갈라지지 않는다.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { verifySlackRequest, fetchSlackUserName, openSlackModal } from '@/lib/slack'
import { parseLeaveCommand, formatRange } from '@/lib/leave/calc'
import { getLeaveBalance } from '@/lib/leave/balance'
import { applyForLeave, fetchCancellableRequests } from '@/lib/leave/apply'
import { buildLeaveModal, buildLeaveCancelModal } from '@/lib/leave/modal'
import { LEAVE_TYPE_LABEL, todayISO } from '@/lib/leave/policy'

const admin = createAdminClient()

function ephemeral(text: string) {
  return Response.json({ response_type: 'ephemeral', text })
}

const HELP_TEXT = [
  '*연차 사용법*',
  '`/연차` — 신청 창 열기 (내 잔여 연차도 함께 보입니다)',
  '`/연차 취소` — 취소할 휴가 고르기',
  '`/연차 조회` — 잔여 연차를 글로 확인',
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

/** Slack 사용자를 직원과 연결. 미연결이면 이름이 같은 재직 직원에 자동 매핑한다. */
async function resolveEmployee(slackUserId: string, slackUserName: string) {
  const { data: linked } = await admin
    .from('employees')
    .select('id, name, hired_at, work_days, slack_user_id')
    .eq('slack_user_id', slackUserId)
    .maybeSingle()

  if (linked) return linked

  // 자동 매핑 — Slack 표시 이름(없으면 핸들)과 직원 이름이 정확히 같을 때만.
  // 동명이인이 둘 다 재직 중이면 매칭을 포기하고 관리자가 직접 연결하게 둔다.
  const candidates = [await fetchSlackUserName(slackUserId), slackUserName].filter(Boolean) as string[]

  for (const name of candidates) {
    const { data: match } = await admin
      .from('employees')
      .select('id, name, hired_at, work_days, slack_user_id')
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

  const parsed = parseLeaveCommand(text)
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
  if (text === '') {
    const balance = await getLeaveBalance(admin, employee)
    const opened = await openSlackModal(
      triggerId,
      buildLeaveModal({ balance, today: todayISO(), channelId, userId: slackUserId }),
    )
    if (!opened.ok) return ephemeral(`❌ 창을 열지 못했습니다 (${opened.error}). 잠시 후 다시 시도해주세요.`)
    return new Response('', { status: 200 })
  }

  // ── `/연차 조회` — 글로 확인 ────────────────────────────────────
  if (parsed.kind === 'balance') {
    if (!employee.hired_at) {
      return ephemeral('⚠️ 입사일이 등록되어 있지 않아 연차를 계산할 수 없습니다. 관리자에게 문의해주세요.')
    }

    const [balance, { data: recent }] = await Promise.all([
      getLeaveBalance(admin, employee),
      admin
        .from('leave_requests')
        .select('leave_type, start_date, end_date, days, status')
        .eq('employee_id', employee.id)
        .order('start_date', { ascending: false })
        .limit(5),
    ])

    const statusMark: Record<string, string> = {
      pending: '⏳ 대기', approved: '✅ 승인', rejected: '❌ 반려', cancelled: '↩️ 취소',
    }

    const lines = [
      `*${employee.name}님의 연차 현황*`,
      `> 남은 연차: *${balance.remaining}일*`,
      `> 발생 ${balance.total}일 · 사용 ${balance.used}일${balance.pending > 0 ? ` · 승인대기 ${balance.pending}일` : ''}`,
    ]
    if (balance.nextAccrualAt) lines.push(`> 다음 연차 발생: ${balance.nextAccrualAt} (+1일)`)
    if (balance.period) lines.push(`> 기준 기간: ${balance.period.start} ~ ${balance.period.end}`)

    if (recent && recent.length > 0) {
      lines.push('', '*최근 신청 내역*')
      for (const r of recent) {
        const label = LEAVE_TYPE_LABEL[r.leave_type] ?? r.leave_type
        lines.push(`• ${formatRange(r.start_date, r.end_date)} ${label} ${r.days}일 — ${statusMark[r.status] ?? r.status}`)
      }
    }

    return ephemeral(lines.join('\n'))
  }

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
