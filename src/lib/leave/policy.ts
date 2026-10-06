/**
 * 연차 발생 정책 — 입사일 기준 (근로기준법 제60조와 같은 기준으로 운영)
 *
 *   - 정직원만 대상 (아르바이트는 발생하지 않음 — balance.ts 의 isLeaveEligible)
 *   - 입사 첫 해(1년 미만): 입사일로부터 1개월 개근할 때마다 1일 (최대 11일)
 *   - 1년 이상: 직전 연차연도 출근율이 80% 이상이면 15일
 *       + 근속 가산 — 최초 1년을 초과하는 계속근로 매 2년마다 1일 (총 25일 한도)
 *     출근율이 80% 미만이면 직전 연도에 개근한 달마다 1일
 *   - 미사용 연차는 연차연도가 끝나면 소멸한다 (이월은 leave_grants 로 수동 지정할 때만)
 *   - 소멸 6개월 전 1차, 2개월 전 2차 사용 촉진 (promotion.ts)
 *
 * 개근·출근율은 leave_absences(결근 기록)로 판정한다. 기록이 없으면 개근으로 본다.
 *
 * 여기 계산식은 기본값이다. leave_grants 에 행이 있으면 언제나 그 값이 우선한다.
 * 휴직·포상 휴가처럼 규칙에서 벗어나는 경우를 손으로 고칠 수 있어야 하기 때문이다.
 */

/** 연차연도 — 입사일 기준으로 끊은 1년 구간 */
export type LeavePeriod = {
  /** 1 = 입사 첫 해, 2 = 만 1년차, ... */
  index: number
  /** 구간 시작 (포함) YYYY-MM-DD */
  start: string
  /** 구간 종료 (포함) YYYY-MM-DD */
  end: string
}

/** 연차에서 차감되는 휴가 종류 — 병가·무급·특별휴가는 차감하지 않는다 */
export const DEDUCTING_TYPES = ['annual', 'half_am', 'half_pm'] as const

export const LEAVE_TYPE_LABEL: Record<string, string> = {
  annual: '연차',
  half_am: '반차(오전)',
  half_pm: '반차(오후)',
  sick: '병가',
  unpaid: '무급휴가',
  special: '특별휴가',
}

/** 1년 이상 근속 시 기본 발생 일수 */
export const ANNUAL_DAYS_AFTER_1Y = 15
/** 근속 가산 포함 연간 상한 */
export const MAX_ANNUAL_DAYS = 25
/** 입사 첫 해 월별 발생 상한 (12개월째엔 정규 연차로 넘어가므로 11개) */
export const MAX_MONTHLY_ACCRUAL = 11
/** 15일 발생에 필요한 직전 연도 출근율 */
export const MIN_ATTENDANCE_RATE = 0.8

/** 사용 촉진 시점 — 소멸일로부터 몇 개월 전에 보내는지 */
export const PROMOTION_MONTHS_BEFORE = { 1: 6, 2: 2 } as const

/** 출근 판정 재료 — 결근 기록과 소정근로일 계산기 (공휴일·근무요일은 호출부가 안다) */
export type Attendance = {
  absences: { date: string; days: number }[]
  /** [start, end] (포함) 사이 소정근로일수 */
  scheduledDays: (start: string, end: string) => number
}

function toDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function toISO(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 입사일에 n년을 더한 날짜.
 * 2월 29일 입사처럼 해당 날짜가 없는 해에는 그 달의 마지막 날로 맞춘다.
 */
function addYears(iso: string, n: number): Date {
  const d = toDate(iso)
  const target = new Date(d.getFullYear() + n, d.getMonth(), d.getDate())
  if (target.getDate() !== d.getDate()) target.setDate(0) // 말일로 보정
  return target
}

function addMonths(iso: string, n: number): Date {
  const d = toDate(iso)
  const target = new Date(d.getFullYear(), d.getMonth() + n, d.getDate())
  if (target.getDate() !== d.getDate()) target.setDate(0)
  return target
}

/** 기준일이 속한 연차연도를 구한다. 입사일 이전이면 null */
export function currentPeriod(hiredAt: string, asOf: string = todayISO()): LeavePeriod | null {
  if (!hiredAt) return null
  if (asOf < hiredAt) return null

  // 입사일로부터 몇 년이 지났는지 (만 나이 방식)
  let years = 0
  while (toISO(addYears(hiredAt, years + 1)) <= asOf) years++

  const start = years === 0 ? hiredAt : toISO(addYears(hiredAt, years))
  const endExclusive = addYears(hiredAt, years + 1)
  endExclusive.setDate(endExclusive.getDate() - 1)

  return { index: years + 1, start, end: toISO(endExclusive) }
}

/** n개월 뒤 날짜 (ISO). 말일 보정 포함 */
export function addMonthsISO(iso: string, n: number): string {
  return toISO(addMonths(iso, n))
}

export function addDaysISO(iso: string, n: number): string {
  const d = toDate(iso)
  d.setDate(d.getDate() + n)
  return toISO(d)
}

/** 직전 연차연도. 첫 해면 null */
export function previousPeriod(hiredAt: string, period: LeavePeriod): LeavePeriod | null {
  if (period.index <= 1) return null
  return currentPeriod(hiredAt, addDaysISO(period.start, -1))
}

/** 소멸일 — 연차연도 마지막 날의 다음 날. 이날부터 미사용 연차는 사라진다 */
export function expiryDate(period: LeavePeriod): string {
  return addDaysISO(period.end, 1)
}

/** 촉진 통보일 (1차: 소멸 6개월 전, 2차: 2개월 전) */
export function promotionDate(period: LeavePeriod, stage: 1 | 2): string {
  return addMonthsISO(expiryDate(period), -PROMOTION_MONTHS_BEFORE[stage])
}

/**
 * 근속 연수별 연차 — 15일 + 최초 1년 초과 계속근로 매 2년마다 1일, 25일 한도.
 *   1·2년 15일, 3·4년 16일, 5·6년 17일, … 21년 이상 25일
 */
export function annualDaysForYears(completedYears: number): number {
  if (completedYears < 1) return 0
  const bonus = Math.floor((completedYears - 1) / 2)
  return Math.min(ANNUAL_DAYS_AFTER_1Y + bonus, MAX_ANNUAL_DAYS)
}

function absenceIn(att: Attendance, start: string, endExclusive: string): number {
  return att.absences
    .filter((a) => a.date >= start && a.date < endExclusive)
    .reduce((sum, a) => sum + a.days, 0)
}

/** 입사일 기준 k번째 달 [hire+(k-1)개월, hire+k개월) 을 개근했는지 */
function perfectMonth(hiredAt: string, k: number, att: Attendance): boolean {
  return absenceIn(att, addMonthsISO(hiredAt, k - 1), addMonthsISO(hiredAt, k)) === 0
}

/** 연차연도 출근율 = (소정근로일 − 결근) ÷ 소정근로일 */
export function attendanceRate(period: LeavePeriod, att: Attendance): number {
  const scheduled = att.scheduledDays(period.start, period.end)
  if (scheduled <= 0) return 1
  const absent = absenceIn(att, period.start, addDaysISO(period.end, 1))
  return Math.max(0, (scheduled - absent) / scheduled)
}

export type Accrual = {
  days: number
  /** 산정 근거 — 직원 안내·관리자 화면에 그대로 보여준다 */
  basis: string
  /** 직전 연도 출근율 (첫 해면 null) */
  attendanceRate: number | null
}

/**
 * 해당 연차연도에서 기준일까지 발생한 일수.
 *
 * 첫 해는 "지금까지 몇 개 쌓였나"가 시간에 따라 늘어나므로 asOf 가 중요하다.
 * 1년 이상은 연차연도 시작일에 직전 연도 출근율로 한 번에 정해진다.
 */
export function accruedDays(
  hiredAt: string,
  period: LeavePeriod,
  att: Attendance,
  asOf: string = todayISO(),
): Accrual {
  if (period.index === 1) {
    let earned = 0
    let missed = 0
    for (let k = 1; k <= MAX_MONTHLY_ACCRUAL && addMonthsISO(hiredAt, k) <= asOf; k++) {
      if (perfectMonth(hiredAt, k, att)) earned++
      else missed++
    }
    return {
      days: earned,
      basis: `입사 첫 해 — 1개월 개근마다 1일${missed > 0 ? ` (결근으로 ${missed}개월 미발생)` : ''}`,
      attendanceRate: null,
    }
  }

  const completedYears = period.index - 1
  const prev = previousPeriod(hiredAt, period)!
  const rate = attendanceRate(prev, att)
  const pct = Math.floor(rate * 1000) / 10

  if (rate >= MIN_ATTENDANCE_RATE) {
    const days = annualDaysForYears(completedYears)
    const bonus = days - ANNUAL_DAYS_AFTER_1Y
    return {
      days,
      basis: `근속 ${completedYears}년 · 직전 연도 출근율 ${pct}% → 15일${bonus > 0 ? ` + 가산 ${bonus}일` : ''}`,
      attendanceRate: rate,
    }
  }

  // 출근율 80% 미만 — 직전 연도에 개근한 달마다 1일
  let months = 0
  for (let k = 1; k <= 12; k++) {
    const from = addMonthsISO(prev.start, k - 1)
    const to = addMonthsISO(prev.start, k)
    if (absenceIn(att, from, to) === 0) months++
  }
  const days = Math.min(months, MAX_MONTHLY_ACCRUAL)
  return {
    days,
    basis: `직전 연도 출근율 ${pct}% (80% 미만) → 개근한 ${months}개월분 ${days}일`,
    attendanceRate: rate,
  }
}

/** 첫 해에 다음 연차가 생길 수 있는 날짜 (그달 개근 시). 이미 상한이면 null */
export function nextAccrualDate(hiredAt: string, period: LeavePeriod, asOf: string = todayISO()): string | null {
  if (period.index >= 2) return null
  for (let k = 1; k <= MAX_MONTHLY_ACCRUAL; k++) {
    const d = addMonthsISO(hiredAt, k)
    if (d > asOf) return d
  }
  return null
}

export function todayISO(): string {
  return new Date().toLocaleDateString('sv-SE') // YYYY-MM-DD (로컬 기준)
}

/** 연차연도 표시용 라벨 — "1년차 (2026-03-02 ~ 2027-03-01)" */
export function periodLabel(p: LeavePeriod): string {
  const name = p.index === 1 ? '입사 첫 해' : `${p.index - 1}년차`
  return `${name} (${p.start} ~ ${p.end})`
}
