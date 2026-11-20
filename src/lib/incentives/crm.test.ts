import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCrmAmount, parseCrmDate, parseCrmGrid } from './crm'

const HEAD = ['', '날짜', '상호명', '대표자', '전화번호', '담당자', '금액', '작업내용 및 특이사항', '입금상태', '계산서', '', '', '동기화ID (수정금지)']

test('CRM 날짜 — 날짜 칸 일련번호와 글 모두', () => {
  assert.equal(parseCrmDate(46329, 2026), '2026-11-03')
  assert.equal(parseCrmDate('2026-11-03', 2026), '2026-11-03')
  assert.equal(parseCrmDate('2026.11.3', 2026), '2026-11-03')
  assert.equal(parseCrmDate('2026. 11. 3.', 2026), '2026-11-03')
  assert.equal(parseCrmDate('11/3', 2026), '2026-11-03')
  assert.equal(parseCrmDate('-', 2026), null)
  assert.equal(parseCrmDate('', 2026), null)
})

test('CRM 금액 — 숫자 칸은 그대로, 글은 콤마를 빼고 첫 숫자', () => {
  assert.equal(parseCrmAmount(3300000), 3300000)
  assert.equal(parseCrmAmount('3,300,000원'), 3300000)
  assert.equal(parseCrmAmount('-'), 0)
})

test('CRM 결제시트 — 머리글로 열을 찾고 정산 대상 줄만 고른다', () => {
  const grid: unknown[][] = [
    HEAD,
    [false, 46329, '가나상사', '대표', '010', '담당A', 3300000, '3개월 분납', '잔금 처리 요망', '', '', '', 'tx_a'],
    [false, 46330, '나다', '', '', '담당A', '1,100,000', '', '입금완료 ', '', '', '', 'tx_b'],
    [false, 46330, '-', '', '', '담당A', 1000, '', '', '', '', '', 'tx_c'],
    [false, 46330, '다라', '', '', '1', 1000, '', '', '', '', '', 'tx_d'],
    [false, '', '마바', '', '', '담당A', 1000, '', '', '', '', '', 'tx_e'],
    [false, 46330, '바사', '', '', '담당A', 0, '', '', '', '', '', 'tx_f'],
    [false, 46331, '사아', '', '', '담당B', 2200000, '', '미입금'],
  ]
  const { rows, missingSid } = parseCrmGrid(grid, 2026)
  assert.deepEqual(rows.map((r) => [r.row, r.date, r.name, r.owner, r.amount, r.status, r.sid, r.memo]), [
    [2, '2026-11-03', '가나상사', '담당A', 3300000, '잔금 처리 요망', 'tx_a', '3개월 분납'],
    [3, '2026-11-04', '나다', '담당A', 1100000, '입금완료', 'tx_b', ''],
  ])
  assert.deepEqual(missingSid, [{ row: 8, date: '2026-11-05', name: '사아', owner: '담당B', amount: 2200000 }])
})

test('CRM 결제시트 — 필수 머리글이 없으면 멈춘다', () => {
  assert.throws(() => parseCrmGrid([['날짜', '상호명', '금액']], 2026), /담당자|owner/)
})
