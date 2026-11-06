import assert from 'node:assert/strict'
import test from 'node:test'
import { parseStatement, type Grid } from './statement'

/** 세무 프로그램 PDF 급여대장 모양 — 머리글 4줄(영수인이 끼어든 줄 포함), 직원 1명 3줄, 가운데 줄에 "합계(2명)" */
const grid: Grid = [
  ['', '', '', '', '2026년10월분급여대장', '', '', ''],
  ['(주)회사', '', '', '[귀속:2026년10월][지급:2026년10월30일]', '', '', '', ''],
  ['', '인적사항', '기본급여및제수당', '', '', '공제', '및차인지급액', ''],
  ['사원번호', '성명', '기본급', '', '', '소득세', '지방소득세', ''],
  ['', '', '', '', '', '', '', '영수인'],
  ['입사일', '직급', '', '', '', '', '공제합계', ''],
  ['퇴사일', '부서', '', '비과세계', '지급합계', '', '차인지급액', ''],
  ['001', '김하나', '3,000,000', '', '', '100,000', '10,000', ''],
  ['2026-01-01', '', '', '', '', '', '200,000', ''],
  ['', '', '', '200,000', '3,200,000', '', '3,000,000', ''],
  ['002', '박둘', '800,000', '', '', '-10,000', '-1,000', ''],
  ['2026-06-15', '', '', '', '', '', '50,000', ''],
  ['', '', '', '', '800,000', '', '750,000', ''],
  ['', '', '3,800,000', '', '', '90,000', '9,000', ''],
  ['', '합계(2명)', '', '', '', '', '250,000', ''],
  ['', '', '', '200,000', '4,000,000', '', '3,750,000', ''],
]

test('머리글 줄 수가 직원 줄 수보다 많은 PDF 급여대장을 읽는다', () => {
  const parsed = parseStatement([{ name: 'pdf', grid }], 2026, 10)
  assert.ok(parsed)
  assert.deepEqual(parsed.errors, [])
  assert.equal(parsed.kind, 'insured')
  assert.deepEqual(parsed.attribution, { year: 2026, month: 10, sure: true })
  assert.deepEqual(parsed.fileTotal, { gross: 4_000_000, net: 3_750_000 })

  const [first, second] = parsed.rows
  assert.deepEqual(
    { name: first.rawName, base: first.base, tax: first.baseIncomeTax, other: first.otherDeductions, net: first.net },
    { name: '김하나', base: 3_200_000, tax: 100_000, other: 90_000, net: 3_000_000 },
  )
  // 연말정산 환급 등으로 세금이 음수여도 지급액−공제=차인지급액이 맞아야 한다
  assert.deepEqual(
    { name: second.rawName, tax: second.baseIncomeTax, other: second.otherDeductions, net: second.net },
    { name: '박둘', tax: -10_000, other: 61_000, net: 750_000 },
  )
})

test('읽은 합계가 파일 총계와 다르면 막는다', () => {
  const tampered = grid.map((row) => [...row])
  tampered[15][4] = '4,000,001'
  const parsed = parseStatement([{ name: 'pdf', grid: tampered }], 2026, 10)
  assert.ok(parsed?.errors.some((e) => e.includes('파일 총계')))
})
