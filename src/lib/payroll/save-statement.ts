/**
 * 확정한 명세서를 저장한다.
 * 한 직원이 두 명세서에 함께 나오면 금액을 합쳐 한 줄에 쓰고, 명세서별 금액은 parts.ts에 따로 둔다.
 * monthly_payroll은 금액 칸만 쓴다 — 같은 행의 근무시간·결근 기록은 직원 관리 소유라 건드리지 않는다.
 */

import type { createClient } from '@/lib/supabase/client'
import type { Json } from '@/types/database'
import { outsourcedKey, type OutsourcedEntry } from './outsourced'
import { applyStatement, mergeParts, partFromSaved, partsKey, type StatementParts } from './parts'
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
  /** 사업소득지급대장의 외주 소득자 — 파일을 다시 올리면 통째로 바뀐다 */
  outsourced?: OutsourcedEntry[]
}

const cleared = {
  base_salary: 0, deductions: 0, net_pay: 0, other_deductions: 0, employer_insurance: 0,
  base_income_tax: 0, base_local_tax: 0, incentive_income_tax: 0, incentive_local_tax: 0,
  status: 'draft' as const, confirmed_at: null, statement_kind: null, statement_file: null, paid_at: null,
}

/** 금액만 지운다. 근태 기록이 같은 행에 있어 행을 삭제하지 않는다 */
async function clearRows(db: DB, year: number, month: number, employeeIds: string[]) {
  if (employeeIds.length === 0) return
  const { error } = await db.from('monthly_payroll').update(cleared)
    .eq('year', year).eq('month', month).in('employee_id', employeeIds)
  if (error) throw new Error(error.message)
  const { error: incentiveError } = await db.from('monthly_incentives').delete()
    .eq('year', year).eq('month', month).in('employee_id', employeeIds)
  if (incentiveError) throw new Error(incentiveError.message)
}

async function loadParts(db: DB, year: number, month: number): Promise<StatementParts> {
  const { data, error } = await db.from('settings').select('value').eq('key', partsKey(year, month)).maybeSingle()
  if (error) throw new Error(error.message)
  return (data?.value ?? {}) as unknown as StatementParts
}

async function saveParts(db: DB, year: number, month: number, parts: StatementParts) {
  const { error } = await db.from('settings').upsert(
    { key: partsKey(year, month), value: parts as unknown as Json }, { onConflict: 'key' },
  )
  if (error) throw new Error(error.message)
}

/** 금액과 명세서별 금액을 함께 지운다 */
export async function clearAmounts(db: DB, year: number, month: number, employeeIds: string[]) {
  if (employeeIds.length === 0) return
  await clearRows(db, year, month, employeeIds)
  const parts = await loadParts(db, year, month)
  if (!employeeIds.some((id) => parts[id])) return
  for (const id of employeeIds) delete parts[id]
  await saveParts(db, year, month, parts)
}

/** 명세서에 없는 현금 지급 — 세금 없이 지급액이 그대로 비용이다 */
export async function saveCashPay(db: DB, year: number, month: number, employeeId: string, amount: number) {
  const { error } = await db.from('monthly_payroll').upsert({
    ...cleared, year, month, employee_id: employeeId,
    base_salary: amount, net_pay: amount,
    status: 'confirmed', statement_kind: 'cash',
  }, { onConflict: 'year,month,employee_id' })
  if (error) throw new Error(error.message)
}

/** 통장에서 찾을 수 없는 지급(현금 등)을 사람이 지급 완료로 표시한다. null이면 표시를 푼다 */
export async function setPaidCheck(db: DB, year: number, month: number, employeeId: string, paidAt: string | null) {
  const { error } = await db.from('monthly_payroll').update({ paid_at: paidAt })
    .eq('year', year).eq('month', month).eq('employee_id', employeeId)
  if (error) throw new Error(error.message)
}

/** 이 기능 전에 저장된 줄을 명세서별 금액으로 옮긴다 — 다른 종류 명세서를 올려도 그 금액이 지워지지 않게 */
async function seedLegacyParts(db: DB, year: number, month: number, parts: StatementParts, ids: string[]) {
  const missing = ids.filter((id) => !parts[id])
  if (missing.length === 0) return parts
  const [{ data: saved, error }, { data: incentives, error: incentiveError }] = await Promise.all([
    db.from('monthly_payroll').select('*').eq('year', year).eq('month', month).in('employee_id', missing),
    db.from('monthly_incentives').select('employee_id, amount').eq('year', year).eq('month', month).in('employee_id', missing),
  ])
  if (error) throw new Error(error.message)
  if (incentiveError) throw new Error(incentiveError.message)
  const next = { ...parts }
  for (const p of saved ?? []) {
    if (!p.employee_id) continue
    const incentive = (incentives ?? []).filter((i) => i.employee_id === p.employee_id).reduce((s, i) => s + Number(i.amount), 0)
    const legacy = partFromSaved({ ...p, employee_id: p.employee_id }, incentive)
    if (legacy) next[p.employee_id] = { [legacy.kind]: legacy.part }
  }
  return next
}

export async function saveStatement(db: DB, { year, month, kind, filename, rows, droppedIds, outsourced = [] }: SaveInput) {
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10)

  if (kind === 'business') {
    const { error } = await db.from('settings').upsert(
      { key: outsourcedKey(year, month), value: outsourced as unknown as Json }, { onConflict: 'key' },
    )
    if (error) throw new Error(error.message)
  }

  const affected = [...new Set([...rows.map((r) => r.employeeId), ...droppedIds])]
  const before = await seedLegacyParts(db, year, month, await loadParts(db, year, month), affected)
  const parts = applyStatement(before, kind, filename, rows, droppedIds)

  const merged = affected.map((id) => ({ id, m: mergeParts(parts[id]) }))
  await clearRows(db, year, month, merged.filter((x) => !x.m).map((x) => x.id))

  const kept = merged.flatMap(({ id, m }) => (m ? [{ id, ...m }] : []))
  if (kept.length > 0) {
    const { error } = await db.from('monthly_payroll').upsert(
      kept.map(({ id, kind: k, file, row: r }) => ({
        year, month, employee_id: id,
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
        statement_kind: k,
        statement_file: file,
      })),
      { onConflict: 'year,month,employee_id' },
    )
    if (error) throw new Error(error.message)

    const ids = kept.map((x) => x.id)
    const { error: clearError } = await db.from('monthly_incentives').delete()
      .eq('year', year).eq('month', month).in('employee_id', ids)
    if (clearError) throw new Error(clearError.message)

    const paid = kept.filter((x) => x.row.incentive > 0)
    if (paid.length > 0) {
      const { error: incentiveError } = await db.from('monthly_incentives').insert(
        paid.map((x) => ({ year, month, employee_id: x.id, amount: x.row.incentive, memo: '세무사 명세서' })),
      )
      if (incentiveError) throw new Error(incentiveError.message)
    }
  }

  await saveParts(db, year, month, parts)
}
