/**
 * 통장 거래 자동 분류
 *
 * 순서: 사용자 규칙(classification_rules, priority 순) → 기본 규칙(아래 builtin).
 * 기본 규칙은 2026-04~10 통장 712건을 직접 대조하며 맞춘 것이다 (reconcile/scripts/reconcile.py 와 같은 기준).
 * 어느 규칙에도 안 걸리는 출금은 '기타 경비', 입금은 '매출 입금'으로 둔다 — 매출 입금은 결제 내역과
 * 매칭되지 않으면 월 마감 화면에 "미등록 입금"으로 떠서 사람이 확인하게 된다.
 */
import type { CategoryKey } from './categories'

export interface BankTxInput {
  tx_date: string
  counterparty: string
  memo: string
  kind: string
  withdrawal: number
  deposit: number
}

export interface ClassificationRule {
  counterparty: string | null
  memo_contains: string | null
  direction: 'in' | 'out' | 'any'
  category: string
  priority: number
}

/**
 * 계좌 구분 — 사람·거래처 이름이 들어가므로 코드가 아니라 settings.ledger_accounts 에 둔다
 *   company      우리 법인의 다른 계좌 표시 (입금 = 대출 등 내부 이동, 소액 출금 = 대출이자)
 *   shareholder  대표 계좌 표시 — 출금은 메모가 비었거나 계좌 표시 그대로면 가수금 상환, 내용이 있으면 경비정산
 *   execPayees   실행비를 주 단위로 받는 사람 — 메모에 기간(예: 4/13-4/19)이 있으면 실행비
 */
export interface LedgerAccounts {
  company: string[]
  shareholder: string[]
  execPayees: string[]
}

export interface ClassifyContext {
  rules: ClassificationRule[]
  /** 급여 받는 사람의 통장 표시 이름 (employees.name + bank_name) */
  staffNames: Set<string>
  accounts?: LedgerAccounts
}

export interface Classified {
  category: CategoryKey
  classified_by: 'rule' | 'user_rule'
  /** 귀속월 (YYYY-MM-01) — 4대보험 지로 "2609" 같이 통장 표시에 귀속월이 있는 경우 */
  attribution_month: string | null
  note: string | null
}

const BANK_PREFIX = /^(카뱅|기업|하나|신한|농협|국민|우리|급여)/
const ASCII_NAME = /^[A-Za-z0-9._ ,\-]+$/
const DATE_RANGE = /\d{1,2}\/?\d{1,2}\s*[-~]\s*\d{1,2}\/?\d{1,2}/
// 지로 4대보험은 "２６０９국민건강" 처럼 전각 숫자로 귀속년월이 붙는다
const INSURANCE = /^([０-９0-9]{4})(국민건강|국민연금|고용보험|산재보험)/
// 세무서 납부 표시 "강서(109)부가세"
const TAX_OFFICE_VAT = /^\S+\(\d+\)부가세$/

const toHalfWidth = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))

export const EMPTY_ACCOUNTS: LedgerAccounts = { company: [], shareholder: [], execPayees: [] }

export function stripBankPrefix(name: string) {
  return name.replace(BANK_PREFIX, '')
}

function userRule(tx: BankTxInput, rules: ClassificationRule[]): string | null {
  const dir = tx.deposit > 0 ? 'in' : 'out'
  for (const r of [...rules].sort((a, b) => a.priority - b.priority)) {
    if (r.direction !== 'any' && r.direction !== dir) continue
    if (r.counterparty && r.counterparty !== tx.counterparty) continue
    if (r.memo_contains && !tx.memo.includes(r.memo_contains)) continue
    return r.category
  }
  return null
}

function builtin(tx: BankTxInput, ctx: ClassifyContext): { category: CategoryKey; month?: string } {
  const w = tx.counterparty.trim()
  const m = tx.memo.trim()
  const acc = ctx.accounts ?? EMPTY_ACCOUNTS
  const person = stripBankPrefix(w)

  // ── 입금 ──────────────────────────────────────────────────
  if (tx.deposit > 0) {
    if (acc.company.includes(w)) return { category: 'loan' }
    if (/배당/.test(m)) return { category: 'dividend' }
    // 대표·직원 본인 명의 입금 = 가수금 입금, 배당·급여 반환 등 — 매출이 아니다.
    // 대표 계좌의 법인 표시 입금은 거래처 대금을 대신 받아 넘긴 경우가 있어 매출로 두고 결제 매칭에 맡긴다
    if (ctx.staffNames.has(person)) return { category: 'shareholder' }
    if (['결산이자', '센타입금', '카드입금', '대체입금'].includes(tx.kind) || /^(PAYPAL|현대우대환급|국고환급)/.test(w)) {
      return { category: 'other_income' }
    }
    return { category: 'revenue' }
  }

  // ── 출금 ──────────────────────────────────────────────────
  if (/배당/.test(m)) return { category: 'dividend' }
  if (acc.company.includes(w)) return { category: /대출|이자|원리금/.test(m) || tx.withdrawal < 200_000 ? 'loan_interest' : 'loan' }
  if (/대환/.test(m)) return { category: 'loan' }
  if (/환불/.test(m) || m.endsWith(' 환')) return { category: 'refund' }
  if (/보증금/.test(m) || (/호/.test(m) && /계약금|잔금/.test(m))) return { category: 'deposit' }
  if (w === '부가가치세' || TAX_OFFICE_VAT.test(w)) return { category: 'vat' }
  if (['사업소득세', '근로소득세', '서울지방소'].includes(w)) return { category: 'withholding' }
  if (w === '서울주민세') return { category: 'tax_expense' }
  const ins = INSURANCE.exec(w)
  if (ins) {
    const ym = toHalfWidth(ins[1])
    return { category: 'insurance', month: `20${ym.slice(0, 2)}-${ym.slice(2, 4)}-01` }
  }
  if (w === 'KB카드출금' || tx.kind === '체크카드') return { category: 'card_payment' }
  if (/실행팀/.test(m)) return { category: 'tw_team' }
  if ((/대만/.test(m) && /사무실/.test(m)) || w === '대만사무실' || m === '대만사무실') return { category: 'tw_office' }
  const day = Number(tx.tx_date.slice(8, 10))
  if (/급여|퇴사/.test(m) || w.startsWith('급여') || ['타행급여1건', '당타행1건'].includes(w)
      || (!m && ctx.staffNames.has(person) && day >= 8 && day <= 12)) {
    return { category: 'payroll_pay' }
  }
  if (/수당/.test(m)) return { category: 'incentive_pay' }
  if (/유류비|주차/.test(m)) return { category: 'vehicle' }
  if (/실행|기사배포|왕홍|KOL|PR|기사|체험단/.test(m) || w.endsWith('실행비') || /MCN/.test(w) || (ASCII_NAME.test(w) && !m)) {
    return { category: 'exec_cost' }
  }
  if (acc.execPayees.includes(w) && (DATE_RANGE.test(m) || /퀵|출장비/.test(m))) return { category: 'exec_cost' }
  if (/월세/.test(w) || m === '월세') return { category: 'rent' }
  if (/관리비/.test(m)) return { category: 'maintenance' }
  if (/촬영|구프/.test(m)) return { category: 'production' }
  if (acc.shareholder.includes(w)) {
    // 사용자 확인(2026-10): 대표 계좌 이체 = 가수금 상환 + 경비정산. 메모가 비었거나 계좌 표시 그대로면 가수금 상환
    if (!m || acc.shareholder.includes(m) || ctx.staffNames.has(m)) return { category: 'shareholder' }
    return { category: 'reimburse' }
  }
  if (/^(쿠쿠|ＳＫ|SK|KT|세무법인|한국무역정|메타광고|기타전문전신료)/.test(w)) return { category: 'fixed_service' }
  return { category: 'other_expense' }
}

export function classifyBankTx(tx: BankTxInput, ctx: ClassifyContext): Classified {
  const base = builtin(tx, ctx)
  const user = userRule(tx, ctx.rules)
  if (user) {
    return { category: user as CategoryKey, classified_by: 'user_rule', attribution_month: base.month ?? null, note: null }
  }
  return { category: base.category, classified_by: 'rule', attribution_month: base.month ?? null, note: null }
}
