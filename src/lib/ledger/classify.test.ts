import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyBankTx, type ClassificationRule, type ClassifyContext } from './classify'

const ctx = (rules: ClassificationRule[]): ClassifyContext => ({ rules, staffNames: new Set(['김하나']) })
const byName: ClassificationRule = { counterparty: '김하나', memo_contains: null, direction: 'out', category: 'other_expense', priority: 100 }
const tx = (memo: string) => ({ tx_date: '2026-11-10', counterparty: '김하나', memo, kind: '인터넷', withdrawal: 1000, deposit: 0 })

test('거래처 규칙이 있어도 메모가 급여·수당이면 급여 이체로 둔다', () => {
  assert.equal(classifyBankTx(tx('10월　급여'), ctx([byName])).category, 'payroll_pay')
  assert.equal(classifyBankTx(tx('10월　수당'), ctx([byName])).category, 'incentive_pay')
})

test('그 외 거래와 메모까지 지정한 규칙은 사용자 규칙을 따른다', () => {
  assert.equal(classifyBankTx(tx('김하나'), ctx([byName])).category, 'other_expense')
  const memoRule = { ...byName, memo_contains: '급여', category: 'tw_team' }
  assert.equal(classifyBankTx(tx('10월 급여'), ctx([memoRule])).category, 'tw_team')
})
