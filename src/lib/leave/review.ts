/**
 * 연차 승인/반려 처리 — Slack 버튼과 웹 화면이 모두 이 함수를 거친다.
 * 캘린더 반영·Slack 통보·메시지 갱신이 한 곳에 모여 있어야 두 경로의 결과가 어긋나지 않는다.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, LeaveStatus } from '@/types/database'
import { createLeaveEvent, deleteLeaveEvent } from '@/lib/google-calendar'
import { dmSlackUser, updateSlackMessage } from '@/lib/slack'
import { formatRange } from './calc'
import { getLeaveBalance } from './balance'
import { LEAVE_TYPE_LABEL } from './policy'

type Admin = SupabaseClient<Database>

export type ReviewAction = 'approve' | 'reject' | 'cancel'

export type ReviewResult =
  | { ok: true; message: string }
  | { ok: false; message: string }

/**
 * 신청 한 건을 처리한다.
 *
 * - approve → 캘린더 이벤트 생성
 * - reject/cancel → 이미 캘린더에 올라가 있으면 삭제
 * 이미 처리된 건(pending 이 아닌 건)은 거부한다. Slack 버튼을 두 번 눌러도 안전하도록.
 */
export async function reviewLeaveRequest(
  admin: Admin,
  params: { id: string; action: ReviewAction; reviewer: string; memo?: string | null },
): Promise<ReviewResult> {
  const { id, action, reviewer, memo } = params

  const { data: req, error } = await admin
    .from('leave_requests')
    .select('*, employees(id, name, hired_at, employee_type, work_days, slack_user_id)')
    .eq('id', id)
    .maybeSingle()

  if (error || !req) return { ok: false, message: '신청 건을 찾을 수 없습니다.' }

  // 취소는 승인된 건에도 할 수 있다 (캘린더 일정까지 함께 지워진다).
  // 승인/반려는 대기중인 건에만 — 이미 처리된 걸 다시 뒤집지 않는다.
  const allowedStatuses: LeaveStatus[] = action === 'cancel' ? ['pending', 'approved'] : ['pending']

  if (!allowedStatuses.includes(req.status)) {
    const label: Record<LeaveStatus, string> = {
      pending: '대기', approved: '승인', rejected: '반려', cancelled: '취소',
    }
    return { ok: false, message: `이미 ${label[req.status]} 처리된 신청입니다.` }
  }

  const employee = req.employees as unknown as {
    id: string; name: string; hired_at: string | null
    employee_type: 'full_time' | 'part_time'; work_days: string | null; slack_user_id: string | null
  } | null
  const employeeName = employee?.name ?? '(알 수 없음)'
  const typeLabel = LEAVE_TYPE_LABEL[req.leave_type] ?? '연차'
  const range = formatRange(req.start_date, req.end_date)

  const nextStatus = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled'

  // 캘린더 반영 — 실패해도 승인 자체는 진행한다 (google-calendar.ts 가 예외를 삼킨다)
  let calendarEventId: string | null = req.calendar_event_id
  if (action === 'approve') {
    calendarEventId = await createLeaveEvent({
      employeeName,
      leaveType: req.leave_type,
      startDate: req.start_date,
      endDate: req.end_date,
      days: Number(req.days),
      reason: req.reason,
    })
  } else if (req.calendar_event_id) {
    await deleteLeaveEvent(req.calendar_event_id)
    calendarEventId = null
  }

  const { data: updated, error: updateErr } = await admin
    .from('leave_requests')
    .update({
      status: nextStatus,
      reviewed_at: new Date().toISOString(),
      reviewed_by: reviewer,
      review_memo: memo ?? null,
      calendar_event_id: calendarEventId,
    })
    .eq('id', id)
    .in('status', allowedStatuses) // 동시 처리 방지 — 그 사이 누가 처리했으면 0건 업데이트
    .select('id')

  if (updateErr) {
    // 방금 만든 캘린더 이벤트가 떠도는 것을 막는다
    if (action === 'approve' && calendarEventId) await deleteLeaveEvent(calendarEventId)
    return { ok: false, message: `저장 실패: ${updateErr.message}` }
  }

  if (!updated || updated.length === 0) {
    // Slack 버튼과 웹 화면에서 동시에 눌린 경우 — 먼저 처리한 쪽이 이긴다
    if (action === 'approve' && calendarEventId) await deleteLeaveEvent(calendarEventId)
    return { ok: false, message: '다른 곳에서 이미 처리된 신청입니다.' }
  }

  const emoji = action === 'approve' ? '✅' : action === 'reject' ? '❌' : '↩️'
  const actionLabel = action === 'approve' ? '승인' : action === 'reject' ? '반려' : '취소'
  const summary = `${emoji} *${typeLabel} ${actionLabel}* — ${employeeName} · ${range} (${req.days}일)`

  // 원본 Slack 메시지의 버튼을 결과로 교체
  if (req.slack_channel_id && req.slack_message_ts) {
    await updateSlackMessage(req.slack_channel_id, req.slack_message_ts, summary, [
      { type: 'section', text: { type: 'mrkdwn', text: summary } },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: [`처리자: ${reviewer}`, memo ? `사유: ${memo}` : null].filter(Boolean).join(' · '),
        }],
      },
    ])
  }

  // 신청자에게 DM — 승인 결과를 본인이 바로 알 수 있게
  if (employee?.slack_user_id) {
    // 처리 후 잔여를 함께 알려준다 (승인이면 차감된 값, 반려·취소면 되돌아온 값)
    let remainingLine = ''
    try {
      const balance = await getLeaveBalance(admin, employee)
      if (balance.period) remainingLine = `> 남은 연차: *${balance.remaining}일*`
    } catch { /* 잔여 계산 실패해도 알림 자체는 보낸다 */ }

    await dmSlackUser(
      employee.slack_user_id,
      [
        `${emoji} 신청하신 *${typeLabel}*가 *${actionLabel}*되었습니다.`,
        `> 기간: ${range} (${req.days}일)`,
        memo ? `> 메모: ${memo}` : '',
        remainingLine,
        action === 'approve' ? '\n_잘 쉬고 오세요! 일정이 변경되면 `/연차 취소` 로 취소할 수 있습니다._' : '',
      ].filter(Boolean).join('\n'),
    )
  } else {
    console.warn(
      `[leave] ${employeeName} 님에게 결과를 알리지 못했습니다 — Slack 계정이 연결되어 있지 않습니다. ` +
      '직원 관리에서 Slack 사용자 ID를 연결해주세요.',
    )
  }

  return { ok: true, message: summary }
}
