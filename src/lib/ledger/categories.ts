/**
 * 통장 거래 분류 체계 — 정산에서 각 분류가 어디로 가는지의 단일 기준
 *
 *   revenue      매출 (VAT 포함) — 환불은 음수로 들어간다
 *   expense      비용 — line 으로 정산표의 어느 줄에 들어갈지 정한다
 *   payroll_cash 급여 관련 현금 이동 — 급여 비용은 세무사 대장(monthly_payroll)이 원본이므로 비용에서 뺀다
 *                (원천세·4대보험 납부까지 비용으로 넣으면 세전 급여와 이중계상된다)
 *   card         카드대금 결제 — 카드 비용은 승인내역(card_transactions)이 원본이므로 비용에서 뺀다
 *   non_pl       손익 외 — 대출·배당·보증금·가수금·타사업자 대납·법인 부가세. 현금만 움직이고 이익과 무관
 */

export type PlClass = 'revenue' | 'expense' | 'payroll_cash' | 'card' | 'non_pl' | 'unclassified'
export type SettleLine = 'product_cost' | 'fixed' | 'variable' | 'special'

export interface CategoryDef {
  label: string
  cls: PlClass
  line?: SettleLine
  /** 입금·출금 어느 쪽에서 쓰는 분류인지 (선택 목록 필터용) */
  side: 'in' | 'out' | 'both'
}

export const CATEGORIES = {
  revenue:        { label: '매출 입금',            cls: 'revenue', side: 'in' },
  refund:         { label: '환불',                 cls: 'revenue', side: 'out' },

  exec_cost:      { label: '실행비',               cls: 'expense', line: 'product_cost', side: 'out' },
  tw_team:        { label: '대만 실행팀 인건비',    cls: 'expense', line: 'product_cost', side: 'out' },
  production:     { label: '촬영·출연 인건비',      cls: 'expense', line: 'variable', side: 'out' },
  rent:           { label: '임차료',               cls: 'expense', line: 'fixed', side: 'out' },
  maintenance:    { label: '관리비',               cls: 'expense', line: 'fixed', side: 'out' },
  tw_office:      { label: '대만 사무실',           cls: 'expense', line: 'fixed', side: 'out' },
  fixed_service:  { label: '통신·세무·렌탈 등',     cls: 'expense', line: 'fixed', side: 'out' },
  vehicle:        { label: '차량·주차',             cls: 'expense', line: 'variable', side: 'out' },
  reimburse:      { label: '경비정산',              cls: 'expense', line: 'variable', side: 'out' },
  other_expense:  { label: '기타 경비',             cls: 'expense', line: 'variable', side: 'out' },
  loan_interest:  { label: '대출이자',              cls: 'expense', line: 'special', side: 'out' },
  tax_expense:    { label: '세금·공과 (법인 부담)',  cls: 'expense', line: 'special', side: 'out' },

  payroll_pay:    { label: '급여 지급',             cls: 'payroll_cash', side: 'out' },
  incentive_pay:  { label: '수당 지급',             cls: 'payroll_cash', side: 'out' },
  withholding:    { label: '원천세 납부',           cls: 'payroll_cash', side: 'out' },
  insurance:      { label: '4대보험 납부',          cls: 'payroll_cash', side: 'out' },

  card_payment:   { label: '카드대금',              cls: 'card', side: 'out' },

  vat:            { label: '법인 부가세',           cls: 'non_pl', side: 'out' },
  loan:           { label: '대출 입금·상환',         cls: 'non_pl', side: 'both' },
  dividend:       { label: '배당',                  cls: 'non_pl', side: 'both' },
  deposit:        { label: '보증금',                cls: 'non_pl', side: 'both' },
  shareholder:    { label: '가수금 입금·상환',       cls: 'non_pl', side: 'both' },
  other_entity:   { label: '타사업자·개인 대납',     cls: 'non_pl', side: 'out' },
  other_income:   { label: '기타 입금 (이자·환급)',  cls: 'non_pl', side: 'in' },

  unclassified:   { label: '미분류',                cls: 'unclassified', side: 'both' },
} as const satisfies Record<string, CategoryDef>

export type CategoryKey = keyof typeof CATEGORIES

export function categoryOf(key: string): CategoryDef {
  return (CATEGORIES as Record<string, CategoryDef>)[key] ?? CATEGORIES.unclassified
}

export const LINE_LABEL: Record<SettleLine, string> = {
  product_cost: '실행비',
  fixed: '고정비',
  variable: '변동비',
  special: '특수비용',
}
