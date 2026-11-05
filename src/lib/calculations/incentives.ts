/**
 * 인센티브 — 2026년 10월부터는 세무사 대장의 최종 금액(monthly_incentives)만 쓴다.
 * 캠페인별로 금액이 달라 앱에서 비율로 계산할 수 없기 때문이다.
 *
 * 그 이전 달은 저장된 정산·급여 화면이 바뀌지 않도록 자동 계산을 유지한다:
 * 담당 확정 결제의 공급가 × 비율(percent) 또는 고정액(fixed).
 * 그 달 수동 인센티브가 있는 직원은 호출하는 쪽에서 수동값을 우선한다.
 */
export type EmployeeRow = { id: string; name: string; incentive_type: string | null; incentive_value: number }
export type PaymentRow = { manager?: string | null; amount: number }

export const isLedgerIncentiveMonth = (year: number, month: number) => year * 100 + month >= 202610

export function computeAutoIncentives(
  employees: EmployeeRow[],
  payments: PaymentRow[],
  vatRate: number,
  year: number,
  month: number,
  prefix: string
) {
  if (isLedgerIncentiveMonth(year, month)) return []
  return employees
    .filter((e) => e.incentive_type && e.incentive_value > 0)
    .map((e) => {
      const myPayments = payments.filter(
        (p) => p.manager?.trim().toLowerCase() === e.name.trim().toLowerCase()
      )
      if (myPayments.length === 0) return null
      const myRevenue = myPayments.reduce((sum, p) => sum + p.amount, 0)
      const mySupplyValue = myRevenue / (1 + vatRate)
      const amount =
        e.incentive_type === 'percent'
          ? Math.round((mySupplyValue * e.incentive_value) / 100)
          : e.incentive_value
      return {
        id: `${prefix}_${e.id}`,
        year,
        month,
        employee_id: e.id,
        amount,
        basis: e.incentive_type === 'percent' ? mySupplyValue : null,
        memo: `담당계약 공급가액 ${Math.round(mySupplyValue).toLocaleString()}원 기준`,
        created_at: new Date().toISOString(),
      }
    })
    .filter((i): i is NonNullable<typeof i> => i !== null)
}
