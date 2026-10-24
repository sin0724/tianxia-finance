/**
 * 통장·카드 기준 월 정산 (순수 함수 — DB 조회는 호출하는 쪽에서)
 *
 *   총매출(VAT 포함)   = 통장 매출 입금 − 환불 출금
 *   공급가액           = 총매출 ÷ 1.1
 *   실행비             = 통장 실행비·대만 실행팀 출금
 *   고정비·변동비·특수 = 통장 비용 출금(분류의 line) + 카드 승인(변동비, 해외는 환율 환산)
 *   급여               = 세무사 대장 기준 세전 급여 (monthly_payroll.base_salary) — 통장 급여·원천세 이체는 현금 이동일 뿐
 *   4대보험 회사부담   = 급여 화면 입력값, 없으면 통장 4대보험 납부액에서 회사부담 비율로 추정
 *   손익 외            = 대출·배당·보증금·가수금·대납·부가세 — 이익과 무관, 현금 표에만 표시
 *
 * 금액은 전부 원 단위 정수. 공급가·적립금처럼 나눗셈이 들어가는 곳만 Decimal 로 계산 후 정수로 내린다.
 */
import Decimal from 'decimal.js'
import { categoryOf, type SettleLine } from './categories'

export interface SettleBankRow {
  tx_date: string
  category: string
  attribution_month: string | null
  withdrawal: number
  deposit: number
  balance: number
  cancelled: boolean
  seq: number
}

export interface SettleCardRow {
  approved_date: string
  amount_krw: number | null
  amount_foreign: number | null
  vat: number
  excluded: boolean
  is_check_card: boolean
}

export interface SettleInput {
  year: number
  month: number
  /** 이 달 거래 + 전 달 마지막 거래 1건(월초 잔액용)이 있으면 좋다. 없으면 첫 거래로 역산 */
  bank: SettleBankRow[]
  card: SettleCardRow[]
  /** 이 달 귀속 4대보험 납부 (다음 달 10일경 지로 출금) — 귀속월 기준으로 모아 넘긴다 */
  insuranceForMonth: { kind: string; amount: number }[]
  payroll: { base_salary: number; employer_insurance: number }[]
  incentiveTotal: number
  gongguMargin: number
  gongguGrossSales: number
  cardFxRate: number
  settings: { vat_rate: number; corporate_tax_reserve: number; retained_earnings_reserve: number }
  representativeRatio: number
}

export interface SettleResult {
  total_revenue: number
  supply_value: number
  total_incentive: number
  total_product_cost: number
  gross_profit: number
  total_fixed_cost: number
  total_variable_cost: number
  total_special_cost: number
  total_payroll: number
  total_employer_insurance: number
  gonggu_gross_sales: number
  gonggu_margin: number
  operating_profit: number
  corporate_tax_reserve: number
  retained_earnings: number
  distributable_profit: number
  representative_share: number
  cash_opening: number
  cash_closing: number
  cash_in: number
  cash_out: number
  non_pl_in: number
  non_pl_out: number
  card_fx_rate: number
  breakdown: SettleBreakdown
}

export interface SettleBreakdown {
  byCategory: Record<string, { in: number; out: number; count: number }>
  card: { krw: number; foreign: number; foreignKrw: number; vat: number; count: number; excluded: number }
  employerInsuranceEstimated: boolean
  unclassified: number
  balanceBreaks: number
}

// 4대보험 회사부담 비율 (납부액 중 회사 몫) — 연금·건강 반반, 고용은 회사가 조금 더(실업급여 0.9% + 고용안정 0.25%), 산재는 전액 회사
const EMPLOYER_SHARE: Record<string, number> = { 국민연금: 0.5, 국민건강: 0.5, 고용보험: 0.56, 산재보험: 1 }

const monthKey = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`

export function settleMonth(input: SettleInput): SettleResult {
  const ym = monthKey(input.year, input.month)
  const rows = [...input.bank].sort((a, b) => a.seq - b.seq)
  const inMonth = rows.filter((r) => r.tx_date.startsWith(ym))

  // ── 현금 ─────────────────────────────────────────────────
  const prev = rows.filter((r) => r.tx_date < `${ym}-01`).at(-1)
  const first = inMonth[0]
  const cash_opening = prev ? prev.balance : first ? first.balance - first.deposit + first.withdrawal : 0
  const cash_closing = inMonth.at(-1)?.balance ?? cash_opening
  let balanceBreaks = 0
  let running = cash_opening
  for (const r of inMonth) {
    running += r.deposit - r.withdrawal
    if (running !== r.balance) { balanceBreaks++; running = r.balance }
  }

  const live = inMonth.filter((r) => !r.cancelled)
  const byCategory: SettleBreakdown['byCategory'] = {}
  for (const r of live) {
    const c = (byCategory[r.category] ??= { in: 0, out: 0, count: 0 })
    c.in += r.deposit
    c.out += r.withdrawal
    c.count++
  }

  let revenue = 0
  let non_pl_in = 0
  let non_pl_out = 0
  let unclassified = 0
  const line: Record<SettleLine, number> = { product_cost: 0, fixed: 0, variable: 0, special: 0 }
  for (const r of live) {
    const def = categoryOf(r.category)
    if (def.cls === 'revenue') revenue += r.deposit - r.withdrawal
    else if (def.cls === 'expense' && def.line) line[def.line] += r.withdrawal - r.deposit
    else if (def.cls === 'non_pl') { non_pl_in += r.deposit; non_pl_out += r.withdrawal }
    else if (def.cls === 'unclassified') unclassified++
  }

  // ── 카드 (승인 기준, 해외는 환율 환산) ────────────────────
  const cards = input.card.filter((c) => c.approved_date.startsWith(ym))
  const cardKrw = cards.filter((c) => !c.excluded).reduce((s, c) => s + (c.amount_krw ?? 0), 0)
  const foreign = cards.filter((c) => !c.excluded).reduce((s, c) => s.plus(c.amount_foreign ?? 0), new Decimal(0))
  const foreignKrw = foreign.times(input.cardFxRate).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber()
  const excludedKrw = cards.filter((c) => c.excluded).reduce((s, c) => s + (c.amount_krw ?? 0), 0)
  line.variable += cardKrw + foreignKrw

  // ── 인건비 ───────────────────────────────────────────────
  const total_payroll = input.payroll.reduce((s, p) => s + p.base_salary, 0)
  const enteredInsurance = input.payroll.reduce((s, p) => s + (p.employer_insurance ?? 0), 0)
  const estimatedInsurance = input.insuranceForMonth.reduce(
    (s, i) => s.plus(new Decimal(i.amount).times(EMPLOYER_SHARE[i.kind] ?? 0.5)), new Decimal(0),
  ).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber()
  const employerInsuranceEstimated = enteredInsurance === 0 && estimatedInsurance > 0
  const total_employer_insurance = enteredInsurance > 0 ? enteredInsurance : estimatedInsurance

  // ── 손익 ─────────────────────────────────────────────────
  const vat = new Decimal(input.settings.vat_rate)
  const supply_value = new Decimal(revenue).dividedBy(vat.plus(1)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber()
  const gross_profit = supply_value - input.incentiveTotal - line.product_cost
  const operating_profit = gross_profit - line.fixed - line.variable - line.special
    - total_payroll - total_employer_insurance + input.gongguMargin
  const base = Math.max(operating_profit, 0)
  const corporate_tax_reserve = new Decimal(base).times(input.settings.corporate_tax_reserve).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber()
  const retained_earnings = new Decimal(base).times(input.settings.retained_earnings_reserve).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber()
  const distributable_profit = operating_profit - corporate_tax_reserve - retained_earnings

  return {
    total_revenue: revenue,
    supply_value,
    total_incentive: input.incentiveTotal,
    total_product_cost: line.product_cost,
    gross_profit,
    total_fixed_cost: line.fixed,
    total_variable_cost: line.variable,
    total_special_cost: line.special,
    total_payroll,
    total_employer_insurance,
    gonggu_gross_sales: input.gongguGrossSales,
    gonggu_margin: input.gongguMargin,
    operating_profit,
    corporate_tax_reserve,
    retained_earnings,
    distributable_profit,
    representative_share: Math.floor(distributable_profit * input.representativeRatio),
    cash_opening,
    cash_closing,
    cash_in: live.reduce((s, r) => s + r.deposit, 0),
    cash_out: live.reduce((s, r) => s + r.withdrawal, 0),
    non_pl_in,
    non_pl_out,
    card_fx_rate: input.cardFxRate,
    breakdown: {
      byCategory,
      card: { krw: cardKrw, foreign: foreign.toNumber(), foreignKrw, vat: cards.reduce((s, c) => s + c.vat, 0), count: cards.length, excluded: excludedKrw },
      employerInsuranceEstimated,
      unclassified,
      balanceBreaks,
    },
  }
}
