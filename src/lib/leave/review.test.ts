import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { reviewLeaveRequest, getCalendarFailureNotifyUserIds } from './review'

type LeaveRow = {
  id: string
  employee_id: string
  leave_type: string
  start_date: string
  end_date: string
  days: number
  reason: string | null
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  slack_channel_id: string | null
  slack_message_ts: string | null
  calendar_event_id: string | null
  employees: {
    id: string
    name: string
    hired_at: string | null
    employee_type: 'full_time' | 'part_time'
    work_days: string | null
    slack_user_id: string | null
  }
}

function createFakeAdmin(initial: LeaveRow) {
  const row: LeaveRow = { ...initial, employees: { ...initial.employees } }
  let lastUpdate: Record<string, unknown> | null = null

  const admin = {
    from: () => ({
      select: () => ({
        eq: (_col: string, val: string) => ({
          maybeSingle: async () => (val === row.id ? { data: row, error: null } : { data: null, error: null }),
        }),
      }),
      update: (payload: Record<string, unknown>) => ({
        eq: (_col: string, val: string) => ({
          in: (_col2: string, statuses: string[]) => ({
            select: async () => {
              if (val !== row.id || !statuses.includes(row.status)) {
                return { data: [], error: null }
              }
              lastUpdate = payload
              Object.assign(row, payload)
              return { data: [{ id: row.id }], error: null }
            },
          }),
        }),
      }),
    }),
  }

  return { admin: admin as unknown as Parameters<typeof reviewLeaveRequest>[0], row, getLastUpdate: () => lastUpdate }
}

function sampleRow(overrides: Partial<LeaveRow> = {}): LeaveRow {
  return {
    id: 'req-1',
    employee_id: 'emp-1',
    leave_type: 'annual',
    start_date: '2026-12-01',
    end_date: '2026-12-01',
    days: 1,
    reason: '휴식',
    status: 'pending',
    slack_channel_id: 'C0BP8QJKPM2',
    slack_message_ts: '1795000000.000100',
    calendar_event_id: null,
    employees: {
      id: 'emp-1',
      name: '오량유',
      hired_at: '2026-01-01',
      employee_type: 'full_time',
      work_days: null,
      slack_user_id: 'U_EMP1',
    },
    ...overrides,
  }
}

test('승인 시 캘린더 등록 성공하면 calendar_event_id 저장 및 슬랙 메시지에 "캘린더 등록됨" 표시', async () => {
  const { admin, row } = createFakeAdmin(sampleRow())
  const slackUpdates: { channel: string; ts: string; blocks: unknown[] }[] = []
  const dms: { userId: string; text: string }[] = []

  const res = await reviewLeaveRequest(
    admin,
    { id: 'req-1', action: 'approve', reviewer: 'hyuun0724' },
    {
      createLeaveEvent: async () => ({ status: 'created', eventId: 'evt_cal_1' }),
      deleteLeaveEvent: async () => ({ status: 'deleted' }),
      updateSlackMessage: async (channel, ts, _text, blocks) => {
        slackUpdates.push({ channel, ts, blocks: blocks ?? [] })
      },
      dmSlackUser: async (userId, text) => {
        dms.push({ userId, text })
      },
      getLeaveBalance: async () => ({
        employeeId: 'emp-1', employeeName: '오량유', hiredAt: '2026-01-01', eligible: true,
        period: { index: 1, start: '2026-01-01', end: '2026-12-31' },
        granted: 10, carriedOver: 0, adjustment: 0, total: 10, used: 1, pending: 0, remaining: 9,
        isManualGrant: false, nextAccrualAt: null, expiresAt: null, basis: 'test', attendanceRate: null,
      }),
      failureNotifyUserIds: ['U0AHE6BR86P'],
    },
  )

  assert.equal(res.ok, true)
  if (res.ok) assert.equal(res.calendarStatus, 'created')
  assert.equal(row.status, 'approved')
  assert.equal(row.calendar_event_id, 'evt_cal_1')

  // 슬랙 승인 메시지 context 에 "캘린더 등록됨" 포함
  assert.equal(slackUpdates.length, 1)
  const serialized = JSON.stringify(slackUpdates[0].blocks)
  assert.match(serialized, /캘린더 등록됨/)

  // 신청자 DM 1건만 발송, 대표님 실패 알림 없음
  assert.equal(dms.length, 1)
  assert.equal(dms[0].userId, 'U_EMP1')
  assert.match(dms[0].text, /승인/)
})

test('캘린더 등록 실패해도 연차 승인은 정상 진행되고 대표님에게 실패 알림 DM 을 보낸다', async () => {
  const { admin, row } = createFakeAdmin(sampleRow())
  const slackUpdates: unknown[] = []
  const dms: { userId: string; text: string }[] = []

  const res = await reviewLeaveRequest(
    admin,
    { id: 'req-1', action: 'approve', reviewer: 'hyuun0724' },
    {
      createLeaveEvent: async () => ({ status: 'failed', reason: '403 Forbidden' }),
      deleteLeaveEvent: async () => ({ status: 'deleted' }),
      updateSlackMessage: async (_c, _t, _text, blocks) => { slackUpdates.push(blocks) },
      dmSlackUser: async (userId, text) => { dms.push({ userId, text }) },
      getLeaveBalance: async () => ({
        employeeId: 'emp-1', employeeName: '오량유', hiredAt: '2026-01-01', eligible: true,
        period: null, granted: 0, carriedOver: 0, adjustment: 0, total: 0, used: 0, pending: 0, remaining: 0,
        isManualGrant: false, nextAccrualAt: null, expiresAt: null, basis: '', attendanceRate: null,
      }),
      failureNotifyUserIds: ['U0AHE6BR86P'],
    },
  )

  assert.equal(res.ok, true)
  if (res.ok) assert.equal(res.calendarStatus, 'failed')
  assert.equal(row.status, 'approved')
  assert.equal(row.calendar_event_id, null)

  // 슬랙 메시지에도 실패 표시
  assert.match(JSON.stringify(slackUpdates[0]), /캘린더 등록 실패/)

  // 신청자 DM + 대표님 실패 알림 DM
  assert.equal(dms.length, 2)
  const ceoDm = dms.find((d) => d.userId === 'U0AHE6BR86P')
  assert.ok(ceoDm)
  assert.match(ceoDm.text, /연차 캘린더 등록 실패/)
  assert.match(ceoDm.text, /403 Forbidden/)
})

test('승인된 연차를 취소하면 등록된 캘린더 일정을 삭제하고 슬랙 메시지에 삭제 표시를 남긴다', async () => {
  const { admin, row } = createFakeAdmin(sampleRow({ status: 'approved', calendar_event_id: 'evt_cal_99' }))
  const deletedIds: string[] = []
  const slackUpdates: unknown[] = []
  const dms: { userId: string; text: string }[] = []

  const res = await reviewLeaveRequest(
    admin,
    { id: 'req-1', action: 'cancel', reviewer: '오량유', memo: '신청자 취소' },
    {
      createLeaveEvent: async () => ({ status: 'created', eventId: 'unused' }),
      deleteLeaveEvent: async (eventId) => {
        deletedIds.push(eventId)
        return { status: 'deleted' }
      },
      updateSlackMessage: async (_c, _t, _text, blocks) => { slackUpdates.push(blocks) },
      dmSlackUser: async (userId, text) => { dms.push({ userId, text }) },
      getLeaveBalance: async () => ({
        employeeId: 'emp-1', employeeName: '오량유', hiredAt: '2026-01-01', eligible: true,
        period: null, granted: 0, carriedOver: 0, adjustment: 0, total: 0, used: 0, pending: 0, remaining: 0,
        isManualGrant: false, nextAccrualAt: null, expiresAt: null, basis: '', attendanceRate: null,
      }),
      failureNotifyUserIds: ['U0AHE6BR86P'],
    },
  )

  assert.equal(res.ok, true)
  if (res.ok) assert.equal(res.calendarStatus, 'deleted')
  assert.deepEqual(deletedIds, ['evt_cal_99'])
  assert.equal(row.status, 'cancelled')
  assert.equal(row.calendar_event_id, null)
  assert.match(JSON.stringify(slackUpdates[0]), /캘린더 일정 삭제됨/)
  assert.equal(dms.length, 1)
})

test('getCalendarFailureNotifyUserIds: 기본값은 대표님(U0AHE6BR86P)을 포함한다', () => {
  const prev = process.env.SLACK_LEAVE_APPROVERS
  const prevNotify = process.env.SLACK_LEAVE_ADMIN_NOTIFY
  delete process.env.SLACK_LEAVE_APPROVERS
  delete process.env.SLACK_LEAVE_ADMIN_NOTIFY
  try {
    assert.deepEqual(getCalendarFailureNotifyUserIds(), ['U0AHE6BR86P'])
    process.env.SLACK_LEAVE_APPROVERS = 'U_OTHER'
    assert.deepEqual(getCalendarFailureNotifyUserIds(), ['U_OTHER', 'U0AHE6BR86P'])
  } finally {
    if (prev !== undefined) process.env.SLACK_LEAVE_APPROVERS = prev
    else delete process.env.SLACK_LEAVE_APPROVERS
    if (prevNotify !== undefined) process.env.SLACK_LEAVE_ADMIN_NOTIFY = prevNotify
    else delete process.env.SLACK_LEAVE_ADMIN_NOTIFY
  }
})
