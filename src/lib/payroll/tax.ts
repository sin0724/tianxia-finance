/**
 * 근무 일정·최저임금·급여 대상 기간.
 * 급여 금액은 세무사 명세서가 기준이라 여기서 계산하지 않는다.
 */

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

// ── 급여 대상 기간 ───────────────────────────────────────────

/** 입사일이 이 달 말일보다 뒤면 아직 입사 전이다 (입사일 미입력은 대상으로 본다) */
export const hiredBy = (e: { hired_at: string | null }, monthEnd: string) => !e.hired_at || e.hired_at <= monthEnd

/** 퇴사자는 퇴사일이 이 달 1일 이후면 그 달까지 대상이다 */
export const workedThrough = (e: { active: boolean; terminated_at: string | null }, monthStart: string) =>
  e.active || (!!e.terminated_at && e.terminated_at >= monthStart)
