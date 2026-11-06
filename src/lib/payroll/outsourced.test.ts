import assert from 'node:assert/strict'
import test from 'node:test'
import { settleMonth } from '../ledger/settle'
import { findOutsourced } from './outsourced'
import type { StatementRow } from './statement'

const row = (rawName: string, net: number): StatementRow => ({
  rawName, net, base: net, incentive: 0, baseIncomeTax: 0, baseLocalTax: 0,
  incentiveIncomeTax: 0, incentiveLocalTax: 0, otherDeductions: 0, employerInsurance: 0,
})

test('같은 이름·금액의 비용 이체가 있어야 외주로 본다', () => {
  const found = findOutsourced(
    [row('KIMHANA', 1_117_440), row('박둘', 96_700), row('최셋', 500_000), row('정넷', 300_000)],
    [
      { counterparty: 'KIM　HA　NA', withdrawal: 1_117_430, category: 'exec_cost' }, // 절사 10원 차이
      { counterparty: '박둘', withdrawal: 96_700, category: 'production' },
      { counterparty: '최셋', withdrawal: 500_000, category: 'payroll_pay' }, // 급여 이체는 외주가 아니다
      { counterparty: '정넷', withdrawal: 200_000, category: 'exec_cost' }, // 금액이 다르면 다른 건이다
    ],
  )
  assert.deepEqual([...found], [['KIMHANA', 'exec_cost'], ['박둘', 'production']])
})

test('외주 원천세는 이체가 들어간 비용 줄에 더한다', () => {
  const r = settleMonth({
    year: 2026, month: 10, bank: [], card: [], insuranceForMonth: [], payroll: [],
    outsourcedTax: [{ category: 'exec_cost', amount: 3_300 }, { category: 'production', amount: 1_000 }],
    incentiveTotal: 0, gongguMargin: 0, gongguGrossSales: 0, cardFxRate: 1400,
    settings: { vat_rate: 0.1, corporate_tax_reserve: 0, retained_earnings_reserve: 0 },
    representativeRatio: 0.5,
  })
  assert.equal(r.total_product_cost, 3_300)
  assert.equal(r.total_variable_cost, 1_000)
  assert.equal(r.operating_profit, -4_300)
  assert.equal(r.breakdown.outsourcedTax.product_cost, 3_300)
})
