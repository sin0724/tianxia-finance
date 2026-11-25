/**
 * 구글 캘린더 연동 — 승인된 연차만 단방향으로 내보낸다.
 *
 * 캘린더에서 일정을 지우거나 고쳐도 앱은 읽지 않는다. 양방향으로 만들면
 * 시트 동기화에서 겪었던 중복·ID 어긋남 문제가 그대로 재현되기 때문이다.
 * 원본은 언제나 leave_requests 다.
 *
 * 설정 방법:
 *   1. 팀 공유 캘린더("티엔샤" 등) 설정 → 특정 사용자와 공유 → 서비스 계정 이메일 추가 → 권한 "변경 및 공유 관리"
 *   2. 캘린더 ID(...@group.calendar.google.com)를 GOOGLE_CALENDAR_ID 환경변수에 넣는다
 *   3. 캘린더 전용 서비스 계정을 쓸 때는 GOOGLE_CREDENTIALS (또는 GOOGLE_CALENDAR_CREDENTIALS)에 JSON을 넣는다
 *      (미설정 시 GOOGLE_SHEETS_CREDENTIALS 를 대체 사용)
 *
 * GOOGLE_CALENDAR_ID 가 없으면 skipped 결과를 돌려준다 — 캘린더 장애나 미설정이 연차 승인을 막지 않는다.
 */

import { google } from 'googleapis'
import { LEAVE_TYPE_LABEL } from './leave/policy'

export type LeaveCalendarRequest = {
  employeeName: string
  leaveType: string
  startDate: string
  endDate: string
  days: number
  reason?: string | null
}

export type CalendarCreateResult =
  | { status: 'created'; eventId: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }

export type CalendarDeleteResult =
  | { status: 'deleted' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }

/** 캘린더 제목용 휴가 구분 라벨 */
const CALENDAR_LEAVE_LABEL: Record<string, string> = {
  annual: '연차',
  half_am: '오전반차',
  half_pm: '오후반차',
  sick: '병가',
  unpaid: '무급휴가',
  special: '특별휴가',
}

function getCalendarCredentialsRaw(): string | undefined {
  return (
    process.env.GOOGLE_CALENDAR_CREDENTIALS ||
    process.env.GOOGLE_CREDENTIALS ||
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_SHEETS_CREDENTIALS ||
    undefined
  )
}

function getCalendarClient() {
  const credentialsRaw = getCalendarCredentialsRaw()
  const calendarId = process.env.GOOGLE_CALENDAR_ID?.trim()

  if (!credentialsRaw || !calendarId) return null

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(credentialsRaw),
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
  })

  return { calendar: google.calendar({ version: 'v3', auth }), calendarId }
}

export function isCalendarConfigured(): boolean {
  return !!(process.env.GOOGLE_CALENDAR_ID?.trim() && getCalendarCredentialsRaw())
}

/** 종일 이벤트의 end.date 는 배타적이라 종료일 +1 을 넣어야 한다 */
export function exclusiveEnd(endDate: string): string {
  const [y, m, d] = endDate.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + 1))
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

/** 캘린더 이벤트 본문 생성 (단위 테스트에서 직접 검증 가능하도록 분리) */
export function buildLeaveEventBody(req: LeaveCalendarRequest) {
  const calendarLabel = CALENDAR_LEAVE_LABEL[req.leaveType] ?? LEAVE_TYPE_LABEL[req.leaveType] ?? '연차'
  const detailLabel = LEAVE_TYPE_LABEL[req.leaveType] ?? calendarLabel
  const isHalf = req.leaveType === 'half_am' || req.leaveType === 'half_pm'

  return {
    summary: `[${calendarLabel}] ${req.employeeName}`,
    description: [
      `직원: ${req.employeeName}`,
      `종류: ${detailLabel}`,
      `차감: ${req.days}일`,
    ].filter((line) => line !== null).join('\n'),
    start: { date: req.startDate },
    end: { date: exclusiveEnd(req.endDate) },
    transparency: (isHalf ? 'transparent' : 'opaque') as 'transparent' | 'opaque',
  }
}

function formatErrorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message
  return String(e)
}

export type CalendarApiLike = {
  events: {
    insert: (args: { calendarId: string; requestBody: ReturnType<typeof buildLeaveEventBody> }) => Promise<{ data: { id?: string | null } }>
    delete: (args: { calendarId: string; eventId: string }) => Promise<unknown>
  }
}

/**
 * 승인된 연차를 캘린더에 올린다. 실패해도 예외를 던지지 않고 상태를 돌려준다 —
 * 캘린더 장애가 연차 승인 자체를 막으면 안 되기 때문이다.
 */
export async function createLeaveEvent(
  req: LeaveCalendarRequest,
  overrideClient?: { calendar: CalendarApiLike; calendarId: string } | null,
): Promise<CalendarCreateResult> {
  let client: { calendar: CalendarApiLike; calendarId: string } | null
  try {
    client = overrideClient !== undefined ? overrideClient : getCalendarClient()
  } catch (e) {
    const reason = `Google 서비스 계정 파싱 실패: ${formatErrorMessage(e)}`
    console.error('[calendar]', reason)
    return { status: 'failed', reason }
  }

  if (!client) {
    return { status: 'skipped', reason: 'GOOGLE_CALENDAR_ID 또는 Google 서비스 계정 환경변수가 설정되지 않았습니다.' }
  }

  try {
    const res = await client.calendar.events.insert({
      calendarId: client.calendarId,
      requestBody: buildLeaveEventBody(req),
    })
    if (!res.data.id) {
      return { status: 'failed', reason: '캘린더 이벤트 ID가 반환되지 않았습니다.' }
    }
    return { status: 'created', eventId: res.data.id }
  } catch (e) {
    const reason = formatErrorMessage(e)
    console.error('[calendar] 이벤트 생성 실패:', e)
    return { status: 'failed', reason }
  }
}

/** 반려·취소 시 캘린더에서 지운다. 이미 없으면(404/410) 삭제된 것으로 본다. */
export async function deleteLeaveEvent(
  eventId: string,
  overrideClient?: { calendar: CalendarApiLike; calendarId: string } | null,
): Promise<CalendarDeleteResult> {
  let client: { calendar: CalendarApiLike; calendarId: string } | null
  try {
    client = overrideClient !== undefined ? overrideClient : getCalendarClient()
  } catch (e) {
    const reason = `Google 서비스 계정 파싱 실패: ${formatErrorMessage(e)}`
    console.error('[calendar]', reason)
    return { status: 'failed', reason }
  }

  if (!client) {
    return { status: 'skipped', reason: 'GOOGLE_CALENDAR_ID 또는 Google 서비스 계정 환경변수가 설정되지 않았습니다.' }
  }

  try {
    await client.calendar.events.delete({ calendarId: client.calendarId, eventId })
    return { status: 'deleted' }
  } catch (e) {
    const err = e as { code?: number; status?: number }
    const code = err.code ?? err.status
    if (code === 404 || code === 410) return { status: 'deleted' } // 이미 삭제됨
    const reason = formatErrorMessage(e)
    console.error('[calendar] 이벤트 삭제 실패:', e)
    return { status: 'failed', reason }
  }
}
