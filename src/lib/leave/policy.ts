/**
 * 연차 발생 정책 — 입사일 기준
 *
 * 우리 회사 규칙 (5인 미만 사업장이라 근로기준법 제60조 적용 대상이 아니며, 아래는 회사 자율 규정):
 *   - 입사 첫 해(입사일 ~ 1년 미만): 입사일로부터 만 1개월이 지날 때마다 1개씩 발생 (최대 11개)
 *   - 입사 1년이 되는 날부터: 연차연도마다 15개 발생
 *   - 미사용분에 대한 연차수당은 발생하지 않는다 (5인 미만 → 급여 연동 없음)
 *
 * 여기 계산식은 어디까지나 "제안값"이다. leave_grants 에 행이 있으면 언제나 그 값이 우선한다.
 * 중도 입사·휴직·포상 휴가처럼 규칙에서 벗어나는 경우를 손으로 고칠 수 있어야 하기 때문이다.
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

/** 만 1년차부터 매년 발생하는 일수 */
export const ANNUAL_DAYS_AFTER_1Y = 15
/** 입사 첫 해 월별 발생 상한 (12개월째엔 정규 연차로 넘어가므로 11개) */
export const MAX_MONTHLY_ACCRUAL = 11

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

/**
 * 해당 연차연도에서 기준일까지 발생한 일수 (제안값).
 *
 * 첫 해는 "지금까지 몇 개 쌓였나"가 시간에 따라 늘어나므로 asOf 가 중요하다.
 * 만 1년차부터는 연차연도 시작일에 15개가 한 번에 발생한다.
 */
export function accruedDays(hiredAt: string, period: LeavePeriod, asOf: string = todayISO()): number {
  if (period.index >= 2) return ANNUAL_DAYS_AFTER_1Y

  // 첫 해: 입사일로부터 만 1개월이 지날 때마다 1개
  let months = 0
  while (months < MAX_MONTHLY_ACCRUAL && toISO(addMonths(hiredAt, months + 1)) <= asOf) {
    months++
  }
  return months
}

/** 첫 해에 다음 연차가 생기는 날짜 (Slack 안내용). 이미 상한이면 null */
export function nextAccrualDate(hiredAt: string, period: LeavePeriod, asOf: string = todayISO()): string | null {
  if (period.index >= 2) return null
  const earned = accruedDays(hiredAt, period, asOf)
  if (earned >= MAX_MONTHLY_ACCRUAL) return null
  return toISO(addMonths(hiredAt, earned + 1))
}

export function todayISO(): string {
  return new Date().toLocaleDateString('sv-SE') // YYYY-MM-DD (로컬 기준)
}

/** 연차연도 표시용 라벨 — "1년차 (2026-03-02 ~ 2027-03-01)" */
export function periodLabel(p: LeavePeriod): string {
  const name = p.index === 1 ? '입사 첫 해' : `${p.index - 1}년차`
  return `${name} (${p.start} ~ ${p.end})`
}
