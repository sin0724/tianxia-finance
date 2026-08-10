/**
 * 구글 캘린더 연동 — 승인된 연차만 단방향으로 내보낸다.
 *
 * 캘린더에서 일정을 지우거나 고쳐도 앱은 읽지 않는다. 양방향으로 만들면
 * 시트 동기화에서 겪었던 중복·ID 어긋남 문제가 그대로 재현되기 때문이다.
 * 원본은 언제나 leave_requests 다.
 *
 * 설정 방법:
 *   1. 구글 캘린더에서 "티엔샤 연차" 캘린더를 새로 만든다
 *   2. 설정 → 특정 사용자와 공유 → 서비스 계정 이메일 추가 → 권한 "변경 및 공유 관리"
 *   3. 캘린더 ID(...@group.calendar.google.com)를 GOOGLE_CALENDAR_ID 환경변수에 넣는다
 *
 * GOOGLE_CALENDAR_ID 가 없으면 모든 함수가 조용히 no-op 이다 — 캘린더 없이도 연차 관리는 동작한다.
 */

import { google } from 'googleapis'
import { LEAVE_TYPE_LABEL } from './leave/policy'

function getCalendarClient() {
  const credentialsRaw = process.env.GOOGLE_CREDENTIALS ?? process.env.GOOGLE_SHEETS_CREDENTIALS
  const calendarId = process.env.GOOGLE_CALENDAR_ID

  if (!credentialsRaw || !calendarId) return null

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(credentialsRaw),
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
  })

  return { calendar: google.calendar({ version: 'v3', auth }), calendarId }
}

export function isCalendarConfigured(): boolean {
  return !!(process.env.GOOGLE_CALENDAR_ID &&
    (process.env.GOOGLE_CREDENTIALS ?? process.env.GOOGLE_SHEETS_CREDENTIALS))
}

/** 종일 이벤트의 end.date 는 배타적이라 종료일 +1 을 넣어야 한다 */
function exclusiveEnd(endDate: string): string {
  const [y, m, d] = endDate.split('-').map(Number)
  const dt = new Date(y, m - 1, d + 1)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

/**
 * 승인된 연차를 캘린더에 올린다. 실패해도 예외를 던지지 않고 null 을 돌려준다 —
 * 캘린더 장애가 연차 승인 자체를 막으면 안 되기 때문이다.
 */
export async function createLeaveEvent(req: {
  employeeName: string
  leaveType: string
  startDate: string
  endDate: string
  days: number
  reason?: string | null
}): Promise<string | null> {
  const client = getCalendarClient()
  if (!client) return null

  const typeLabel = LEAVE_TYPE_LABEL[req.leaveType] ?? '연차'
  const isHalf = req.leaveType === 'half_am' || req.leaveType === 'half_pm'

  try {
    const res = await client.calendar.events.insert({
      calendarId: client.calendarId,
      requestBody: {
        summary: `[${typeLabel}] ${req.employeeName}`,
        description: [
          `직원: ${req.employeeName}`,
          `종류: ${typeLabel}`,
          `차감: ${req.days}일`,
          req.reason ? `사유: ${req.reason}` : null,
          '',
          '※ 티엔샤 재무관리에서 자동 생성된 일정입니다. 여기서 수정해도 시스템에 반영되지 않습니다.',
        ].filter(Boolean).join('\n'),
        start: { date: req.startDate },
        end: { date: exclusiveEnd(req.endDate) },
        transparency: isHalf ? 'transparent' : 'opaque',
      },
    })
    return res.data.id ?? null
  } catch (e) {
    console.error('[calendar] 이벤트 생성 실패:', e)
    return null
  }
}

/** 반려·취소 시 캘린더에서 지운다. 이미 없으면 조용히 넘어간다. */
export async function deleteLeaveEvent(eventId: string): Promise<void> {
  const client = getCalendarClient()
  if (!client) return

  try {
    await client.calendar.events.delete({ calendarId: client.calendarId, eventId })
  } catch (e) {
    const status = (e as { code?: number }).code
    if (status === 404 || status === 410) return // 이미 삭제됨
    console.error('[calendar] 이벤트 삭제 실패:', e)
  }
}
