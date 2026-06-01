import Decimal from 'decimal.js'
import type { Payment, MonthlyExpense, MonthlyIncentive, MonthlyPayroll } from '@/types/database'

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP })

interface ProjectItemForCalc {
  project_id: string
  quantity: number
  unit_cost_snapshot: number
}

interface SettlementInput {
  year: number
  month: number
  payments: Payment[]
  projectItems: ProjectItemForCalc[]
  expenses: (MonthlyExpense & { category_type?: string })[]
  incentives: MonthlyIncentive[]
  payroll: MonthlyPayroll[]
  settings: {
    vat_rate: number
    corporate_tax_reserve: number
    retained_earnings_reserve: number
  }
}

export interface SettlementResult {
  totalRevenue: number
  supplyValue: number
  totalIncentive: number
  totalProductCost: number
  grossProfit: number
  totalFixedCost: number
  totalVariableCost: number
  totalSpecialCost: number
  totalPayroll: number
  operatingProfit: number
  corporateTaxReserve: number
  retainedEarnings: number
  distributableProfit: number
  representativeShare: number
}

function sumByType(expenses: SettlementInput['expenses'], type: string): Decimal {
  return expenses
    .filter((e) => e.category_type === type)
    .reduce((sum, e) => sum.plus(e.amount), new Decimal(0))
}

function calculateProductCost(payments: Payment[], projectItems: ProjectItemForCalc[]): Decimal {
  const projectIds = new Set(payments.map((p) => p.project_id).filter(Boolean))
  return projectItems
    .filter((item) => item.project_id && projectIds.has(item.project_id))
    .reduce(
      (sum, item) => sum.plus(new Decimal(item.unit_cost_snapshot).times(item.quantity)),
      new Decimal(0)
    )
}

export function calculateMonthlySettlement(input: SettlementInput): SettlementResult {
  const vatRate = new Decimal(input.settings.vat_rate)
  const taxRate = new Decimal(input.settings.corporate_tax_reserve)
  const retainedRate = new Decimal(input.settings.retained_earnings_reserve)

  // 1. 총매출
  const totalRevenue = input.payments.reduce(
    (sum, p) => sum.plus(p.amount),
    new Decimal(0)
  )

  // 2. 공급가액 = 총매출 / 1.1
  const supplyValue = totalRevenue.dividedBy(new Decimal(1).plus(vatRate))

  // 3. 상품 실행비 (스냅샷 기준)
  const totalProductCost = calculateProductCost(input.payments, input.projectItems)

  // 4. 인센티브 합계 (월별급여에서 입력한 인센티브 공제액 반영)
  const grossIncentive = input.incentives.reduce(
    (sum, i) => sum.plus(i.amount),
    new Decimal(0)
  )
  const totalIncentiveDeductions = input.payroll.reduce(
    (sum, p) => sum.plus(p.incentive_deductions ?? 0),
    new Decimal(0)
  )
  const totalIncentive = grossIncentive.minus(totalIncentiveDeductions)

  // 5. 매출총이익
  const grossProfit = supplyValue.minus(totalIncentive).minus(totalProductCost)

  // 6. 지출 분류별 합계
  const totalFixedCost = sumByType(input.expenses, 'fixed')
  const totalVariableCost = sumByType(input.expenses, 'variable')
  const totalSpecialCost = sumByType(input.expenses, 'special')

  // 7. 급여 합계
  const totalPayroll = input.payroll.reduce(
    (sum, p) => sum.plus(p.base_salary),
    new Decimal(0)
  )

  // 8. 영업이익
  const operatingProfit = grossProfit
    .minus(totalFixedCost)
    .minus(totalVariableCost)
    .minus(totalSpecialCost)
    .minus(totalPayroll)

  // 9. 적립금 (영업이익이 음수면 0)
  const profitForReserve = Decimal.max(operatingProfit, 0)
  const corporateTaxReserve = profitForReserve.times(taxRate)
  const retainedEarnings = profitForReserve.times(retainedRate)

  // 10. 분배 가능 이익
  const distributableProfit = operatingProfit.minus(corporateTaxReserve).minus(retainedEarnings)

  // 11. 대표자 1인당 (50:50, 단수 처리)
  const representativeShare = distributableProfit.dividedBy(2).toDecimalPlaces(0, Decimal.ROUND_FLOOR)

  const round2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber()

  return {
    totalRevenue: round2(totalRevenue),
    supplyValue: round2(supplyValue),
    totalIncentive: round2(totalIncentive),
    totalProductCost: round2(totalProductCost),
    grossProfit: round2(grossProfit),
    totalFixedCost: round2(totalFixedCost),
    totalVariableCost: round2(totalVariableCost),
    totalSpecialCost: round2(totalSpecialCost),
    totalPayroll: round2(totalPayroll),
    operatingProfit: round2(operatingProfit),
    corporateTaxReserve: round2(corporateTaxReserve),
    retainedEarnings: round2(retainedEarnings),
    distributableProfit: round2(distributableProfit),
    representativeShare: representativeShare.toNumber(),
  }
}

export function formatKRW(amount: number): string {
  return new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW' }).format(amount)
}
