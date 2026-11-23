import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { groupReceivablesByManager, managerPersonName, type ReceivableRow } from './receivables'

test('managerPersonName: 팀 접미사 제거', () => {
  assert.equal(managerPersonName('나병훈 0팀'), '나병훈')
  assert.equal(managerPersonName('이현우 2팀'), '이현우')
  assert.equal(managerPersonName('김철수12팀'), '김철수')
  assert.equal(managerPersonName('  박영희 3 팀  '), '박영희')
})

test('managerPersonName: 접미사 없으면 그대로', () => {
  assert.equal(managerPersonName('신현준'), '신현준')
  assert.equal(managerPersonName(' 신현준 '), '신현준')
})

test('managerPersonName: 비어 있으면 미지정', () => {
  assert.equal(managerPersonName(null), '미지정')
  assert.equal(managerPersonName(undefined), '미지정')
  assert.equal(managerPersonName(''), '미지정')
  assert.equal(managerPersonName('   '), '미지정')
  assert.equal(managerPersonName('0팀'), '미지정')
})

const row = (id: string, managerName: string, amount: number): ReceivableRow => ({
  id, clientName: id, projectName: null, manager: managerName, managerName, amount,
  status: 'unpaid', statusLabel: '미입금', paymentDate: '2026-11-01', syncId: null, isSplit: false, excluded: false,
})

test('groupReceivablesByManager: 그룹은 합계 큰 순, 행은 금액 큰 순', () => {
  const groups = groupReceivablesByManager([
    row('a', '나병훈', 100), row('b', '이현우', 500), row('c', '나병훈', 300), row('d', '미지정', 50),
  ])
  assert.deepEqual(groups.map((g) => [g.managerName, g.count, g.total]), [
    ['이현우', 1, 500], ['나병훈', 2, 400], ['미지정', 1, 50],
  ])
  assert.deepEqual(groups[1].rows.map((r) => r.id), ['c', 'a'])
})
