import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  chooseTargetProject, clientNamePrefilterPattern, findClientByName, isForceNewProject,
  newProjectFields, sumPaidByProject,
} from './project-match'

const p = (id: string, status: string, total_amount: number) => ({ id, status, total_amount })

test('findClientByName: 대소문자 무시 정확 일치', () => {
  const list = [{ id: '1', name: 'Abc Shop' }, { id: '2', name: 'abc' }]
  assert.equal(findClientByName(list, 'ABC')?.id, '2')
  assert.equal(findClientByName(list, 'abc shop')?.id, '1')
  assert.equal(findClientByName(list, 'ab'), undefined)
})

test('findClientByName: % _ 는 글자 그대로 비교', () => {
  const list = [{ id: '1', name: 'a1b' }, { id: '2', name: 'a_b' }]
  assert.equal(findClientByName(list, 'a_b')?.id, '2')
  assert.equal(findClientByName(list, 'a%'), undefined)
})

test('clientNamePrefilterPattern: 와일드카드 문자는 한 글자 _ 로', () => {
  assert.equal(clientNamePrefilterPattern('50%할인*샵\\'),'50_할인_샵_')
  assert.equal(clientNamePrefilterPattern('평범한 상호'), '평범한 상호')
})

test('isForceNewProject', () => {
  assert.equal(isForceNewProject('추가계약', ''), true)
  assert.equal(isForceNewProject('입금완료', '재 계약 건'), true)
  assert.equal(isForceNewProject('미입금', '추가계약분'), true)
  assert.equal(isForceNewProject('입금완료', '1차 결제'), false)
})

test('sumPaidByProject: project_id 없는 건은 뺀다', () => {
  assert.deepEqual(
    sumPaidByProject([{ project_id: 'a', amount: 100 }, { project_id: 'a', amount: 50 }, { project_id: null, amount: 9 }]),
    { a: 150 },
  )
})

test('chooseTargetProject: 잔여 있는 진행중 우선', () => {
  const cands = [p('c1', 'completed', 100), p('o1', 'ongoing', 100), p('o2', 'ongoing', 100)]
  assert.equal(chooseTargetProject(cands, { o1: 100, o2: 30 }, false)?.id, 'o2')
})

test('chooseTargetProject: 진행중이 모두 완납이면 잔여 있는 완료', () => {
  const cands = [p('o1', 'ongoing', 100), p('c1', 'completed', 100)]
  assert.equal(chooseTargetProject(cands, { o1: 100, c1: 40 }, false)?.id, 'c1')
})

test('chooseTargetProject: 모두 완납·기타 상태면 null', () => {
  const cands = [p('o1', 'ongoing', 100), p('c1', 'completed', 100), p('h1', 'on_hold', 100)]
  assert.equal(chooseTargetProject(cands, { o1: 100, c1: 120 }, false), null)
})

test('chooseTargetProject: forceNew 면 null', () => {
  assert.equal(chooseTargetProject([p('o1', 'ongoing', 100)], {}, true), null)
})

test('newProjectFields: 첫 프로젝트는 상호명', () => {
  assert.deepEqual(newProjectFields({ clientName: 'A', priorCount: 0, forceNew: false, memo: '' }), { name: 'A', memo: null })
  assert.deepEqual(newProjectFields({ clientName: 'A', priorCount: 0, forceNew: true, memo: '재계약' }), { name: 'A', memo: '추가/재계약 (자동 생성)' })
})

test('newProjectFields: 완납 후 새 계약은 재계약 N차', () => {
  assert.deepEqual(newProjectFields({ clientName: 'A', priorCount: 2, forceNew: false, memo: '' }), { name: 'A (재계약 2차)', memo: '재계약 (자동 생성)' })
})

test('newProjectFields: forceNew 는 메모 표기에 따라 재계약/추가계약', () => {
  assert.equal(newProjectFields({ clientName: 'A', priorCount: 1, forceNew: true, memo: '재 계약' }).name, 'A (재계약 1차)')
  assert.equal(newProjectFields({ clientName: 'A', priorCount: 3, forceNew: true, memo: '' }).name, 'A (추가계약 3차)')
})
