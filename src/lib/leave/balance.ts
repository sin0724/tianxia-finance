/**
 * 연차 잔여 집계 — Slack 조회와 관리자 화면이 모두 이 한 곳을 쓴다.
 * (결제 미연결 배지를 countUnmatchedPayments 한 곳에서만 판정하는 것과 같은 이유)
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import {
  DEDUCTING_TYPES, accruedDays, currentPeriod, expiryDate, nextAccrualDate, previousPeriod, todayISO,
  type Attendance, type LeavePeriod,
} from './policy'
import { workdaysBetween } from './calc'

type Client = SupabaseClient<Database>

export type LeaveBalance = {
  employeeId: string
  employeeName: string
  hiredAt: string | null
  /** 연차 발생 대상인지 — 아르바이트는 연차가 발생하지 않는다 */
  eligible: boolean
  period: LeavePeriod | null
  /** 이번 연차연도에 발생한 일수 */
  granted: number
  /** 전년도 이월 */
  carriedOver: number
  /** 임의 가감 */
  adjustment: number
  /** 사용 가능 총량 = granted + carriedOver + adjustment */
  total: number
  /** 승인되어 확정 사용된 일수 */
  used: number
  /** 승인 대기중이라 예약된 일수 */
  pending: number
  /** 실제 쓸 수 있는 잔여 = total − used − pending */
  remaining: number
  /** leave_grants 에 행이 있어 수동 지정된 값인지 (false면 정책 계산값) */
  isManualGrant: boolean
  /** 첫 해에 다음 연차가 붙는 날 — 그달 개근 시 (없으면 null) */
  nextAccrualAt: string | null
  /** 미사용 연차가 사라지는 날 (= 연차연도 종료 다음 날) */
  expiresAt: string | null
  /** 발생 일수 산정 근거 (수동 지정이면 그 사실) */
  basis: string
  /** 직전 연차연도 출근율 (첫 해·수동 지정이면 null) */
  attendanceRate: number | null
}

/** 여러 직원을 한 번에 계산할 때 공휴일·결근을 매번 다시 읽지 않도록 미리 넘긴다 */
export type BalanceContext = {
  holidays: Set<string>
  /** 이 직원의 결근 기록 */
  absences: { date: string; days: number }[]
}

/** 연차에서 차감되는 신청 종류인지 */
function deducts(leaveType: string): boolean {
  return (DEDUCTING_TYPES as readonly string[]).includes(leaveType)
}

export type LeaveBalanceEmployee = {
  id: string
  name: string
  hired_at: string | null
  employee_type: 'full_time' | 'part_time'
  /** 근무 요일 — 출근율의 소정근로일 계산에 쓴다 (비우면 월~금) */
  work_days?: string | null
}

/** 연차는 정직원에게만 발생한다 */
export function isLeaveEligible(employee: { employee_type: 'full_time' | 'part_time' }): boolean {
  return employee.employee_type === 'full_time'
}

/**
 * 직원 한 명의 잔여 연차.
 * 기간 경계를 걸친 신청은 시작일이 속한 연차연도에서 차감한다.
 */
export async function getLeaveBalance(
  supabase: Client,
  employee: LeaveBalanceEmployee,
  asOf: string = todayISO(),
  ctx?: BalanceContext,
): Promise<LeaveBalance> {
  const eligible = isLeaveEligible(employee)
  const base = {
    employeeId: employee.id,
    employeeName: employee.name,
    hiredAt: employee.hired_at,
    eligible,
  }

  const period = eligible && employee.hired_at ? currentPeriod(employee.hired_at, asOf) : null

  if (!eligible || !employee.hired_at || !period) {
    // 아르바이트는 연차가 없고, 입사일이 없으면 발생량을 계산할 수 없다
    // (관리자가 직원 관리에서 입사일을 넣어야 한다).
    return {
      ...base, period: null,
      granted: 0, carriedOver: 0, adjustment: 0, total: 0,
      used: 0, pending: 0, remaining: 0,
      isManualGrant: false, nextAccrualAt: null, expiresAt: null,
      basis: eligible ? '입사일 미등록' : '아르바이트 — 연차 미발생',
      attendanceRate: null,
    }
  }

  // 출근 판정은 직전 연차연도부터 지금 연도까지만 필요하다
  const windowStart = previousPeriod(employee.hired_at, period)?.start ?? period.start
  const [holidays, absences] = ctx
    ? [ctx.holidays, ctx.absences]
    : await Promise.all([fetchHolidays(supabase), fetchAbsences(supabase, employee.id, windowStart)])

  const attendance: Attendance = {
    absences,
    scheduledDays: (start, end) => workdaysBetween(start, end, holidays, employee.work_days).length,
  }

  const [{ data: grant }, { data: requests }] = await Promise.all([
    supabase
      .from('leave_grants')
      .select('granted_days, carried_over, adjustment')
      .eq('employee_id', employee.id)
      .eq('period_start', period.start)
      .maybeSingle(),
    supabase
      .from('leave_requests')
      .select('leave_type, days, status')
      .eq('employee_id', employee.id)
      .gte('start_date', period.start)
      .lte('start_date', period.end)
      .in('status', ['approved', 'pending']),
  ])

  const isManualGrant = !!grant
  const accrual = grant ? null : accruedDays(employee.hired_at, period, attendance, asOf)
  const granted = grant ? Number(grant.granted_days) : accrual!.days
  const carriedOver = grant ? Number(grant.carried_over) : 0
  const adjustment = grant ? Number(grant.adjustment) : 0
  const total = granted + carriedOver + adjustment

  let used = 0
  let pending = 0
  for (const r of requests ?? []) {
    if (!deducts(r.leave_type)) continue
    if (r.status === 'approved') used += Number(r.days)
    else if (r.status === 'pending') pending += Number(r.days)
  }

  return {
    ...base,
    period,
    granted, carriedOver, adjustment, total,
    used, pending,
    remaining: total - used - pending,
    isManualGrant,
    nextAccrualAt: nextAccrualDate(employee.hired_at, period, asOf),
    expiresAt: expiryDate(period),
    basis: accrual?.basis ?? '관리자 수동 지정',
    attendanceRate: accrual?.attendanceRate ?? null,
  }
}

/** 직원 한 명의 결근 기록 (from 이후) */
export async function fetchAbsences(supabase: Client, employeeId: string, from: string) {
  const { data } = await supabase
    .from('leave_absences')
    .select('absence_date, days')
    .eq('employee_id', employeeId)
    .gte('absence_date', from)
  return (data ?? []).map((a) => ({ date: a.absence_date, days: Number(a.days) }))
}

/** 재직 중인 정직원의 잔여 연차 (관리자 현황 탭) — 아르바이트는 연차가 없어 뺀다 */
export async function getAllLeaveBalances(supabase: Client, asOf: string = todayISO()): Promise<LeaveBalance[]> {
  const { data: employees } = await supabase
    .from('employees')
    .select('id, name, hired_at, employee_type, work_days, sort_order')
    .eq('active', true)
    .eq('employee_type', 'full_time')
    .order('sort_order', { ascending: true, nullsFirst: false })
    .order('name')

  // 공휴일·결근은 한 번만 읽어 직원별로 나눠준다 (직원 수만큼 왕복하지 않게)
  const [holidays, { data: absences }] = await Promise.all([
    fetchHolidays(supabase),
    supabase.from('leave_absences').select('employee_id, absence_date, days'),
  ])

  return Promise.all((employees ?? []).map((e) => getLeaveBalance(supabase, e, asOf, {
    holidays,
    absences: (absences ?? [])
      .filter((a) => a.employee_id === e.id)
      .map((a) => ({ date: a.absence_date, days: Number(a.days) })),
  })))
}

/** 공휴일 집합 — 일수 계산에 쓴다 */
export async function fetchHolidays(supabase: Client): Promise<Set<string>> {
  const { data } = await supabase.from('company_holidays').select('holiday_date')
  return new Set((data ?? []).map((h) => h.holiday_date))
}
