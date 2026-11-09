/**
 * 한 직원이 같은 달에 두 명세서에 함께 나오는 경우 — 예: 최저시급 기준 월급은 4대보험 급여, 나머지는 3.3% 사업소득.
 *
 * monthly_payroll은 직원·월마다 한 줄이라 두 명세서 금액을 합쳐 저장하고,
 * 명세서별 금액은 settings에 달별로 따로 둔다. 한쪽 명세서를 다시 올리면 그쪽 몫만 바뀐다.
 * 이름·금액이 들어가 저장소가 아닌 settings에 둔다 (외주 소득자와 같은 방식).
 */

import type { StatementKind, StatementRow } from './statement'

export interface StatementPart extends StatementRow {
  file: string
}

/** 직원 id → 명세서 종류 → 그 명세서의 금액 */
export type StatementParts = Record<string, Partial<Record<StatementKind, StatementPart>>>

export const partsKey = (year: number, month: number) => `statement_parts_${year}-${String(month).padStart(2, '0')}`

/** 4대보험 급여를 먼저 둔다 — 합친 줄의 종류·파일 표시 순서 */
export const PART_ORDER: StatementKind[] = ['insured', 'business']

export interface MergedPayroll {
  kind: StatementKind
  file: string
  row: StatementRow
}

/** 한 직원의 명세서별 금액을 합친다. 남은 명세서가 없으면 null */
export function mergeParts(parts: Partial<Record<StatementKind, StatementPart>> | undefined): MergedPayroll | null {
  const list = PART_ORDER.flatMap((k) => (parts?.[k] ? [{ kind: k, part: parts[k] as StatementPart }] : []))
  if (list.length === 0) return null
  const sum = (f: (p: StatementPart) => number) => list.reduce((s, { part }) => s + f(part), 0)
  return {
    kind: list[0].kind,
    file: [...new Set(list.map(({ part }) => part.file))].join(' + '),
    row: {
      rawName: list[0].part.rawName,
      base: sum((p) => p.base),
      incentive: sum((p) => p.incentive),
      baseIncomeTax: sum((p) => p.baseIncomeTax),
      baseLocalTax: sum((p) => p.baseLocalTax),
      incentiveIncomeTax: sum((p) => p.incentiveIncomeTax),
      incentiveLocalTax: sum((p) => p.incentiveLocalTax),
      otherDeductions: sum((p) => p.otherDeductions),
      employerInsurance: sum((p) => p.employerInsurance),
      net: sum((p) => p.net),
    },
  }
}

/** 이 기능 전에 저장된 줄 — 명세서별 금액이 없으면 저장된 줄 자체를 그 종류의 몫으로 본다 */
export interface SavedPayroll {
  employee_id: string
  statement_kind: string | null
  statement_file: string | null
  base_salary: number
  base_income_tax: number
  base_local_tax: number
  incentive_income_tax: number
  incentive_local_tax: number
  other_deductions: number
  employer_insurance: number
  net_pay: number
}

export function partFromSaved(p: SavedPayroll, incentive: number): { kind: StatementKind; part: StatementPart } | null {
  if (p.statement_kind !== 'business' && p.statement_kind !== 'insured') return null
  return {
    kind: p.statement_kind,
    part: {
      rawName: '', file: p.statement_file ?? '',
      base: Number(p.base_salary), incentive,
      baseIncomeTax: Number(p.base_income_tax), baseLocalTax: Number(p.base_local_tax),
      incentiveIncomeTax: Number(p.incentive_income_tax), incentiveLocalTax: Number(p.incentive_local_tax),
      otherDeductions: Number(p.other_deductions), employerInsurance: Number(p.employer_insurance),
      net: Number(p.net_pay),
    },
  }
}

/**
 * 명세서 하나를 반영한 뒤의 명세서별 금액. 원본은 바꾸지 않는다.
 *   rows     이번 파일에 있는 직원 → 이 종류의 몫을 이번 금액으로 바꾼다
 *   dropped  이 종류의 이전 명세서에는 있었지만 이번 파일에 없는 직원 → 이 종류의 몫만 뺀다
 */
export function applyStatement(
  parts: StatementParts, kind: StatementKind, file: string,
  rows: (StatementRow & { employeeId: string })[], dropped: string[],
): StatementParts {
  const next: StatementParts = Object.fromEntries(Object.entries(parts).map(([id, p]) => [id, { ...p }]))
  for (const id of dropped) {
    if (!next[id]) continue
    delete next[id][kind]
    if (Object.keys(next[id]).length === 0) delete next[id]
  }
  for (const { employeeId, ...r } of rows) next[employeeId] = { ...next[employeeId], [kind]: { ...r, file } }
  return next
}

/** 명세서별 금액에서 이 종류에 든 직원 */
export const employeesOfKind = (parts: StatementParts, kind: StatementKind) =>
  Object.entries(parts).filter(([, p]) => p[kind]).map(([id]) => id)
