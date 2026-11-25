import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  buildLeaveEventBody,
  createLeaveEvent,
  deleteLeaveEvent,
  exclusiveEnd,
  type CalendarApiLike,
} from './google-calendar'

test('exclusiveEnd: 종일 이벤트 종료일은 다음 날(월말/연말 경계 포함)', () => {
  assert.equal(exclusiveEnd('2026-11-27'), '2026-11-28')
  assert.equal(exclusiveEnd('2026-11-30'), '2026-12-01')
  assert.equal(exclusiveEnd('2026-12-31'), '2027-01-01')
})

test('buildLeaveEventBody: 연차(단일/기간)는 [연차] 이름, 종일·opaque 로 생성한다', () => {
  const single = buildLeaveEventBody({
    employeeName: '오량유',
    leaveType: 'annual',
    startDate: '2026-11-27',
    endDate: '2026-11-27',
    days: 1,
    reason: '개인 사유',
  })
  assert.equal(single.summary, '[연차] 오량유')
  assert.deepEqual(single.start, { date: '2026-11-27' })
  assert.deepEqual(single.end, { date: '2026-11-28' })
  assert.equal(single.transparency, 'opaque')
  assert.equal(single.description, '직원: 오량유\n종류: 연차\n차감: 1일')
  assert.equal(single.description.includes('사유'), false)
  assert.equal(single.description.includes('개인 사유'), false)
  assert.equal(single.description.includes('자동 생성된 일정'), false)
  assert.equal(single.description.includes('반영되지 않습니다'), false)

  const multi = buildLeaveEventBody({
    employeeName: '사가의',
    leaveType: 'annual',
    startDate: '2026-12-24',
    endDate: '2026-12-26',
    days: 2,
  })
  assert.equal(multi.summary, '[연차] 사가의')
  assert.deepEqual(multi.start, { date: '2026-12-24' })
  assert.deepEqual(multi.end, { date: '2026-12-27' })
  assert.equal(multi.transparency, 'opaque')
})

test('buildLeaveEventBody: 반차는 [오전반차]/[오후반차] 제목과 transparent 로 구분한다', () => {
  const am = buildLeaveEventBody({
    employeeName: '이현우',
    leaveType: 'half_am',
    startDate: '2026-12-01',
    endDate: '2026-12-01',
    days: 0.5,
  })
  assert.equal(am.summary, '[오전반차] 이현우')
  assert.deepEqual(am.start, { date: '2026-12-01' })
  assert.deepEqual(am.end, { date: '2026-12-02' })
  assert.equal(am.transparency, 'transparent')
  assert.match(am.description, /종류: 반차\(오전\)/)

  const pm = buildLeaveEventBody({
    employeeName: '나병훈',
    leaveType: 'half_pm',
    startDate: '2026-12-02',
    endDate: '2026-12-02',
    days: 0.5,
  })
  assert.equal(pm.summary, '[오후반차] 나병훈')
  assert.equal(pm.transparency, 'transparent')
})

test('createLeaveEvent: 성공 시 created 와 eventId 를 돌려준다', async () => {
  const inserted: { calendarId: string; summary: string }[] = []
  const fakeApi: CalendarApiLike = {
    events: {
      insert: async (args) => {
        inserted.push({ calendarId: args.calendarId, summary: args.requestBody.summary })
        return { data: { id: 'evt_123' } }
      },
      delete: async () => ({}),
    },
  }
  const res = await createLeaveEvent(
    { employeeName: '이강산', leaveType: 'annual', startDate: '2026-12-10', endDate: '2026-12-10', days: 1 },
    { calendar: fakeApi, calendarId: 'team@group.calendar.google.com' },
  )
  assert.deepEqual(res, { status: 'created', eventId: 'evt_123' })
  assert.deepEqual(inserted, [{ calendarId: 'team@group.calendar.google.com', summary: '[연차] 이강산' }])
})

test('createLeaveEvent: 환경변수 미설정 시 skipped, API 오류 시 예외 없이 failed 를 돌려준다', async () => {
  const skipped = await createLeaveEvent(
    { employeeName: '이강산', leaveType: 'annual', startDate: '2026-12-10', endDate: '2026-12-10', days: 1 },
    null,
  )
  assert.equal(skipped.status, 'skipped')

  const failingApi: CalendarApiLike = {
    events: {
      insert: async () => { throw new Error('Calendar API 403 Forbidden') },
      delete: async () => ({}),
    },
  }
  const failed = await createLeaveEvent(
    { employeeName: '이강산', leaveType: 'annual', startDate: '2026-12-10', endDate: '2026-12-10', days: 1 },
    { calendar: failingApi, calendarId: 'team@group.calendar.google.com' },
  )
  assert.equal(failed.status, 'failed')
  if (failed.status === 'failed') assert.match(failed.reason, /403 Forbidden/)
})

test('deleteLeaveEvent: 404/410 은 이미 삭제된 것으로 처리하고, 기타 오류는 failed 를 돌려준다', async () => {
  const api404: CalendarApiLike = {
    events: {
      insert: async () => ({ data: { id: 'x' } }),
      delete: async () => { throw Object.assign(new Error('Not Found'), { code: 404 }) },
    },
  }
  assert.deepEqual(
    await deleteLeaveEvent('evt_gone', { calendar: api404, calendarId: 'c1' }),
    { status: 'deleted' },
  )

  const api500: CalendarApiLike = {
    events: {
      insert: async () => ({ data: { id: 'x' } }),
      delete: async () => { throw new Error('Backend Error') },
    },
  }
  const failed = await deleteLeaveEvent('evt_err', { calendar: api500, calendarId: 'c1' })
  assert.equal(failed.status, 'failed')
})
