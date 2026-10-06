/**
 * 연차 일수 계산 & Slack 커맨드 텍스트 파싱
 */

import { todayISO } from './policy'

export type LeaveType = 'annual' | 'half_am' | 'half_pm' | 'sick' | 'unpaid' | 'special'

const WEEKDAY_KR = ['일', '월', '화', '수', '목', '금', '토']

function toDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function weekdayKR(iso: string): string {
  return WEEKDAY_KR[toDate(iso).getDay()]
}

/**
 * 근무일 판정 — 주말과 공휴일 제외.
 * 아르바이트처럼 근무 요일이 정해져 있으면(employees.work_days) 그 요일만 근무일로 본다.
 */
export function isWorkday(iso: string, holidays: Set<string>, workDays?: string | null): boolean {
  if (holidays.has(iso)) return false
  const dow = toDate(iso).getDay()

  if (workDays && workDays.trim()) {
    const allowed = workDays.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
    return allowed.includes(WEEKDAY_KR[dow])
  }
  return dow !== 0 && dow !== 6 // 기본: 월~금
}

/** 기간 내 근무일 목록 */
export function workdaysBetween(
  start: string,
  end: string,
  holidays: Set<string>,
  workDays?: string | null,
): string[] {
  const result: string[] = []
  const cursor = toDate(start)
  const last = toDate(end)
  while (cursor <= last) {
    const iso = toISO(cursor)
    if (isWorkday(iso, holidays, workDays)) result.push(iso)
    cursor.setDate(cursor.getDate() + 1)
  }
  return result
}

/**
 * 차감 일수 계산. 반차는 하루짜리이며 0.5일.
 * 주말·공휴일만 낀 신청(예: 토~일)은 0이 나오므로 호출부에서 거부해야 한다.
 */
export function calcDays(
  leaveType: LeaveType,
  start: string,
  end: string,
  holidays: Set<string>,
  workDays?: string | null,
): number {
  if (leaveType === 'half_am' || leaveType === 'half_pm') {
    return isWorkday(start, holidays, workDays) ? 0.5 : 0
  }
  return workdaysBetween(start, end, holidays, workDays).length
}

// ─────────────────────────────────────────────────────────────
// Slack 커맨드 파싱
// ─────────────────────────────────────────────────────────────

/**
 * 날짜 토큰 하나를 YYYY-MM-DD 로. 인식 못 하면 null.
 * 연도가 없으면 올해로 보되, 30일 이상 지난 날짜면 내년으로 넘긴다
 * (연말에 "1/5" 를 신청하면 내년 1월을 의도한 것이므로).
 */
export function parseDateToken(raw: string, today: string = todayISO()): string | null {
  const t = raw.trim()

  if (/^(오늘|today)$/i.test(t)) return today
  if (/^(내일|tomorrow)$/i.test(t)) {
    const d = toDate(today); d.setDate(d.getDate() + 1); return toISO(d)
  }
  if (/^모레$/.test(t)) {
    const d = toDate(today); d.setDate(d.getDate() + 2); return toISO(d)
  }

  // 2026-12-25 / 2026.12.25 / 2026/12/25
  const full = t.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})$/)
  if (full) {
    const [, y, m, d] = full
    return normalize(+y, +m, +d)
  }

  // 2026년 12월 25일
  const krFull = t.match(/^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일?$/)
  if (krFull) {
    const [, y, m, d] = krFull
    return normalize(+y, +m, +d)
  }

  // 12/25 · 12.25 · 12-25 · 12월25일
  const short =
    t.match(/^(\d{1,2})[.\-/](\d{1,2})$/) ??
    t.match(/^(\d{1,2})월\s*(\d{1,2})일?$/)
  if (short) {
    const [, m, d] = short
    const thisYear = normalize(new Date(today).getFullYear(), +m, +d)
    if (!thisYear) return null
    const diff = (toDate(thisYear).getTime() - toDate(today).getTime()) / 86400000
    if (diff < -30) return normalize(new Date(today).getFullYear() + 1, +m, +d)
    return thisYear
  }

  return null

  function normalize(y: number, m: number, d: number): string | null {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null
    const dt = new Date(y, m - 1, d)
    if (dt.getMonth() !== m - 1 || dt.getDate() !== d) return null // 2/30 같은 값 거르기
    return toISO(dt)
  }
}

export type ParsedCommand =
  | { kind: 'balance' }
  | { kind: 'cancel' }
  | { kind: 'help' }
  | { kind: 'apply'; leaveType: LeaveType; start: string; end: string; reason: string }
  | { kind: 'error'; message: string }

/**
 * `/연차` 커맨드 파싱
 *
 *   /연차                        → 내 잔여 연차 조회
 *   /연차 12/25                  → 하루 신청
 *   /연차 12/25~12/27 가족여행    → 기간 신청 + 사유
 *   /연차 반차 12/25 오전         → 반차 신청
 *   /연차 병가 12/25             → 병가 (연차 미차감)
 *   /연차 취소                   → 가장 최근 대기 건 취소
 */
export function parseLeaveCommand(text: string, today: string = todayISO()): ParsedCommand {
  const trimmed = text.trim()
  if (!trimmed) return { kind: 'balance' }
  if (/^(도움말|help|\?)$/i.test(trimmed)) return { kind: 'help' }
  if (/^(취소|cancel)$/i.test(trimmed)) return { kind: 'cancel' }
  if (/^(조회|잔여|남은|현황|balance)$/i.test(trimmed)) return { kind: 'balance' }

  const tokens = trimmed.split(/\s+/)
  let leaveType: LeaveType = 'annual'
  let halfHinted = false

  // 종류 키워드는 어디에 있든 뽑아낸다 (붙어 있는 "반차"/"오전" 순서를 강제하지 않기 위해)
  const rest: string[] = []
  for (const tok of tokens) {
    if (/^(반차|반일)$/.test(tok)) { halfHinted = true; continue }
    if (/^(오전|am|午前)$/i.test(tok)) { leaveType = 'half_am'; halfHinted = true; continue }
    if (/^(오후|pm)$/i.test(tok)) { leaveType = 'half_pm'; halfHinted = true; continue }
    if (/^(병가|아파서|병원)$/.test(tok)) { leaveType = 'sick'; continue }
    if (/^(무급|무급휴가)$/.test(tok)) { leaveType = 'unpaid'; continue }
    if (/^(특별휴가|경조사|포상)$/.test(tok)) { leaveType = 'special'; continue }
    rest.push(tok)
  }

  // "반차"만 있고 오전/오후를 안 적었으면 오전으로 본다
  if (halfHinted && leaveType !== 'half_am' && leaveType !== 'half_pm') leaveType = 'half_am'

  if (rest.length === 0) {
    return { kind: 'error', message: '날짜를 입력해주세요. 예) `/연차 12/25`' }
  }

  // 첫 토큰이 날짜(또는 기간). "12/25~12/27", "12/25-12/27", "12/25 ~ 12/27" 모두 허용
  const joined = rest.join(' ')
  const rangeMatch = joined.match(/^(\S+)\s*[~∼]\s*(\S+)(?:\s+([\s\S]*))?$/)

  let start: string | null
  let end: string | null
  let reason: string

  if (rangeMatch) {
    start = parseDateToken(rangeMatch[1], today)
    end = parseDateToken(rangeMatch[2], today)
    reason = (rangeMatch[3] ?? '').trim()
  } else {
    start = parseDateToken(rest[0], today)
    end = start
    reason = rest.slice(1).join(' ').trim()
  }

  if (!start) {
    return { kind: 'error', message: `날짜를 알아볼 수 없습니다: \`${rest[0]}\`\n예) \`12/25\`, \`2026-12-25\`, \`내일\`` }
  }
  if (!end) {
    return { kind: 'error', message: '종료일을 알아볼 수 없습니다. 예) `/연차 12/25~12/27`' }
  }
  if (end < start) {
    return { kind: 'error', message: '종료일이 시작일보다 빠릅니다.' }
  }
  if ((leaveType === 'half_am' || leaveType === 'half_pm') && end !== start) {
    return { kind: 'error', message: '반차는 하루만 신청할 수 있습니다.' }
  }

  return { kind: 'apply', leaveType, start, end, reason }
}

/** "12/25(목)" 또는 "12/25(목) ~ 12/27(토)" */
export function formatRange(start: string, end: string): string {
  const fmt = (iso: string) => {
    const [, m, d] = iso.split('-')
    return `${+m}/${+d}(${weekdayKR(iso)})`
  }
  return start === end ? fmt(start) : `${fmt(start)} ~ ${fmt(end)}`
}
