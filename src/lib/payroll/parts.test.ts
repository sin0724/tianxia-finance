import assert from 'node:assert/strict'
import test from 'node:test'
import { applyStatement, employeesOfKind, mergeParts, partFromSaved, type StatementParts } from './parts'
import type { StatementRow } from './statement'

const row = (base: number, tax: number, insurance: number): StatementRow => ({
  rawName: '나병훈', base, incentive: 0, baseIncomeTax: tax, baseLocalTax: Math.floor(tax / 100) * 10,
  incentiveIncomeTax: 0, incentiveLocalTax: 0, otherDeductions: insurance, employerInsurance: 0,
  net: base - tax - Math.floor(tax / 100) * 10 - insurance,
})

test('두 명세서에 함께 나오면 금액을 합친다', () => {
  let parts: StatementParts = {}
  parts = applyStatement(parts, 'insured', '급여대장.pdf', [{ ...row(2_156_880, 18_210, 190_100), employeeId: 'a' }], [])
  parts = applyStatement(parts, 'business', '사업소득.pdf', [{ ...row(5_567_399, 167_020, 0), employeeId: 'a' }], [])
  const m = mergeParts(parts.a)
  assert.equal(m?.kind, 'insured')
  assert.equal(m?.file, '급여대장.pdf + 사업소득.pdf')
  assert.equal(m?.row.base, 7_724_279)
  assert.equal(m?.row.net, 1_946_750 + 5_383_679)
})

test('한쪽 명세서를 다시 올리면 그쪽 몫만 바뀐다', () => {
  let parts: StatementParts = {}
  parts = applyStatement(parts, 'insured', 'i.pdf', [{ ...row(2_156_880, 18_210, 190_100), employeeId: 'a' }], [])
  parts = applyStatement(parts, 'business', 'b.pdf', [{ ...row(7_724_279, 231_720, 0), employeeId: 'a' }], [])
  const before = parts
  parts = applyStatement(parts, 'business', 'b2.pdf', [{ ...row(5_567_399, 167_020, 0), employeeId: 'a' }], [])
  assert.equal(mergeParts(parts.a)?.row.base, 2_156_880 + 5_567_399)
  assert.equal(before.a.business?.base, 7_724_279, '원본은 바꾸지 않는다')
})

test('이번 파일에 없는 직원은 그 명세서 몫만 빠지고, 남은 게 없으면 지운다', () => {
  let parts: StatementParts = {}
  parts = applyStatement(parts, 'insured', 'i.pdf', [{ ...row(100, 0, 0), employeeId: 'a' }], [])
  parts = applyStatement(parts, 'business', 'b.pdf', [{ ...row(200, 0, 0), employeeId: 'a' }, { ...row(300, 0, 0), employeeId: 'b' }], [])
  parts = applyStatement(parts, 'business', 'b2.pdf', [], ['a', 'b'])
  assert.equal(mergeParts(parts.a)?.row.base, 100)
  assert.equal(parts.b, undefined)
  assert.equal(mergeParts(parts.b), null)
  assert.deepEqual(employeesOfKind(parts, 'insured'), ['a'])
})

test('이 기능 전에 저장된 줄은 그 종류의 몫으로 본다. 현금 지급은 아니다', () => {
  const saved = {
    employee_id: 'a', statement_kind: 'business', statement_file: 'b.pdf', base_salary: 7_724_279,
    base_income_tax: 231_720, base_local_tax: 23_170, incentive_income_tax: 0, incentive_local_tax: 0,
    other_deductions: 0, employer_insurance: 0, net_pay: 7_469_389,
  }
  assert.equal(partFromSaved(saved, 0)?.kind, 'business')
  assert.equal(partFromSaved(saved, 0)?.part.net, 7_469_389)
  assert.equal(partFromSaved({ ...saved, statement_kind: 'cash' }, 0), null)
})
