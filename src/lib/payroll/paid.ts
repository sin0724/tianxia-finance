/**
 * 급여 지급 현황 — 통장 이체를 귀속월 급여와 맞춰 본다. 정산(손익)에는 영향이 없고 "얼마를 더 보내야 하나"만 알려준다.
 *
 * 직원마다 이름으로 따로 이체하고 메모에 "9월 급여"처럼 귀속월을 적는 관행을 따른다.
 * 그래서 선지급·퇴사자 급여도 메모의 달로 제 귀속월에 붙는다. 메모에 달이 없으면 지급일 전달이 귀속월이다.
 * 통장에서 찾을 수 없는 지급(현금, 묶음 이체)은 사람이 체크하며 monthly_payroll.paid_at에 남는다.
 */

import { stripBankPrefix } from '@/lib/ledger/classify'

export interface PayTransfer {
  tx_date: string
  counterparty: string
  memo: string
  withdrawal: number
}

export type PaidState = 'unpaid' | 'partial' | 'paid' | 'over' | 'checked'

export interface PaidStatus {
  state: PaidState
  /** 통장에서 찾은 이체 합계 */
  paid: number
  /** 더 보내야 할 금액 */
  remaining: number
  /** 명세서보다 더 나간 금액 */
  over: number
  transfers: PayTransfer[]
}

const nameKey = (s: string) => s.normalize('NFKC').replace(/\s/g, '').toUpperCase()

/** 이체가 어느 귀속월 급여인지. 통장 메모에는 전각 문자가 섞여 NFKC로 맞춘 뒤 읽는다 */
export function payAttribution(tx: Pick<PayTransfer, 'tx_date' | 'memo'>) {
  const year = Number(tx.tx_date.slice(0, 4))
  const month = Number(tx.tx_date.slice(5, 7))
  const stated = Number(/(\d{1,2})\s*월/.exec(tx.memo.normalize('NFKC'))?.[1] ?? 0)
  if (stated >= 1 && stated <= 12) return { year: stated > month + 1 ? year - 1 : year, month: stated }
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 }
}

/** 고른 귀속월의 이체를 직원별로 모은다. 통장 표시는 실명이거나 영문 예금주명(bank_name)이다 */
export function transfersByEmployee<E extends { id: string; name: string; bank_name: string | null }>(
  employees: E[], transfers: PayTransfer[], year: number, month: number,
) {
  const idOf = new Map<string, string>()
  for (const e of employees) {
    for (const n of [e.name, e.bank_name]) if (n && !idOf.has(nameKey(n))) idOf.set(nameKey(n), e.id)
  }

  const byEmployee = new Map<string, PayTransfer[]>()
  for (const tx of transfers) {
    const a = payAttribution(tx)
    if (a.year !== year || a.month !== month) continue
    const id = idOf.get(nameKey(tx.counterparty)) ?? idOf.get(nameKey(stripBankPrefix(tx.counterparty)))
    if (id) byEmployee.set(id, [...(byEmployee.get(id) ?? []), tx])
  }
  return byEmployee
}

export function paidStatus(net: number, transfers: PayTransfer[], checkedAt: string | null): PaidStatus {
  const paid = transfers.reduce((s, t) => s + t.withdrawal, 0)
  const base = { paid, transfers, remaining: 0, over: 0 }
  if (paid > net) return { ...base, state: 'over', over: paid - net }
  if (paid === net) return { ...base, state: 'paid' }
  if (checkedAt) return { ...base, state: 'checked' }
  return { ...base, state: paid > 0 ? 'partial' : 'unpaid', remaining: net - paid }
}
