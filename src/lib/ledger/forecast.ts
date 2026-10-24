/**
 * 현금 흐름 예측 — 최신 통장 잔액에서 출발해 앞으로 3개월
 *
 *   + 미수금 (결제 내역의 잔금처리요망·미입금) — 결제일 월에 들어온다고 본다. 이미 지난 건은 이번 달 "지연"
 *   − 반복 지출 — 최근 마감 3개월 통장 실적 평균 (급여·4대보험·원천세 / 카드대금 / 고정비 / 실행비 / 기타)
 *   − 부가세 — 신고 기간 매출 ÷ 11 − 카드 매입 부가세 를 납부월(1·4·7·10월 25일)에 뺀다 (추정)
 *
 * "쓸 수 있는 돈" = 잔액 − 부가세 적립 추정 − 법인세 적립(올해 정산 누계)
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { categoryOf } from './categories'

type DB = SupabaseClient<Database>

export interface ForecastMonth {
  ym: string
  opening: number
  receivables: number
  overdue: number
  payroll: number
  card: number
  fixed: number
  productCost: number
  otherExpense: number
  vat: number
  closing: number
}

export interface Forecast {
  asOf: string | null
  balance: number
  vatReserve: number
  vatPeriod: { start: string; end: string; due: string }
  corporateTaxReserve: number
  available: number
  basisMonths: string[]
  averages: { payroll: number; card: number; fixed: number; productCost: number; otherExpense: number }
  months: ForecastMonth[]
  receivablesList: { id: string; payment_date: string; client: string | null; amount: number; status: string; overdue: boolean }[]
}

const ymOf = (d: string) => d.slice(0, 7)
const addMonths = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** 부가세 신고 기간 — 1기 예정(1~3, 4/25), 1기 확정(4~6, 7/25), 2기 예정(7~9, 10/25), 2기 확정(10~12, 다음 해 1/25) */
function vatPeriodOf(ym: string) {
  const [y, m] = ym.split('-').map(Number)
  const q = Math.floor((m - 1) / 3)
  const start = `${y}-${String(q * 3 + 1).padStart(2, '0')}`
  const end = `${y}-${String(q * 3 + 3).padStart(2, '0')}`
  return { start, end, due: addMonths(end, 1) }
}

function bucket(category: string): keyof ForecastMonth | null {
  const def = categoryOf(category)
  if (def.cls === 'payroll_cash') return 'payroll'
  if (def.cls === 'card') return 'card'
  if (def.cls === 'expense') {
    if (def.line === 'fixed') return 'fixed'
    if (def.line === 'product_cost') return 'productCost'
    return 'otherExpense'
  }
  return null // 매출·손익 외는 반복 지출로 보지 않는다
}

export async function buildForecast(db: DB, horizon = 3): Promise<Forecast> {
  const { data: last } = await db.from('bank_transactions').select('tx_date, balance').order('seq', { ascending: false }).limit(1)
  const asOf = last?.[0]?.tx_date ?? null
  const balance = Number(last?.[0]?.balance ?? 0)
  const nowYm = asOf ? ymOf(asOf) : new Date().toISOString().slice(0, 7)

  // 최근 마감 3개월 = 잔액 기준일이 속한 달 직전 3개월 (이번 달은 아직 진행 중)
  const basisMonths = [3, 2, 1].map((n) => addMonths(nowYm, -n))
  const { data: hist } = await db.from('bank_transactions').select('tx_date, category, withdrawal, deposit, cancelled')
    .gte('tx_date', `${basisMonths[0]}-01`).lt('tx_date', `${nowYm}-01`).eq('cancelled', false)
  const sums = { payroll: 0, card: 0, fixed: 0, productCost: 0, otherExpense: 0 }
  const monthsWithData = new Set<string>()
  for (const r of hist ?? []) {
    monthsWithData.add(ymOf(r.tx_date))
    const b = bucket(r.category) as keyof typeof sums | null
    if (b && b in sums) sums[b] += r.withdrawal - r.deposit
  }
  const n = Math.max(monthsWithData.size, 1)
  const averages = Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, Math.round(v / n)])) as Forecast['averages']

  // 이번 달에 이미 나간 반복 지출은 이번 달 예측에서 뺀다
  const { data: cur } = await db.from('bank_transactions').select('category, withdrawal, deposit')
    .gte('tx_date', `${nowYm}-01`).eq('cancelled', false)
  const spentThisMonth = { payroll: 0, card: 0, fixed: 0, productCost: 0, otherExpense: 0 }
  for (const r of cur ?? []) {
    const b = bucket(r.category) as keyof typeof spentThisMonth | null
    if (b && b in spentThisMonth) spentThisMonth[b] += r.withdrawal - r.deposit
  }

  // 미수금
  const { data: pend } = await db.from('payments').select('id, payment_date, client_name_raw, amount, status, excluded, projects(status)')
    .in('status', ['balance_due', 'unpaid'])
  const receivablesList = (pend ?? [])
    .filter((p) => !p.excluded && (p.projects as unknown as { status: string } | null)?.status !== 'cancelled')
    .map((p) => ({ id: p.id, payment_date: p.payment_date, client: p.client_name_raw, amount: Number(p.amount), status: p.status, overdue: ymOf(p.payment_date) < nowYm }))
    .sort((a, b) => a.payment_date.localeCompare(b.payment_date))

  // 부가세 — 현재 신고 기간 매출 VAT − 카드 매입 VAT
  const period = vatPeriodOf(nowYm)
  const { data: revRows } = await db.from('bank_transactions').select('category, deposit, withdrawal')
    .gte('tx_date', `${period.start}-01`).in('category', ['revenue', 'refund']).eq('cancelled', false)
  const { data: cardVat } = await db.from('card_transactions').select('vat, excluded').gte('approved_date', `${period.start}-01`)
  const revenue = (revRows ?? []).reduce((s, r) => s + r.deposit - r.withdrawal, 0)
  const vatReserve = Math.max(Math.round(revenue / 11) - (cardVat ?? []).filter((c) => !c.excluded).reduce((s, c) => s + Number(c.vat), 0), 0)

  // 법인세 적립 — 올해 저장된 정산 누계
  const { data: sets } = await db.from('monthly_settlements').select('corporate_tax_reserve').eq('year', Number(nowYm.slice(0, 4)))
  const corporateTaxReserve = Math.round((sets ?? []).reduce((s, r) => s + Number(r.corporate_tax_reserve ?? 0), 0))

  const months: ForecastMonth[] = []
  let opening = balance
  for (let i = 0; i < horizon; i++) {
    const ym = addMonths(nowYm, i)
    const due = receivablesList.filter((p) => (i === 0 ? ymOf(p.payment_date) <= ym : ymOf(p.payment_date) === ym))
    const receivables = due.reduce((s, p) => s + p.amount, 0)
    const overdue = due.filter((p) => p.overdue).reduce((s, p) => s + p.amount, 0)
    const out = (k: keyof typeof averages) => Math.max(averages[k] - (i === 0 ? spentThisMonth[k] : 0), 0)
    const vat = ym === period.due ? vatReserve : 0
    const m: ForecastMonth = {
      ym, opening, receivables, overdue,
      payroll: out('payroll'), card: out('card'), fixed: out('fixed'), productCost: out('productCost'), otherExpense: out('otherExpense'),
      vat, closing: 0,
    }
    m.closing = opening + receivables - m.payroll - m.card - m.fixed - m.productCost - m.otherExpense - vat
    months.push(m)
    opening = m.closing
  }

  return {
    asOf, balance, vatReserve, vatPeriod: { start: period.start, end: period.end, due: period.due },
    corporateTaxReserve, available: balance - vatReserve - corporateTaxReserve,
    basisMonths: [...monthsWithData].sort(), averages, months, receivablesList,
  }
}
