/**
 * 월 마감 서버 로직 — 업로드 반영, 결제 자동 매칭, 통장 기준 정산 계산
 * (API 라우트에서만 호출. service role 클라이언트를 받는다)
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { computeAutoIncentives } from '@/lib/calculations/incentives'
import { categoryOf } from './categories'
import { classifyBankTx, EMPTY_ACCOUNTS, type ClassifyContext, type LedgerAccounts } from './classify'
import { matchPayments } from './match'
import { checkBalanceChain, type ParsedBankTx, type ParsedCardTx } from './parse'
import { settleMonth, type SettleResult } from './settle'

type DB = SupabaseClient<Database>

const monthRange = (year: number, month: number) => {
  const mm = String(month).padStart(2, '0')
  const last = new Date(year, month, 0).getDate()
  return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${String(last).padStart(2, '0')}` }
}

export const DEFAULT_CARD_FX = 1400
export const DEFAULT_CHECK_CARDS = ['4935']

async function setting<T>(db: DB, key: string, fallback: T): Promise<T> {
  const { data } = await db.from('settings').select('value').eq('key', key).maybeSingle()
  return (data?.value as T | undefined) ?? fallback
}

export async function loadClassifyContext(db: DB): Promise<ClassifyContext> {
  const [{ data: rules }, { data: emps }] = await Promise.all([
    db.from('classification_rules').select('counterparty, memo_contains, direction, category, priority').eq('active', true),
    db.from('employees').select('name, bank_name'),
  ])
  const staffNames = new Set<string>()
  for (const e of emps ?? []) {
    staffNames.add(e.name)
    if (e.bank_name) staffNames.add(e.bank_name)
  }
  const accounts = await setting<LedgerAccounts>(db, 'ledger_accounts', EMPTY_ACCOUNTS)
  return { rules: rules ?? [], staffNames, accounts: { ...EMPTY_ACCOUNTS, ...accounts } }
}

// ─────────────────────────────────────────────────────────────
// 업로드
// ─────────────────────────────────────────────────────────────
export async function importBank(db: DB, rows: ParsedBankTx[], filename: string) {
  const breaks = checkBalanceChain(rows)
  const hashes = rows.map((r) => r.row_hash)
  const existing = new Set<string>()
  for (let i = 0; i < hashes.length; i += 300) {
    const { data } = await db.from('bank_transactions').select('row_hash').in('row_hash', hashes.slice(i, i + 300))
    for (const r of data ?? []) existing.add(r.row_hash)
  }
  const fresh = rows.filter((r) => !existing.has(r.row_hash))

  const { data: imp, error: impErr } = await db.from('statement_imports').insert({
    kind: 'bank', filename,
    period_start: rows[0]?.tx_date ?? null, period_end: rows.at(-1)?.tx_date ?? null,
    total_rows: rows.length, inserted: fresh.length, skipped: rows.length - fresh.length,
  }).select('id').single()
  if (impErr) throw new Error(`업로드 기록 실패: ${impErr.message}`)

  const ctx = await loadClassifyContext(db)
  const toInsert = fresh.map((r) => {
    const c = r.cancelled
      ? { category: 'unclassified', classified_by: 'rule' as const, attribution_month: null, note: '은행 취소 거래 — 정산 제외' }
      : classifyBankTx(r, ctx)
    return { ...r, ...c, import_id: imp.id }
  })
  for (let i = 0; i < toInsert.length; i += 500) {
    const { error } = await db.from('bank_transactions').insert(toInsert.slice(i, i + 500))
    if (error) throw new Error(`통장 거래 저장 실패: ${error.message}`)
  }

  // 새 거래 앞뒤로 기존 거래와 잔액이 이어지는지 (월을 나눠 올려도 끊기지 않았는지)
  const joinBreaks: string[] = []
  if (fresh.length) {
    const { data: before } = await db.from('bank_transactions').select('tx_at, balance, deposit, withdrawal')
      .lt('seq', fresh[0].seq).order('seq', { ascending: false }).limit(1)
    const b = before?.[0]
    if (b && b.balance + fresh[0].deposit - fresh[0].withdrawal !== fresh[0].balance) {
      joinBreaks.push(`${fresh[0].tx_at.slice(0, 16)} 앞에서 잔액이 끊깁니다 (이전 잔액 ${b.balance.toLocaleString()} → 이번 ${fresh[0].balance.toLocaleString()}). 사이 기간 거래내역이 빠졌을 수 있어요`)
    }
  }

  const matched = await autoMatchPayments(db)
  return {
    total: rows.length, inserted: fresh.length, skipped: rows.length - fresh.length,
    balanceBreaks: breaks.length, joinBreaks,
    period: { start: rows[0]?.tx_date, end: rows.at(-1)?.tx_date },
    ...matched,
  }
}

export async function importCard(db: DB, rows: ParsedCardTx[], filename: string) {
  const checkCards = await setting<string[]>(db, 'check_card_last4', DEFAULT_CHECK_CARDS)
  const hashes = rows.map((r) => r.row_hash)
  const existing = new Set<string>()
  for (let i = 0; i < hashes.length; i += 300) {
    const { data } = await db.from('card_transactions').select('row_hash').in('row_hash', hashes.slice(i, i + 300))
    for (const r of data ?? []) existing.add(r.row_hash)
  }
  const fresh = rows.filter((r) => !existing.has(r.row_hash))
  const dates = rows.map((r) => r.approved_date).sort()
  const { data: imp, error: impErr } = await db.from('statement_imports').insert({
    kind: 'card', filename, period_start: dates[0] ?? null, period_end: dates.at(-1) ?? null,
    total_rows: rows.length, inserted: fresh.length, skipped: rows.length - fresh.length,
  }).select('id').single()
  if (impErr) throw new Error(`업로드 기록 실패: ${impErr.message}`)
  const toInsert = fresh.map((r) => ({ ...r, is_check_card: checkCards.includes(r.card_last4), import_id: imp.id }))
  for (let i = 0; i < toInsert.length; i += 500) {
    const { error } = await db.from('card_transactions').insert(toInsert.slice(i, i + 500))
    if (error) throw new Error(`카드 거래 저장 실패: ${error.message}`)
  }
  return { total: rows.length, inserted: fresh.length, skipped: rows.length - fresh.length, period: { start: dates[0], end: dates.at(-1) } }
}

// ─────────────────────────────────────────────────────────────
// 결제 자동 매칭 — 매출 입금·환불 중 아직 결제와 연결 안 된 것
//   · 확정 결제와 맞으면 연결만
//   · 수금 예정(잔금처리요망·미입금) 결제와 맞으면 입금일로 확정 처리 (시트 동기화는 확정 건을 덮어쓰지 않는다)
// ─────────────────────────────────────────────────────────────
export async function autoMatchPayments(db: DB) {
  const { data: bank } = await db.from('bank_transactions')
    .select('id, tx_date, counterparty, memo, deposit, withdrawal, category')
    .in('category', ['revenue', 'refund']).is('payment_id', null).eq('cancelled', false)
  if (!bank?.length) return { matchedPayments: 0, confirmedPending: 0 }

  const minDate = bank.map((b) => b.tx_date).sort()[0]
  const from = new Date(Date.parse(minDate) - 60 * 86_400_000).toISOString().slice(0, 10)
  const { data: pays } = await db.from('payments')
    .select('id, payment_date, amount, status, client_name_raw, memo, project_id, excluded, projects(name)')
    .gte('payment_date', from)
  const { data: linkedRows } = await db.from('bank_transactions').select('payment_id').not('payment_id', 'is', null)
  const linked = new Set((linkedRows ?? []).map((r) => r.payment_id as string))

  const payments = (pays ?? []).filter((p) => !p.excluded).map((p) => ({
    ...p, project_name: (p.projects as unknown as { name: string } | null)?.name ?? null,
  }))
  const results = matchPayments(bank, payments, linked)
  let confirmedPending = 0
  for (const m of results) {
    const p = payments.find((x) => x.id === m.paymentId)!
    const b = bank.find((x) => x.id === m.bankId)!
    if (m.confirms) {
      const { error } = await db.rpc('confirm_pending_payment', {
        p_payment_id: p.id, p_amount: p.amount, p_payment_date: b.tx_date, p_project_id: p.project_id,
      })
      if (error) continue
      confirmedPending++
    }
    await db.from('bank_transactions').update({ payment_id: p.id }).eq('id', b.id)
  }
  return { matchedPayments: results.length, confirmedPending }
}

// ─────────────────────────────────────────────────────────────
// 통장 기준 정산
// ─────────────────────────────────────────────────────────────
export async function hasBankData(db: DB, year: number, month: number) {
  const { start, end } = monthRange(year, month)
  const { count } = await db.from('bank_transactions').select('id', { count: 'exact', head: true })
    .gte('tx_date', start).lte('tx_date', end)
  return (count ?? 0) > 0
}

export interface ClosingChecks {
  bankRows: number
  lastBankDate: string | null
  /** 통장 내역이 월말까지 다 들어왔는지 (마지막 거래일이 다음 달 이후거나, 월말 이후 업로드) */
  monthComplete: boolean
  cardRows: number
  lastCardDate: string | null
  unclassified: number
  unmatchedRevenue: { id: string; tx_date: string; counterparty: string; memo: string; amount: number }[]
  payroll: { total: number; confirmed: number; draft: number }
  employerInsuranceEstimated: boolean
  balanceBreaks: number
}

export async function computeBankSettlement(db: DB, year: number, month: number, fxOverride?: number) {
  const { start, end } = monthRange(year, month)
  const ym = start.slice(0, 7)

  const [bankRes, prevRes, cardRes, insRes, payrollRes, gongguRes, settingsRes, repsRes, manualIncRes, paysRes, cancelledRes, lastBank, lastCard] = await Promise.all([
    db.from('bank_transactions').select('*').gte('tx_date', start).lte('tx_date', end).order('seq'),
    db.from('bank_transactions').select('*').lt('tx_date', start).order('seq', { ascending: false }).limit(1),
    db.from('card_transactions').select('*').gte('approved_date', start).lte('approved_date', end),
    db.from('bank_transactions').select('counterparty, withdrawal, deposit').eq('category', 'insurance').eq('attribution_month', start).eq('cancelled', false),
    db.from('monthly_payroll').select('base_salary, employer_insurance, status').eq('year', year).eq('month', month),
    db.from('gonggu_sales').select('gross_sales, margin').eq('year', year).eq('month', month),
    db.from('settings').select('*'),
    db.from('representatives').select('share_ratio').order('created_at').limit(1),
    db.from('monthly_incentives').select('*').eq('year', year).eq('month', month),
    db.from('payments').select('amount, manager, status, excluded, project_id').gte('payment_date', start).lte('payment_date', end),
    db.from('projects').select('id').eq('status', 'cancelled'),
    db.from('bank_transactions').select('tx_date').order('seq', { ascending: false }).limit(1),
    db.from('card_transactions').select('approved_date').order('approved_date', { ascending: false }).limit(1),
  ])

  const settings = Object.fromEntries((settingsRes.data ?? []).map((s) => [s.key, s.value])) as Record<string, unknown>
  const vatRate = Number(settings.vat_rate ?? 0.1)
  const fx = fxOverride ?? Number(settings.card_fx_usd_krw ?? DEFAULT_CARD_FX)

  // 인센티브 — 수동 입력 우선, 없으면 담당 확정 결제 기준 자동 계산 (이전 방식과 동일)
  const cancelled = new Set((cancelledRes.data ?? []).map((p) => p.id))
  const confirmedPays = (paysRes.data ?? []).filter((p) => p.status === 'confirmed' && !p.excluded && !(p.project_id && cancelled.has(p.project_id)))
  const { data: employees } = await db.from('employees').select('id, name, incentive_type, incentive_value')
    .or(`hired_at.is.null,hired_at.lte.${end}`).or(`active.eq.true,terminated_at.gte.${start}`)
  const manual = manualIncRes.data ?? []
  const manualIds = new Set(manual.map((i) => i.employee_id))
  const auto = computeAutoIncentives(employees ?? [], confirmedPays, vatRate, year, month, 'auto').filter((i) => !manualIds.has(i.employee_id))
  const incentiveTotal = Math.round([...auto, ...manual].reduce((s, i) => s + Number(i.amount), 0))

  const insuranceForMonth = (insRes.data ?? []).map((r) => ({
    kind: /국민건강|국민연금|고용보험|산재보험/.exec(r.counterparty)?.[0] ?? '',
    amount: r.withdrawal - r.deposit,
  }))

  const result: SettleResult = settleMonth({
    year, month,
    bank: [...(prevRes.data ?? []), ...(bankRes.data ?? [])],
    card: cardRes.data ?? [],
    insuranceForMonth,
    payroll: (payrollRes.data ?? []).map((p) => ({ base_salary: Number(p.base_salary), employer_insurance: Number(p.employer_insurance ?? 0) })),
    incentiveTotal,
    gongguMargin: (gongguRes.data ?? []).reduce((s, r) => s + Number(r.margin), 0),
    gongguGrossSales: (gongguRes.data ?? []).reduce((s, r) => s + Number(r.gross_sales), 0),
    cardFxRate: fx,
    settings: {
      vat_rate: vatRate,
      corporate_tax_reserve: Number(settings.corporate_tax_reserve ?? 0.1),
      retained_earnings_reserve: Number(settings.retained_earnings_reserve ?? 0),
    },
    representativeRatio: (repsRes.data?.[0]?.share_ratio ?? 50) / 100,
  })

  const bankRows = bankRes.data ?? []
  const lastBankDate = lastBank.data?.[0]?.tx_date ?? null
  const payroll = payrollRes.data ?? []
  const checks: ClosingChecks = {
    bankRows: bankRows.length,
    lastBankDate,
    monthComplete: !!lastBankDate && lastBankDate >= end,
    cardRows: (cardRes.data ?? []).length,
    lastCardDate: lastCard.data?.[0]?.approved_date ?? null,
    unclassified: result.breakdown.unclassified,
    unmatchedRevenue: bankRows
      .filter((r) => !r.cancelled && categoryOf(r.category).cls === 'revenue' && !r.payment_id)
      .map((r) => ({ id: r.id, tx_date: r.tx_date, counterparty: r.counterparty, memo: r.memo, amount: r.deposit - r.withdrawal })),
    payroll: {
      total: payroll.length,
      confirmed: payroll.filter((p) => p.status === 'confirmed' || p.status === 'paid').length,
      draft: payroll.filter((p) => p.status === 'draft' || p.status === 'submitted').length,
    },
    employerInsuranceEstimated: result.breakdown.employerInsuranceEstimated,
    balanceBreaks: result.breakdown.balanceBreaks,
  }
  return { result, checks, ym }
}

export async function saveBankSettlement(db: DB, year: number, month: number, result: SettleResult) {
  const { breakdown, ...cols } = result
  const { error } = await db.from('monthly_settlements').upsert({
    year, month, ...cols, breakdown: breakdown as unknown as Database['public']['Tables']['monthly_settlements']['Insert']['breakdown'],
    basis: 'bank', calculated_at: new Date().toISOString(),
  }, { onConflict: 'year,month' })
  if (error) throw new Error(error.message)
}

