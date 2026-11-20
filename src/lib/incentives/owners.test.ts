import { test } from 'node:test'
import assert from 'node:assert/strict'
import { duplicateCrmNames, personOf, unmappedOwners, type OwnerManager, type OwnerRow } from './owners'

// 예시 이름은 지어낸 것이다
const A: OwnerManager = { id: 'a', name: '홍길동', crm_names: ['홍길동', '홍길동 0팀'], active: true }
const B: OwnerManager = { id: 'b', name: '김영희', crm_names: ['김옛이름'], active: true }
const OFF: OwnerManager = { id: 'off', name: '박쉼표', crm_names: ['박쉼표 0팀'], active: false }

const row = (row: number, owner: string, amount: number, date = '2026-11-05'): OwnerRow => ({ row, date, name: `상호${row}`, owner, amount })

test('CRM 담당자 값의 사람 이름', () => {
  assert.equal(personOf('홍길동 0팀'), '홍길동')
  assert.equal(personOf('  홍길동   1팀 '), '홍길동')
  assert.equal(personOf('김옛이름'), '김옛이름')
  assert.equal(personOf(''), '')
})

test('CRM 담당자명이 두 담당자에 겹치면 찾는다 (한 담당자 안의 중복은 괜찮다)', () => {
  assert.deepEqual(duplicateCrmNames([A, B]), [])
  assert.deepEqual(duplicateCrmNames([{ name: '홍길동', crm_names: ['홍길동', '홍길동'] }]), [])
  assert.deepEqual(
    duplicateCrmNames([A, { name: '김영희', crm_names: ['김옛이름', ' 홍길동 0팀 '] }]),
    [{ crmName: '홍길동 0팀', managers: ['홍길동', '김영희'] }],
  )
})

test('설정에 없는 담당자 값만, 이 달 줄만 담당자 값별로 묶는다', () => {
  const rows = [
    row(10, '홍길동 0팀', 1_100_000),          // 연결됨
    row(11, '홍길동 1팀', 2_200_000),          // 새 팀 표기
    row(12, '최새사람 0팀', 3_300_000),        // 새 사람
    row(13, '홍길동 1팀', 550_000),
    row(14, '최새사람 0팀', 4_400_000, '2026-10-30'), // 다른 달
    row(15, '김옛이름', 660_000),              // 예전 이름으로 연결됨
  ]
  const out = unmappedOwners(rows, [A, B], 2026, 11)
  assert.deepEqual(out.map((g) => [g.owner, g.rows.map((r) => r.row), g.total]), [
    ['홍길동 1팀', [11, 13], 2_750_000],
    ['최새사람 0팀', [12], 3_300_000],
  ])
})

test('이름이 같은 담당자를 연결 기본값으로, 없는 사람은 새 담당자 이름으로', () => {
  const out = unmappedOwners([
    row(1, '홍길동 2팀', 100), row(2, '김옛이름 0팀', 200), row(3, '김영희 0팀', 300), row(4, '최새사람 0팀', 400),
  ], [A, B], 2026, 11)
  const by = Object.fromEntries(out.map((g) => [g.owner, g]))
  assert.equal(by['홍길동 2팀'].suggestId, 'a')
  assert.equal(by['홍길동 2팀'].newName, null) // 같은 이름 담당자가 있으니 새로 만들지 않는다
  assert.equal(by['김옛이름 0팀'].suggestId, 'b') // CRM 담당자명의 앞 이름으로도 찾는다
  assert.equal(by['김영희 0팀'].suggestId, 'b')
  assert.equal(by['최새사람 0팀'].suggestId, null)
  assert.equal(by['최새사람 0팀'].newName, '최새사람')
})

test('쉬는 담당자의 CRM 담당자명은 정산에서 빠지므로 띄우고 알려 준다', () => {
  const out = unmappedOwners([row(1, '박쉼표 0팀', 500), row(2, '박쉼표 1팀', 600)], [A, OFF], 2026, 11)
  assert.equal(out.length, 2)
  assert.equal(out[0].inactiveName, '박쉼표')
  assert.equal(out[0].suggestId, null) // 쉬는 담당자는 연결 기본값으로 고르지 않는다
  assert.equal(out[1].inactiveName, null)
  assert.equal(out[1].newName, null) // 쉬는 담당자와 이름이 같아 새로 만들 수 없다
})
