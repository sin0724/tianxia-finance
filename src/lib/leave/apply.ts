/**
 * 연차 신청 처리 — 텍스트 커맨드(`/연차 12/25`)와 모달 제출이 모두 이 함수를 거친다.
 * 검증 기준이 두 곳으로 갈라지면 한쪽으로만 초과 신청이 새어 들어가므로 한 곳에 모은다.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { postSlackMessage } from '@/lib/slack'
import { calcDays, formatRange, type LeaveType } from './calc'
import { fetchHolidays, getLeaveBalance } from './balance'
import { DEDUCTING_TYPES, LEAVE_TYPE_LABEL } from './policy'

type Admin = SupabaseClient<Database>

export type LeaveEmployee = {
  id: string
  name: string
  hired_at: string | null
  work_days: string | null
}

export type ApplyResult =
  | { ok: true; requestId: string; days: number; remainingAfter: number; deducts: boolean; text: string }
  | { ok: false; text: string; field?: 'date' | 'balance' }

export async function applyForLeave(
  admin: Admin,
  params: {
    employee: LeaveEmployee
    leaveType: LeaveType
    start: string
    end: string
    reason: string
    via: 'slack' | 'web'
  },
): Promise<ApplyResult> {
  const { employee, leaveType, start, end, reason, via } = params

  if (!employee.hired_at) {
    return { ok: false, text: '⚠️ 입사일이 등록되어 있지 않아 연차를 계산할 수 없습니다. 관리자에게 문의해주세요.' }
  }

  const [balance, holidays, { data: overlapping }] = await Promise.all([
    getLeaveBalance(admin, employee),
    fetchHolidays(admin),
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
    return {
      ok: false,
      field: 'date',
      text: `${formatRange(start, end)} 은 모두 휴무일(주말·공휴일)이라 신청할 필요가 없습니다.`,
    }
  }

  // 반차는 오전/오후가 다르면 같은 날 두 번 신청할 수 있다
  const realOverlap = (overlapping ?? []).filter((o) => {
    const bothHalf = /^half_/.test(o.leave_type) && /^half_/.test(leaveType)
    return !(bothHalf && o.leave_type !== leaveType)
  })

  if (realOverlap.length > 0) {
    const o = realOverlap[0]
    return {
      ok: false,
      field: 'date',
      text: `이미 ${formatRange(o.start_date, o.end_date)} 에 ${o.status === 'approved' ? '승인된' : '신청한'} 휴가가 있습니다.`,
    }
  }

  const deducts = (DEDUCTING_TYPES as readonly string[]).includes(leaveType)
  if (deducts && days > balance.remaining) {
    return {
      ok: false,
      field: 'balance',
      text: [
        `잔여 연차가 부족합니다. (신청 ${days}일 · 남은 연차 ${balance.remaining}일)`,
        balance.nextAccrualAt ? `다음 연차 발생: ${balance.nextAccrualAt}` : '',
        '무급으로 쉬시려면 휴가 종류를 "무급휴가"로 선택해주세요.',
      ].filter(Boolean).join(' '),
    }
  }

  const { data: created, error } = await admin
    .from('leave_requests')
    .insert({
      employee_id: employee.id,
      leave_type: leaveType,
      start_date: start,
      end_date: end,
      days,
      reason: reason || null,
      status: 'pending',
      requested_via: via,
    })
    .select('id')
    .single()

  if (error || !created) {
    return { ok: false, text: `신청 저장 실패: ${error?.message ?? '알 수 없는 오류'}` }
  }

  const typeLabel = LEAVE_TYPE_LABEL[leaveType] ?? '연차'
  const remainingAfter = deducts ? balance.remaining - days : balance.remaining

  await postApprovalCard(admin, {
    requestId: created.id,
    employeeName: employee.name,
    typeLabel,
    start, end, days, reason,
    remainingAfter,
    total: balance.total,
  })

  return {
    ok: true,
    requestId: created.id,
    days,
    remainingAfter,
    deducts,
    text: [
      `✅ ${typeLabel} 신청이 접수되었습니다. 승인을 기다려주세요.`,
      `> 기간: ${formatRange(start, end)} — *${days}일*`,
      reason ? `> 사유: ${reason}` : '',
      deducts ? `> 승인 시 잔여 연차: ${remainingAfter}일` : '> 연차에서 차감되지 않는 휴가입니다.',
      '',
      '_취소하려면 `/연차 취소` 를 입력하세요._',
    ].filter(Boolean).join('\n'),
  }
}

/** 관리자 채널에 승인/반려 버튼 카드를 올리고, 성공하면 메시지 위치를 저장한다 */
async function postApprovalCard(
  admin: Admin,
  p: {
    requestId: string; employeeName: string; typeLabel: string
    start: string; end: string; days: number; reason: string
    remainingAfter: number; total: number
  },
) {
  const channel = process.env.SLACK_LEAVE_CHANNEL
  if (!channel) return

  const summary = `🗓 ${p.typeLabel} 신청 — ${p.employeeName} · ${formatRange(p.start, p.end)} (${p.days}일)`

  const posted = await postSlackMessage(channel, summary, [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*🗓 ${p.typeLabel} 신청*`,
          `> 신청자: *${p.employeeName}*`,
          `> 기간: ${formatRange(p.start, p.end)} — *${p.days}일*`,
          p.reason ? `> 사유: ${p.reason}` : null,
          `> 신청 후 잔여: ${p.remainingAfter}일 / 총 ${p.total}일`,
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
          value: p.requestId,
        },
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: '반려', emoji: true },
          action_id: 'leave_reject',
          value: p.requestId,
        },
      ],
    },
  ])

  if (posted) {
    await admin
      .from('leave_requests')
      .update({ slack_channel_id: posted.channel, slack_message_ts: posted.ts })
      .eq('id', p.requestId)
  }
}

/**
 * 직원이 취소할 수 있는 신청 목록.
 * 대기중인 건은 언제든, 승인된 건은 시작 전까지만 스스로 취소할 수 있다.
 * (이미 쉬고 온 연차를 직원이 되돌리면 잔여가 잘못 늘어나므로 그건 관리자만 처리한다)
 */
export async function fetchCancellableRequests(admin: Admin, employeeId: string, today: string) {
  const { data } = await admin
    .from('leave_requests')
    .select('id, leave_type, start_date, end_date, days, status')
    .eq('employee_id', employeeId)
    .in('status', ['pending', 'approved'])
    .order('start_date', { ascending: true })

  return (data ?? []).filter((r) => r.status === 'pending' || r.start_date >= today)
}
