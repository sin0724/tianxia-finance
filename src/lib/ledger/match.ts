/**
 * 통장 매출 입금 ↔ 결제 내역(payments) 매칭
 *
 * 금액이 정확히 같고 날짜가 가까운 건을 찾는다. 같은 금액 후보가 여럿이면 거래처명 유사도로 고른다.
 * 통장 입금자명은 거래처명·대표자명·병원명 중 아무거나라 결제 메모의 "대표: ○○"까지 이름 후보로 본다.
 * 환불(출금)은 음수 결제와 매칭한다.
 */

export interface MatchBankRow {
  id: string
  tx_date: string
  counterparty: string
  memo: string
  deposit: number
  withdrawal: number
}

export interface MatchPayment {
  id: string
  payment_date: string
  amount: number
  status: 'confirmed' | 'balance_due' | 'unpaid'
  client_name_raw: string | null
  memo: string | null
  project_name?: string | null
}

export interface MatchResult {
  bankId: string
  paymentId: string
  /** 수금 예정 건이 입금으로 확인됨 → 확정 처리 대상 */
  confirms: boolean
  days: number
}

const NORM = /[\s()（）㈜.\-]|주식회사|^(카뱅|기업|하나|신한|농협|국민|우리)/g
const norm = (s: string) => s.replace(NORM, '').toLowerCase()

function bigrams(s: string) {
  const out = new Set<string>()
  for (let i = 0; i < Math.max(s.length - 1, 1); i++) out.add(s.slice(i, i + 2))
  return out
}

export function nameSimilarity(a: string, b: string): number {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return 0
  if (x.includes(y) || y.includes(x)) return 1
  const gx = bigrams(x)
  const gy = bigrams(y)
  let inter = 0
  for (const g of gx) if (gy.has(g)) inter++
  return inter / (gx.size + gy.size - inter)
}

function paymentNames(p: MatchPayment): string[] {
  const rep = /대표:\s*([^|\n]+)/.exec(p.memo ?? '')?.[1]?.trim()
  return [p.client_name_raw, p.project_name, rep].filter((n): n is string => !!n)
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000)

/** 카드 결제는 수수료를 뗀 금액이 PG 코드 이름으로 입금된다. 결제액의 90~100% 입금이면 수수료 차이로 본다 */
const isFeeDeducted = (deposit: number, paymentAmount: number) =>
  deposit > 0 && deposit < paymentAmount && deposit * 10 >= paymentAmount * 9

/**
 * 수금 예정 건을 입금 확정할 금액.
 * 수수료 차이면 계약금액 전체가 입금된 것이고, 그보다 적으면 부분 입금이라 잔여분이 수금 예정으로 남는다.
 */
export function pendingConfirmAmount(r: MatchBankRow, payment: MatchPayment) {
  if (r.deposit <= 0 || r.deposit >= payment.amount || isFeeDeducted(r.deposit, payment.amount)) return payment.amount
  return r.deposit
}

/**
 * 자동 매칭에서 빠진 입금에 손으로 연결할 결제 후보. 후보가 없으면 새로 등록해 중복이 생기므로 넓게 보여준다.
 *   · 기본: 금액 일치, 수수료 차이, 또는 이름이 비슷한 확정 결제
 *   · 검색어가 있으면 거래처·프로젝트·메모에 그 말이 들어간 결제 전부
 */
export function rankPaymentCandidates<P extends MatchPayment>(
  r: MatchBankRow, payments: P[], { query = '', limit = 10 }: { query?: string; limit?: number } = {},
) {
  const amount = r.deposit > 0 ? r.deposit : -r.withdrawal
  const who = `${r.counterparty} ${r.memo}`
  const q = norm(query)
  return payments
    .map((payment) => ({
      payment,
      exact: payment.amount === amount,
      feeDeducted: isFeeDeducted(r.deposit, payment.amount),
      sim: Math.max(0, ...paymentNames(payment).map((n) => nameSimilarity(who, n))),
      days: Math.abs(dayDiff(r.tx_date, payment.payment_date)),
    }))
    .filter((c) => q
      ? norm([...paymentNames(c.payment), c.payment.memo ?? ''].join(' ')).includes(q)
      : c.exact || c.feeDeducted || (c.sim >= 0.3 && c.payment.status === 'confirmed'))
    .sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.feeDeducted) - Number(a.feeDeducted) || b.sim - a.sim || a.days - b.days)
    .slice(0, limit)
}


/**
 * @param linked 이미 다른 통장 거래와 연결된 결제 id (중복 연결 방지)
 * 창(window)을 넓혀 가며 3회 — 가까운 날짜를 먼저 확정해야 같은 금액의 정기 결제가 엉키지 않는다
 */
export function matchPayments(bank: MatchBankRow[], payments: MatchPayment[], linked: Set<string>): MatchResult[] {
  const results: MatchResult[] = []
  const usedBank = new Set<string>()
  const usedPay = new Set(linked)
  const passes: { window: number; minName: number }[] = [
    { window: 3, minName: 0 },
    { window: 15, minName: 0 },
    { window: 45, minName: 0.3 },
  ]
  for (const { window, minName } of passes) {
    for (const r of bank) {
      if (usedBank.has(r.id)) continue
      const amount = r.deposit > 0 ? r.deposit : -r.withdrawal
      const who = `${r.counterparty} ${r.memo}`
      const cands = payments
        .filter((p) => !usedPay.has(p.id) && p.amount === amount && Math.abs(dayDiff(r.tx_date, p.payment_date)) <= window)
        .map((p) => ({ p, sim: Math.max(0, ...paymentNames(p).map((n) => nameSimilarity(who, n))), days: dayDiff(r.tx_date, p.payment_date) }))
        .filter((c) => c.sim >= minName || Math.abs(c.days) <= 3)
        .sort((a, b) => (Math.abs(a.days) - 3 * a.sim) - (Math.abs(b.days) - 3 * b.sim))
      const best = cands[0]
      if (!best) continue
      usedBank.add(r.id)
      usedPay.add(best.p.id)
      results.push({ bankId: r.id, paymentId: best.p.id, confirms: best.p.status !== 'confirmed', days: best.days })
    }
  }
  return results
}
