/**
 * Slack `/연차` 슬래시 커맨드
 *
 * Slack App 설정 → Slash Commands → Request URL:
 *   https://your-domain/api/slack/leave
 *
 * 사용법:
 *   /연차                       내 잔여 연차 확인 (나만 보임)
 *   /연차 12/25                 하루 신청
 *   /연차 12/25~12/27 가족여행   기간 신청 + 사유
 *   /연차 반차 12/25 오전        반차 신청
 *   /연차 병가 12/25            병가 (연차 미차감)
 *   /연차 취소                  가장 최근 대기 건 취소
 *
 * 신청은 pending 으로 저장되고, SLACK_LEAVE_CHANNEL 에 승인/반려 버튼 카드가 올라간다.
 * 봇 토큰이나 채널이 설정되지 않았어도 신청은 저장되며 앱의 "연차 관리" 화면에서 승인할 수 있다.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { verifySlackRequest, postSlackMessage, fetchSlackUserName } from '@/lib/slack'
import { parseLeaveCommand, calcDays, formatRange } from '@/lib/leave/calc'
import { getLeaveBalance, fetchHolidays } from '@/lib/leave/balance'
import { LEAVE_TYPE_LABEL, DEDUCTING_TYPES } from '@/lib/leave/policy'

const admin = createAdminClient()

function ephemeral(text: string) {
  return Response.json({ response_type: 'ephemeral', text })
}

const HELP_TEXT = [
  '*연차 신청 사용법*',
  '`/연차` — 내 잔여 연차 확인',
  '`/연차 12/25` — 하루 신청',
  '`/연차 12/25~12/27 가족여행` — 기간 신청 (사유는 선택)',
  '`/연차 반차 12/25 오전` — 반차 (0.5일)',
  '`/연차 병가 12/25` — 병가 (연차에서 차감되지 않음)',
  '`/연차 무급 12/25` — 무급휴가',
  '`/연차 취소` — 가장 최근 승인 대기 건 취소',
  '',
  '날짜는 `12/25`, `2026-12-25`, `오늘`, `내일` 형식을 인식합니다.',
].join('\n')

/** Slack 사용자를 직원과 연결. 미연결이면 이름이 같은 재직 직원에 자동 매핑한다. */
async function resolveEmployee(slackUserId: string, slackUserName: string) {
  const { data: linked } = await admin
    .from('employees')
    .select('id, name, hired_at, work_days, slack_user_id')
    .eq('slack_user_id', slackUserId)
    .maybeSingle()

  if (linked) return linked

  // 자동 매핑 — Slack 표시 이름(없으면 핸들)과 직원 이름이 정확히 같을 때만
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
  const text = params.get('text') ?? ''
  const slackUserId = params.get('user_id') ?? ''
  const slackUserName = params.get('user_name') ?? ''

  const parsed = parseLeaveCommand(text)
  if (parsed.kind === 'help') return ephemeral(HELP_TEXT)
  if (parsed.kind === 'error') return ephemeral(`❌ ${parsed.message}\n\n${HELP_TEXT}`)

  const employee = await resolveEmployee(slackUserId, slackUserName)
  if (!employee) {
    return ephemeral(
      [
        '❌ Slack 계정과 연결된 직원 정보가 없습니다.',
        `관리자에게 아래 ID 를 전달해 "직원 관리"에서 연결을 요청해주세요.`,
        `> Slack ID: \`${slackUserId}\``,
      ].join('\n'),
    )
  }

  // ── 잔여 조회 ────────────────────────────────────────────────
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

    if (balance.nextAccrualAt) {
      lines.push(`> 다음 연차 발생: ${balance.nextAccrualAt} (+1일)`)
    }
    if (balance.period) {
      lines.push(`> 기준 기간: ${balance.period.start} ~ ${balance.period.end}`)
    }

    if (recent && recent.length > 0) {
      lines.push('', '*최근 신청 내역*')
      for (const r of recent) {
        const label = LEAVE_TYPE_LABEL[r.leave_type] ?? r.leave_type
        lines.push(`• ${formatRange(r.start_date, r.end_date)} ${label} ${r.days}일 — ${statusMark[r.status] ?? r.status}`)
      }
    }

    return ephemeral(lines.join('\n'))
  }

  // ── 대기 건 취소 ─────────────────────────────────────────────
  if (parsed.kind === 'cancel') {
    const { data: latest } = await admin
      .from('leave_requests')
      .select('id, leave_type, start_date, end_date, days')
      .eq('employee_id', employee.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!latest) return ephemeral('취소할 승인 대기 건이 없습니다.')

    const { error } = await admin
      .from('leave_requests')
      .update({ status: 'cancelled', reviewed_at: new Date().toISOString(), reviewed_by: employee.name, review_memo: '신청자 취소' })
      .eq('id', latest.id)
      .eq('status', 'pending')

    if (error) return ephemeral(`❌ 취소 실패: ${error.message}`)

    return ephemeral(
      `↩️ ${formatRange(latest.start_date, latest.end_date)} ${LEAVE_TYPE_LABEL[latest.leave_type] ?? ''} 신청이 취소되었습니다.`,
    )
  }

  // ── 신청 ────────────────────────────────────────────────────
  const { leaveType, start, end, reason } = parsed

  if (!employee.hired_at) {
    return ephemeral('⚠️ 입사일이 등록되어 있지 않아 연차를 계산할 수 없습니다. 관리자에게 문의해주세요.')
  }

  // Slack 슬래시 커맨드는 3초 안에 응답해야 하므로 서로 의존하지 않는 조회는 한 번에 던진다
  const [balance, holidays, { data: overlapping }] = await Promise.all([
    getLeaveBalance(admin, employee),
    fetchHolidays(admin),
    // 같은 기간에 이미 신청/승인된 건이 있는지
    admin
      .from('leave_requests')
      .select('start_date, end_date, leave_type, status')
      .eq('employee_id', employee.id)
      .in('status', ['pending', 'approved'])
      .lte('start_date', end)
      .gte('end_date', start),
  ])

  const days = calcDays(leaveType, start, end, holidays, employee.work_days)

  if (days === 0) {
    return ephemeral(
      `❌ ${formatRange(start, end)} 은 모두 휴무일(주말·공휴일)이라 신청할 필요가 없습니다.`,
    )
  }

  // 반차는 오전/오후가 다르면 같은 날 두 번 신청할 수 있다
  const realOverlap = (overlapping ?? []).filter((o) => {
    const bothHalf = /^half_/.test(o.leave_type) && /^half_/.test(leaveType)
    return !(bothHalf && o.leave_type !== leaveType)
  })

  if (realOverlap.length > 0) {
    const o = realOverlap[0]
    return ephemeral(
      `❌ 이미 ${formatRange(o.start_date, o.end_date)} 에 ${o.status === 'approved' ? '승인된' : '신청한'} 휴가가 있습니다.`,
    )
  }

  // 잔여 확인 — 연차에서 차감되는 종류만
  const isDeducting = (DEDUCTING_TYPES as readonly string[]).includes(leaveType)
  if (isDeducting && days > balance.remaining) {
    return ephemeral(
      [
        `❌ 잔여 연차가 부족합니다.`,
        `> 신청: ${days}일 · 남은 연차: ${balance.remaining}일`,
        balance.nextAccrualAt ? `> 다음 연차 발생: ${balance.nextAccrualAt}` : '',
        '무급으로 쉬시려면 `/연차 무급 ' + start.slice(5).replace('-', '/') + '` 으로 신청해주세요.',
      ].filter(Boolean).join('\n'),
    )
  }

  const { data: created, error: insertErr } = await admin
    .from('leave_requests')
    .insert({
      employee_id: employee.id,
      leave_type: leaveType,
      start_date: start,
      end_date: end,
      days,
      reason: reason || null,
      status: 'pending',
      requested_via: 'slack',
    })
    .select('id')
    .single()

  if (insertErr || !created) {
    return ephemeral(`❌ 신청 저장 실패: ${insertErr?.message ?? '알 수 없는 오류'}`)
  }

  const typeLabel = LEAVE_TYPE_LABEL[leaveType] ?? '연차'
  const remainingAfter = isDeducting ? balance.remaining - days : balance.remaining

  // 관리자 채널에 승인 카드 전송
  const channel = process.env.SLACK_LEAVE_CHANNEL
  if (channel) {
    const summary = `🗓 ${typeLabel} 신청 — ${employee.name} · ${formatRange(start, end)} (${days}일)`
    const posted = await postSlackMessage(channel, summary, [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `*🗓 ${typeLabel} 신청*`,
            `> 신청자: *${employee.name}*`,
            `> 기간: ${formatRange(start, end)} — *${days}일*`,
            reason ? `> 사유: ${reason}` : null,
            `> 신청 후 잔여: ${remainingAfter}일 / 총 ${balance.total}일`,
          ].filter(Boolean).join('\n'),
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'primary',
            text: { type: 'plain_text', text: '승인', emoji: true },
            action_id: 'leave_approve',
            value: created.id,
          },
          {
            type: 'button',
            style: 'danger',
            text: { type: 'plain_text', text: '반려', emoji: true },
            action_id: 'leave_reject',
            value: created.id,
          },
        ],
      },
    ])

    if (posted) {
      await admin
        .from('leave_requests')
        .update({ slack_channel_id: posted.channel, slack_message_ts: posted.ts })
        .eq('id', created.id)
    }
  }

  return ephemeral(
    [
      `✅ ${typeLabel} 신청이 접수되었습니다. 승인을 기다려주세요.`,
      `> 기간: ${formatRange(start, end)} — *${days}일*`,
      reason ? `> 사유: ${reason}` : '',
      isDeducting ? `> 승인 시 잔여 연차: ${remainingAfter}일` : '> 연차에서 차감되지 않는 휴가입니다.',
      '',
      '_잘못 신청했다면 `/연차 취소` 로 되돌릴 수 있습니다._',
    ].filter(Boolean).join('\n'),
  )
}

// 오늘 날짜를 캐시하지 않도록 (배포 후 날짜가 굳는 것 방지)
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
