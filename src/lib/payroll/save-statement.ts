/**
 * 확정한 명세서를 저장한다.
 * monthly_payroll은 금액 칸만 쓴다 — 같은 행의 근무시간·결근 기록은 직원 관리 소유라 건드리지 않는다.
 */

import type { createClient } from '@/lib/supabase/client'
import type { StatementKind, StatementRow } from './statement'

type DB = ReturnType<typeof createClient>

export type ConfirmedRow = StatementRow & { employeeId: string }

interface SaveInput {
  year: number
  month: number
  kind: StatementKind
  filename: string
  rows: ConfirmedRow[]
  /** 같은 종류의 이전 명세서에는 있었지만 이번 파일에 없는 직원 */
  droppedIds: string[]
}

const cleared = {
  base_salary: 0, deductions: 0, net_pay: 0, other_deductions: 0, employer_insurance: 0,
  base_income_tax: 0, base_local_tax: 0, incentive_income_tax: 0, incentive_local_tax: 0,
  status: 'draft' as const, confirmed_at: null, statement_kind: null, statement_file: null,
}

/** 금액만 지운다. 근태 기록이 같은 행에 있어 행을 삭제하지 않는다 */
export async function clearAmounts(db: DB, year: number, month: number, employeeIds: string[]) {
  if (employeeIds.length === 0) return
  const { error } = await db.from('monthly_payroll').update(cleared)
    .eq('year', year).eq('month', month).in('employee_id', employeeIds)
  if (error) throw new Error(error.message)
  const { error: incentiveError } = await db.from('monthly_incentives').delete()
    .eq('year', year).eq('month', month).in('employee_id', employeeIds)
  if (incentiveError) throw new Error(incentiveError.message)
}

export async function saveStatement(db: DB, { year, month, kind, filename, rows, droppedIds }: SaveInput) {
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10)
  await clearAmounts(db, year, month, droppedIds)

  const { error } = await db.from('monthly_payroll').upsert(
    rows.map((r) => ({
      year, month, employee_id: r.employeeId,
      base_salary: r.base,
      base_income_tax: r.baseIncomeTax,
      base_local_tax: r.baseLocalTax,
      incentive_income_tax: r.incentiveIncomeTax,
      incentive_local_tax: r.incentiveLocalTax,
      other_deductions: r.otherDeductions,
      employer_insurance: r.employerInsurance,
      deductions: r.baseIncomeTax + r.baseLocalTax + r.otherDeductions,
      net_pay: r.net,
      status: 'confirmed' as const,
      confirmed_at: today,
      statement_kind: kind,
      statement_file: filename,
    })),
    { onConflict: 'year,month,employee_id' },
  )
  if (error) throw new Error(error.message)

  const ids = rows.map((r) => r.employeeId)
  const { error: clearError } = await db.from('monthly_incentives').delete()
    .eq('year', year).eq('month', month).in('employee_id', ids)
  if (clearError) throw new Error(clearError.message)

  const paid = rows.filter((r) => r.incentive > 0)
  if (paid.length === 0) return
  const { error: incentiveError } = await db.from('monthly_incentives').insert(
    paid.map((r) => ({ year, month, employee_id: r.employeeId, amount: r.incentive, memo: '세무사 명세서' })),
  )
  if (incentiveError) throw new Error(incentiveError.message)
}
