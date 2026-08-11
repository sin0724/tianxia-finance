/**
 * 사업소득 원천징수 계산 — (주)티엔샤 사업소득지급대장 기준
 *
 * 세무사가 회신하는 대장의 세액은 다음 규칙으로 100% 재현된다
 * (2026.08 대장 12명 전원 검증):
 *   소득세     = 내림(지급액 × 3%, 10원 단위)
 *   지방소득세 = 내림(소득세 × 10%, 10원 단위)
 *   차인지급액 = 지급액 − 소득세 − 지방소득세
 *
 * 예) 594,000원 → 소득세 17,820 / 지방소득세 1,782→1,780 / 차인지급액 574,400
 *
 * 다만 이 값은 어디까지나 **검산용 제안값**이다. 실제 대장은 세무사가 확정하며
 * 앱에 기록되는 진실은 ③ 확정 단계에서 받아 적은 값이다.
 * (4대보험 가입자·연말정산 반영 등으로 달라질 수 있다.)
 */

export const BUSINESS_INCOME_TAX_RATE = 0.03
export const LOCAL_INCOME_TAX_RATE = 0.1

/** 10원 미만 절사 */
function floorTo10(n: number): number {
  return Math.floor(n / 10) * 10
}

export interface Withholding {
  /** 소득세 (3%) */
  incomeTax: number
  /** 지방소득세 (소득세의 10%) */
  localTax: number
  /** 원천징수 합계 */
  totalTax: number
  /** 차인지급액 (세후) */
  net: number
}

/** 세전 지급액에 대한 사업소득 3.3% 원천징수를 계산한다. */
export function withhold(gross: number): Withholding {
  const g = Math.max(0, Math.round(gross))
  const incomeTax = floorTo10(g * BUSINESS_INCOME_TAX_RATE)
  const localTax = floorTo10(incomeTax * LOCAL_INCOME_TAX_RATE)
  return { incomeTax, localTax, totalTax: incomeTax + localTax, net: g - incomeTax - localTax }
}

// ── 아르바이트 급여 산정 ──────────────────────────────────────
//
// 주휴수당(근로기준법 제55조)은 두 가지 조건이 모두 맞아야 발생한다.
//   ① 1주 소정근로시간이 15시간 이상일 것
//   ② 그 주의 소정근로일을 개근할 것 — 결근한 주는 발생하지 않는다
// 금액은 (1주 소정근로시간 ÷ 40) × 8시간 × 시급이며, 주 40시간을 넘어도 8시간분이 상한이다.
//
// 근무 일정(요일·시각·휴게시간)이 등록된 직원은 주 단위로 정확히 계산하고,
// 등록되지 않은 직원은 예전처럼 월 근무시간을 주 평균으로 환산해 근사한다.

/** 한 달에 들어있는 평균 주 수 — 365 ÷ 7 ÷ 12 */
export const WEEKS_PER_MONTH = 4.345

/** 주휴수당 발생 최소 근로시간 (주) */
export const WEEKLY_HOLIDAY_MIN_HOURS = 15

/** 주휴시간 산정의 기준이 되는 법정 1주 근로시간 */
const FULL_TIME_WEEKLY_HOURS = 40

/** 주휴시간 상한 (1일분) */
const HOLIDAY_HOURS_CAP = 8

/** getDay() 순서 — 일요일이 0 */
const WEEK_DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'] as const

/**
 * 연도별 최저임금 (시간급). 매년 8월에 다음 해분이 고시되므로 직접 갱신해야 한다.
 * 포괄시급의 실질 기본시급이 이 값에 못 미치면 최저임금법 위반이다.
 */
export const MINIMUM_WAGE_BY_YEAR: Record<number, number> = {
  2024: 9860,
  2025: 10030,
  2026: 10320,
}

/** 해당 연도의 최저임금 — 등록되지 않은 미래 연도는 가장 최근 값으로 대신한다 */
export function minimumWage(year: number = new Date().getFullYear()): number {
  const years = Object.keys(MINIMUM_WAGE_BY_YEAR).map(Number).sort((a, b) => a - b)
  const applicable = years.filter((y) => y <= year).pop() ?? years[0]
  return MINIMUM_WAGE_BY_YEAR[applicable]
}

/** 1주 소정근로시간에 대한 주휴시간 — (주소정 ÷ 40) × 8, 상한 8시간 */
function holidayHoursFor(weeklyHours: number): number {
  return Math.min(weeklyHours / FULL_TIME_WEEKLY_HOURS, 1) * HOLIDAY_HOURS_CAP
}

// ── 근무 일정 ────────────────────────────────────────────────

export interface WorkSchedule {
  /** 근무 요일 — 쉼표 구분 '월,수,금' */
  days: string | null
  /** 근무 시작 'HH:MM' */
  start: string | null
  /** 근무 종료 'HH:MM' */
  end: string | null
  /** 1일 무급 휴게시간 (분) */
  breakMinutes: number
}

/** 'HH:MM' → 자정 기준 분. 형식이 어긋나면 null */
function parseHM(v: string | null | undefined): number | null {
  if (!v) return null
  const m = /^(\d{1,2}):(\d{2})/.exec(v.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/**
 * 하루 재실시간(분) — 출근부터 퇴근까지. 휴게시간이 아직 빠지지 않은 값이다.
 * 종료가 시작보다 이르면 자정을 넘긴 야간 근무로 본다.
 */
export function dailySpanMinutes(s: WorkSchedule): number | null {
  const a = parseHM(s.start)
  const b = parseHM(s.end)
  if (a === null || b === null || a === b) return null
  return b > a ? b - a : b + 1440 - a
}

/** 하루 소정근로시간 — 재실시간에서 무급 휴게시간을 뺀 시간 */
export function dailyWorkHours(s: WorkSchedule): number | null {
  const span = dailySpanMinutes(s)
  if (span === null) return null
  return Math.max(0, span - Math.max(0, s.breakMinutes)) / 60
}

/**
 * 근로기준법 제54조가 요구하는 최소 휴게시간(분).
 * 기준은 재실시간이 아니라 휴게를 뺀 실근로시간이다.
 */
export function requiredBreakMinutes(workHours: number): number {
  if (workHours >= 8) return 60
  if (workHours >= 4) return 30
  return 0
}

/** 그 달에 지정 요일이 몇 번 오는지 센다 */
export function countScheduledDays(days: string | null, year: number, month: number): number {
  const set = new Set((days ?? '').split(',').map((d) => d.trim()).filter(Boolean))
  if (set.size === 0) return 0
  const lastDay = new Date(year, month, 0).getDate()
  let count = 0
  for (let d = 1; d <= lastDay; d++) {
    if (set.has(WEEK_DAY_NAMES[new Date(year, month - 1, d).getDay()])) count++
  }
  return count
}

export interface ResolvedSchedule {
  /** 하루 소정근로시간 (휴게 제외) */
  dailyHours: number
  /** 주당 근무 일수 */
  daysPerWeek: number
  /** 1주 소정근로시간 */
  weeklyHours: number
  /** 이 달 소정근로일수 */
  monthlyDays: number
  /** 이 달 소정근로시간 */
  monthlyHours: number
  /** 이 달에 들어있는 소정근로 주 수 */
  weeks: number
  /** 하루 재실시간 (휴게 포함) */
  spanHours: number
  /** 설정된 무급 휴게시간 (분) */
  breakMinutes: number
  /** 법정 최소 휴게시간에서 모자란 분 — 0이면 적법 */
  breakShortfall: number
}

/**
 * 직원 마스터의 근무 일정을 그 달의 실제 달력에 맞춰 푼다.
 * 요일이나 시각이 비어 있으면 null — 호출부는 월 평균 근사로 돌아간다.
 */
export function resolveSchedule(s: WorkSchedule, year: number, month: number): ResolvedSchedule | null {
  const dailyHours = dailyWorkHours(s)
  const span = dailySpanMinutes(s)
  if (dailyHours === null || span === null || dailyHours <= 0) return null

  const daysPerWeek = new Set((s.days ?? '').split(',').map((d) => d.trim()).filter(Boolean)).size
  const monthlyDays = countScheduledDays(s.days, year, month)
  if (daysPerWeek === 0 || monthlyDays === 0) return null

  const breakMinutes = Math.max(0, s.breakMinutes)
  return {
    dailyHours,
    daysPerWeek,
    weeklyHours: dailyHours * daysPerWeek,
    monthlyDays,
    monthlyHours: dailyHours * monthlyDays,
    weeks: monthlyDays / daysPerWeek,
    spanHours: span / 60,
    breakMinutes,
    breakShortfall: Math.max(0, requiredBreakMinutes(dailyHours) - breakMinutes),
  }
}

// ── 급여 계산 ────────────────────────────────────────────────

export interface PartTimePayInput {
  /** 이 달 실제 근무한 시간 — 휴게시간과 결근을 이미 뺀 값 */
  hours: number
  hourlyWage: number
  /** 이 달 결근 일수. 결근한 주는 주휴가 발생하지 않는다 */
  absentDays?: number
  /** 시급에 주휴가 이미 포함된 계약(포괄시급)이면 따로 더하지 않는다 */
  wageIncludesHoliday?: boolean
  /** 이번 달만 주휴를 빼는 수동 스위치 */
  includeHoliday?: boolean
  /** 근무 일정. 있으면 주 단위로 정확히, 없으면 월 평균으로 근사한다 */
  schedule?: ResolvedSchedule | null
}

export interface PartTimePay {
  /** 시급 × 실근무시간 */
  hourlyPay: number
  /** 주휴 대상 여부 (주 15시간 이상) */
  eligible: boolean
  /** 판정에 쓴 1주 근로시간 */
  weeklyHours: number
  /** 이 달 주휴 발생 가능 주 수 */
  weeks: number
  /** 결근으로 주휴가 소멸한 주 수 */
  forfeitedWeeks: number
  /** 결근이 없었다면 받았을 주휴수당 */
  fullHolidayPay: number
  /** 결근으로 깎인 금액 */
  forfeitedPay: number
  /** 실제로 더해지는 주휴수당 — 포괄시급이거나 스위치를 끄면 0 */
  weeklyHolidayPay: number
  /** 세전 지급액 */
  total: number
  /** 포괄시급일 때 시급 안에 들어있는 주휴 상당분 */
  embeddedHolidayPay: number
  /** 포괄시급을 풀었을 때의 실질 기본시급 */
  effectiveBaseWage: number
  /** 주휴를 무엇에 근거해 계산했는지 */
  basis: 'schedule' | 'average'
}

/**
 * 아르바이트 급여 산정 — 시급 × 실근무시간 + 주휴수당.
 *
 * 결근은 시급분에서 빼지 않는다. hours 가 이미 결근을 뺀 실근무시간이기 때문이며,
 * absentDays 는 오직 "그 주의 주휴가 발생했는가"를 가리는 데만 쓴다. 결근이 서로 다른 주에
 * 흩어졌다고 보아 결근 1일당 1주치 주휴가 소멸하는 것으로 계산한다.
 */
export function calcPartTimePay(input: PartTimePayInput): PartTimePay {
  const hours = Math.max(0, input.hours)
  const wage = Math.max(0, input.hourlyWage)
  const absentDays = Math.max(0, input.absentDays ?? 0)
  const includeHoliday = input.includeHoliday !== false
  const includesInWage = input.wageIncludesHoliday === true
  const sch = input.schedule ?? null

  const hourlyPay = Math.round(hours * wage)

  // 주휴 판정 기준은 소정근로시간이다. 일정이 있으면 결근과 무관하게 소정 그대로 쓰고,
  // 없으면 실근무시간을 주 평균으로 환산해 근사한다(결근이 많은 달은 과소평가될 수 있다).
  const weeklyHours = sch ? sch.weeklyHours : hours / WEEKS_PER_MONTH
  const weeks = sch ? sch.weeks : WEEKS_PER_MONTH
  const eligible = weeklyHours >= WEEKLY_HOLIDAY_MIN_HOURS

  const holidayHours = holidayHoursFor(weeklyHours)

  // 포괄시급 — 주휴가 시급에 녹아 있으므로 따로 더하지 않고, 얼마가 녹아 있는지만 되짚는다.
  // 주 40시간 이하에서 주휴는 소정근로시간의 20%이므로 기본시급 = 시급 ÷ 1.2 가 된다.
  const holidayRatio = eligible && weeklyHours > 0 ? holidayHours / weeklyHours : 0
  const effectiveBaseWage = includesInWage && holidayRatio > 0 ? wage / (1 + holidayRatio) : wage
  const embeddedHolidayPay = includesInWage
    ? hourlyPay - Math.round(hours * effectiveBaseWage)
    : 0

  // 주휴 금액의 단가 — 포괄시급이면 시급이 아니라 실질 기본시급으로 따져야
  // 주휴분에 주휴가 또 붙지 않는다
  const holidayWage = includesInWage ? effectiveBaseWage : wage
  const fullHolidayPay = eligible ? Math.round(weeks * holidayHours * holidayWage) : 0
  const forfeitedWeeks = eligible ? Math.min(absentDays, weeks) : 0
  const earnedHolidayPay = eligible
    ? Math.round(Math.max(0, weeks - forfeitedWeeks) * holidayHours * holidayWage)
    : 0
  const forfeitedPay = fullHolidayPay - earnedHolidayPay

  const weeklyHolidayPay = includesInWage || !includeHoliday ? 0 : earnedHolidayPay

  return {
    hourlyPay,
    eligible,
    weeklyHours,
    weeks,
    forfeitedWeeks,
    fullHolidayPay,
    forfeitedPay,
    weeklyHolidayPay,
    total: hourlyPay + weeklyHolidayPay,
    embeddedHolidayPay,
    effectiveBaseWage,
    basis: sch ? 'schedule' : 'average',
  }
}

export type PayrollStatus = 'draft' | 'submitted' | 'confirmed' | 'paid'

export const STATUS_ORDER: PayrollStatus[] = ['draft', 'submitted', 'confirmed', 'paid']

export const STATUS_LABEL: Record<PayrollStatus, string> = {
  draft: '산정 중',
  submitted: '세무사 확정 대기',
  confirmed: '확정 (입금 대기)',
  paid: '지급 완료',
}

/** 여러 직원의 상태를 월 단위 하나로 요약한다 — 가장 덜 진행된 단계가 그 달의 상태. */
export function aggregateStatus(statuses: PayrollStatus[]): PayrollStatus {
  if (statuses.length === 0) return 'draft'
  return statuses.reduce<PayrollStatus>(
    (lowest, s) => (STATUS_ORDER.indexOf(s) < STATUS_ORDER.indexOf(lowest) ? s : lowest),
    'paid'
  )
}
