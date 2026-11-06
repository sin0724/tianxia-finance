/**
 * 사업소득지급대장의 외주 소득자 — 직원이 아니고 통장에서 실행비·촬영비로 이미 비용 처리된 사람.
 *
 * 급여로 넣으면 이체액이 이중계상되므로 monthly_payroll에 넣지 않는다.
 * 다만 비용에 잡힌 건 실지급액뿐이고 원천세 납부는 통장에서 현금 이동으로 빠지므로,
 * 세전 − 실지급액(원천세)만 해당 비용 줄에 더해야 비용이 세전 금액과 맞는다.
 * 이름이 들어가 저장소가 아닌 settings에 달별로 둔다.
 */

import { categoryOf } from '@/lib/ledger/categories'
import { stripBankPrefix } from '@/lib/ledger/classify'
import type { StatementRow } from './statement'

export interface OutsourcedEntry {
  name: string
  gross: number
  net: number
  /** 통장에서 이 사람 이체가 들어간 비용 분류 */
  category: string
}

export interface ExpenseTransfer {
  counterparty: string
  withdrawal: number
  category: string
}

/** 세무사 절사로 이체액과 대장 차인지급액이 10원 안팎 다를 수 있다 */
const NET_TOLERANCE = 100

export const outsourcedKey = (year: number, month: number) => `statement_outsourced_${year}-${String(month).padStart(2, '0')}`

export const nameKey = (s: string) => s.normalize('NFKC').replace(/\s/g, '').toUpperCase()

/** 대장 이름 → 비용 분류. 같은 이름으로 차인지급액만큼 나간 비용 이체가 있어야 외주로 본다 */
export function findOutsourced(rows: StatementRow[], bank: ExpenseTransfer[]) {
  const found = new Map<string, string>()
  for (const r of rows) {
    const tx = bank.find((b) => categoryOf(b.category).cls === 'expense'
      && Math.abs(b.withdrawal - r.net) <= NET_TOLERANCE
      && [b.counterparty, stripBankPrefix(b.counterparty)].some((n) => nameKey(n) === nameKey(r.rawName)))
    if (tx) found.set(r.rawName, tx.category)
  }
  return found
}
