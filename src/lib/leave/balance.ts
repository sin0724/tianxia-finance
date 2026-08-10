/**
 * 연차 잔여 집계 — Slack 조회와 관리자 화면이 모두 이 한 곳을 쓴다.
 * (결제 미연결 배지를 countUnmatchedPayments 한 곳에서만 판정하는 것과 같은 이유)
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { DEDUCTING_TYPES, accruedDays, currentPeriod, nextAccrualDate, todayISO, type LeavePeriod } from './policy'

type Client = SupabaseClient<Database>

export type LeaveBalance = {
  employeeId: string
  employeeName: string
  hiredAt: string | null
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
  /** 첫 해에 다음 연차가 붙는 날 (없으면 null) */
  nextAccrualAt: string | null
}

/** 연차에서 차감되는 신청 종류인지 */
function deducts(leaveType: string): boolean {
  return (DEDUCTING_TYPES as readonly string[]).includes(leaveType)
}

/**
 * 직원 한 명의 잔여 연차.
 * 기간 경계를 걸친 신청은 시작일이 속한 연차연도에서 차감한다.
 */
export async function getLeaveBalance(
  supabase: Client,
  employee: { id: string; name: string; hired_at: string | null },
  asOf: string = todayISO(),
): Promise<LeaveBalance> {
  const base = {
    employeeId: employee.id,
    employeeName: employee.name,
    hiredAt: employee.hired_at,
  }

  const period = employee.hired_at ? currentPeriod(employee.hired_at, asOf) : null

  if (!employee.hired_at || !period) {
    // 입사일이 없으면 발생량을 계산할 수 없다. 관리자가 직원 관리에서 입사일을 넣어야 한다.
    return {
      ...base, period: null,
      granted: 0, carriedOver: 0, adjustment: 0, total: 0,
      used: 0, pending: 0, remaining: 0,
      isManualGrant: false, nextAccrualAt: null,
    }
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
  const granted = grant ? Number(grant.granted_days) : accruedDays(employee.hired_at, period, asOf)
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
  }
}

/** 재직 중인 전 직원의 잔여 연차 (관리자 현황 탭) */
export async function getAllLeaveBalances(supabase: Client, asOf: string = todayISO()): Promise<LeaveBalance[]> {
  const { data: employees } = await supabase
    .from('employees')
    .select('id, name, hired_at, sort_order')
    .eq('active', true)
    .order('sort_order', { ascending: true, nullsFirst: false })
    .order('name')

  return Promise.all((employees ?? []).map((e) => getLeaveBalance(supabase, e, asOf)))
}

/** 공휴일 집합 — 일수 계산에 쓴다 */
export async function fetchHolidays(supabase: Client): Promise<Set<string>> {
  const { data } = await supabase.from('company_holidays').select('holiday_date')
  return new Set((data ?? []).map((h) => h.holiday_date))
}
