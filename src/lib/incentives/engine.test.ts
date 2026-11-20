import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CONFIG as cfg, calcClawback, calcLine, comma, formatRate, man, mixRate, needsPaidInput,
  normalizeRateInput, parseRate, paymentOf, planSync, summarize, RateError,
  type Carryover, type CrmRow, type ExistingLine,
} from './engine'

const line = (sales: number | null, paid: number | null, rate: string | null) => calcLine({ sales, paid, rate }, cfg)

test('C 순매출 · E 인센티브 — 시트 수식과 같은 값', () => {
  assert.deepEqual([line(330000, null, '20%').net, line(330000, null, '20%').incentive], [300000, 60000])
  assert.deepEqual([line(4950000, null, '20%').net, line(4950000, null, '20%').incentive], [4500000, 900000])
  // 미입금: D=0 이면 인센 0, F가 비면 기본율
  assert.deepEqual([line(398099, 0, null).net, line(398099, 0, null).incentive], [361908, 0])
  // (잔금) 줄: B=0, D=입금액
  assert.equal(line(0, 1034000, '0%').incentive, 0)
  assert.equal(line(0, 1034000, '20%').incentive, 188000)
  // D가 있으면 D/1.1 기준 (반올림 전 값에 율을 곱한다)
  assert.equal(line(11000000, 5500000, null).incentive, 1000000)
  assert.equal(line(18480000, 3000000, '20%').incentive, 545455) // 3,000,000/1.1×0.2 = 545,454.5…
  // 수동 분납 줄: B=입금액, D 빈칸
  assert.equal(line(4455000, null, '20%').incentive, 810000)
  assert.equal(line(0, null, '20%').incentive, 0)
  // B가 비면 C·E도 빈칸
  assert.deepEqual(line(null, null, '20%'), { net: null, incentive: null, rate: null, error: null })
})

test('F 인센티브율 — 분수식 · 소수 · 작업별 혼합', () => {
  // 실비 제외 건은 시트처럼 "=지급액/공급가" 분수로 적는다
  assert.equal(line(2970000, null, '230400/2700000').incentive, 230400)
  assert.equal(line(2970000, null, '=230400/2700000').incentive, 230400)
  assert.equal(line(22000000, null, '15.12%').incentive, 3024000)
  // 계약 총액 기준으로 맞춘 마지막 지급분: (총 인센 − 이미 준 돈) ÷ 기준액
  assert.equal(line(0, 16500000, '=((15500000*20%+14500000*15%)-3000000)/15000000').incentive, 2275000)
  assert.equal(line(1100000, null, '=-20%+40%').incentive, 200000)
  assert.match(line(1100000, null, '=1/0').error ?? '', /0으로/)
  // 작업별 혼합: 둘 다 적으면 적은 금액 비율대로
  const mix = line(5819000, null, 'A 2,645,000 0%, B 2,645,000 10%')
  assert.equal(mix.net, 5290000)
  assert.equal(mix.incentive, 264500)
  // 일부만 적으면 나머지는 기본율
  assert.equal(line(22000000, null, 'C작업 1500만 10%').incentive, 2500000)
  assert.equal(mixRate('C작업 1500만 10%', 20000000, 0.2).toNumber(), 0.125)
  // "1500"처럼 단위 없는 작은 숫자는 만원
  assert.equal(mixRate('A 1500 10%', 15000000, 0.2).toNumber(), 0.1)
  // 이름에 숫자가 있어도 단위가 붙은 숫자를 금액으로 본다
  assert.equal(mixRate('2차작업 500만 10%', 5000000, 0.2).toNumber(), 0.1)
  // 읽을 수 없으면 시트처럼 오류
  const bad = line(1100000, null, 'A작업 500만')
  assert.equal(bad.incentive, null)
  assert.match(bad.error ?? '', /인센율/)
})

test('F 입력값 정리 — 시트의 % 서식 칸과 같은 해석', () => {
  assert.equal(normalizeRateInput(''), null)
  assert.equal(normalizeRateInput('20'), '20%')
  assert.equal(normalizeRateInput('0.2'), '20%')
  assert.equal(normalizeRateInput('0'), '0%')
  assert.equal(normalizeRateInput('8.53 %'), '8.53%')
  assert.equal(normalizeRateInput('=230400/2700000'), '=230400/2700000')
  assert.equal(normalizeRateInput('230400/2700000'), '=230400/2700000')
  assert.equal(normalizeRateInput('=(1000000*20%-50000)/1000000'), '=(1000000*20%-50000)/1000000')
  assert.throws(() => normalizeRateInput('=20%*'), RateError)
  assert.throws(() => normalizeRateInput('=1/(2-2)'), RateError)
  assert.equal(normalizeRateInput('A 500만 20%, B 1500만 10%'), 'A 500만 20%, B 1500만 10%')
  assert.throws(() => normalizeRateInput('실비 제외'), RateError)
  assert.throws(() => normalizeRateInput('1/0'), RateError)
})

test('인센티브율 표시', () => {
  const frac = parseRate('230400/2700000')
  assert.equal(frac.kind, 'number')
  assert.equal(formatRate(frac.kind === 'number' ? frac.value : null), '8.53%')
  assert.equal(formatRate(0.2), '20%')
  assert.equal(formatRate(0), '0%')
  assert.equal(formatRate(0.1512), '15.12%')
})

test('만원 · 콤마 표시 (Apps Script man_ · comma_)', () => {
  assert.equal(man(1034000), '103만원')
  assert.equal(man(11880000), '1,188만원')
  assert.equal(man(15000), '2만원')
  assert.equal(comma(18878099), '18,878,099')
})

test('D칸 입력 필요 표시 — 시트 빨간 칸 조건', () => {
  assert.equal(needsPaidInput({ note: '[잔금] D열에 입금액 입력', paid: 0 }), true)
  assert.equal(needsPaidInput({ note: '[잔금] D열에 입금액 입력', paid: null }), true)
  assert.equal(needsPaidInput({ note: '[잔금] D열에 입금액 입력', paid: 3000000 }), false)
  assert.equal(needsPaidInput({ note: '[분납] 9월 계약', paid: null }), true)
  assert.equal(needsPaidInput({ note: '[분납] 9월 계약', paid: 0 }), false)
  assert.equal(needsPaidInput({ note: '[잔금 정산] 10월 계약', paid: 0 }), false)
})

test('환수내역 계산 — 진행률 구간 · 직접입력 우선', () => {
  // 지급 1,300,000 − 인정 975,000 (공급가 6,500,000 × 15%) = 325,000
  const c = calcClawback({ direct_amount: null, contract_amount: 7150000, progress: 70 }, cfg)
  assert.deepEqual(c, {
    supply: 6500000, paidRate: 0.2, allowedRate: 0.15, paidAmount: 1300000, allowedAmount: 975000, total: 325000,
  })
  assert.equal(calcClawback({ direct_amount: 420000, contract_amount: null, progress: null }, cfg).total, 420000)
  assert.equal(calcClawback({ direct_amount: 100000, contract_amount: 7150000, progress: 70 }, cfg).total, 100000)
  // 진행률이 비면 0% 구간(5%)
  assert.equal(calcClawback({ direct_amount: null, contract_amount: 1100000, progress: null }, cfg).total, 150000)
  assert.equal(calcClawback({ direct_amount: null, contract_amount: 1100000, progress: 49.9 }, cfg).total, 150000)
  assert.equal(calcClawback({ direct_amount: null, contract_amount: 1100000, progress: 50 }, cfg).total, 100000)
  // 100% 진행이면 환수 없음
  assert.equal(calcClawback({ direct_amount: null, contract_amount: 1100000, progress: 100 }, cfg).total, 0)
  assert.equal(calcClawback({ direct_amount: null, contract_amount: null, progress: null }, cfg).total, 0)
})

test('월 요약 — M = I + J + K, N = M − O', () => {
  const s = summarize(
    [
      { sales: 330000, paid: null, rate: '20%' },
      { sales: 4950000, paid: null, rate: '20%' },
      { sales: 0, paid: null, rate: '20%' },
      { sales: 0, paid: 1034000, rate: '0%' },
      { sales: 0, paid: null, rate: '없는 규칙' },
    ],
    { base_salary: 2000000, special_allowance: 300000 },
    [{ direct_amount: 325000, contract_amount: null, progress: null }],
    cfg,
  )
  assert.deepEqual(s, {
    totalSales: 5280000, baseSalary: 2000000, incentive: 960000, special: 300000,
    gross: 3260000, clawback: 325000, net: 2935000, errors: 1,
  })
})

const crm = (over: Partial<CrmRow>): CrmRow => ({
  row: 2, date: '2026-12-03', name: '가나상사', owner: '담당A', amount: 3300000, status: '입금완료',
  sid: 'tx_a', memo: '', ...over,
})

test('CRM 입금상태 해석 (paymentOf_)', () => {
  assert.deepEqual(paymentOf(cfg, crm({})), { kind: 'full', paid: 3300000 })
  assert.deepEqual(paymentOf(cfg, crm({ status: '미입금' })), { kind: 'unpaid', paid: 0 })
  assert.deepEqual(paymentOf(cfg, crm({ status: '' })), { kind: 'unpaid', paid: 0 })
  assert.deepEqual(paymentOf(cfg, crm({ status: '잔금 처리 요망' })), { kind: 'partial', paid: null })
  assert.deepEqual(paymentOf(cfg, crm({ status: '잔금 처리 요망', paidRaw: 1000000 })), { kind: 'partial', paid: 1000000 })
  assert.deepEqual(paymentOf(cfg, crm({ status: '잔금 처리 요망', balanceRaw: 3300000 })), { kind: 'unpaid', paid: 0 })
})

const existing = (over: Partial<ExistingLine>): ExistingLine => ({
  id: 'l1', year: 2026, month: 11, position: 1, sync_id: 'tx_a', sales: 3300000, paid: null, note: '', ...over,
})

test('동기화 — 새 건만 날짜순으로 추가하고 있던 줄은 그대로 둔다', () => {
  const plan = planSync({
    cfg, aliases: ['담당A'], year: 2026, month: 12, isLatest: true, carryovers: [],
    crm: [
      crm({ row: 5, date: '2026-12-09', sid: 'tx_c', name: '다라', status: '미입금' }),
      crm({ row: 3, date: '2026-12-02', sid: 'tx_b', name: '나다', status: '잔금 처리 요망' }),
      crm({ row: 4, date: '2026-12-02', sid: 'tx_d', name: '마바' }),
      crm({ row: 6, date: '2026-12-05', sid: 'tx_e', owner: '다른담당' }),
      crm({ row: 7, date: '2026-11-30', sid: 'tx_f' }),
      crm({ row: 8, date: '2026-12-10', sid: 'tx_g' }),
    ],
    lines: [existing({ id: 'g', month: 12, sync_id: 'tx_g', paid: null, note: '손으로 고친 비고' })],
  })
  assert.deepEqual(plan.add.map((l) => [l.sync_id, l.paid, l.note, l.fill, l.kind]), [
    ['tx_b', 0, '[잔금] D열에 입금액 입력 → 그 금액만큼 인센 선지급', 'yellow', 'contract'],
    ['tx_d', null, '', null, 'contract'],
    ['tx_c', 0, '[미입금] 입금 시 인센 지급', 'red', 'contract'],
  ])
  assert.deepEqual(plan.originUpdates, [])
  assert.equal(plan.stats.kept, 1)
  assert.equal(plan.stats.unpaid, 1)
  assert.equal(plan.stats.partial, 1)
})

test('동기화 — 잔금 처리 요망인 이전 달 계약은 최근 달마다 (분납) 줄', () => {
  const carry: Carryover = {
    id: 'c1', base_sync_id: 'tx_w', origin_year: 2026, origin_month: 9, origin_note: '[잔금] D열에 입금액 입력',
    settled: 3960000, paid_count: 1,
  }
  const args = {
    cfg, aliases: ['담당A'], year: 2026, month: 12, isLatest: true, carryovers: [carry],
    crm: [crm({ date: '2026-09-15', sid: 'tx_w', name: '위위', amount: 11880000, status: '잔금 처리 요망' })],
  }
  const plan = planSync({
    ...args,
    lines: [existing({ id: 'n', month: 11, sync_id: 'tx_w#11', sales: 0, paid: 0, note: '[분납] 9월 계약' })],
  })
  assert.deepEqual(plan.add, [{
    client_name: '위위 (분납)', sales: 0, paid: null,
    note: '[분납] 9월 계약 · 2회차 · 12월 입금액을 D열에 입력(없으면 0) · 누적 396만원 / 1,188만원',
    sync_id: 'tx_w#12', crm_date: '2026-09-15', kind: 'installment', fill: 'yellow',
  }])
  assert.deepEqual(plan.originUpdates, [])

  // 이번 달 (분납) 줄이 이미 있으면 또 만들지 않는다
  const again = planSync({ ...args, lines: [existing({ id: 'm', month: 12, sync_id: 'tx_w#12', sales: 0, paid: null })] })
  assert.deepEqual(again.add, [])

  // 가장 최근 달이 아니면 잔금 · 분납 줄을 만들지 않는다
  assert.deepEqual(planSync({ ...args, lines: [], isLatest: false }).add, [])

  // 계약 달에는 원래 줄 D칸에 적으므로 (분납) 줄이 없다
  const sameMonth = planSync({
    ...args, carryovers: [], month: 9,
    lines: [existing({ id: 'o', month: 9, sync_id: 'tx_w', sales: 11880000, paid: 0, note: '[잔금] D열에 입금액 입력' })],
  })
  assert.deepEqual(sameMonth.add, [])
})

test('동기화 — 미입금이던 이전 달 계약이 잔금 처리 요망이면 원래 줄을 [분납중]으로', () => {
  const plan = planSync({
    cfg, aliases: ['담당A'], year: 2026, month: 12, isLatest: true, carryovers: [],
    crm: [crm({ date: '2026-11-03', sid: 'tx_u', name: '미미', amount: 2200000, status: '잔금 처리 요망' })],
    lines: [existing({ id: 'u', month: 11, sync_id: 'tx_u', sales: 2200000, paid: 0, note: '[미입금] 입금 시 인센 지급' })],
  })
  assert.equal(plan.add.length, 1)
  assert.equal(plan.add[0].note, '[분납] 11월 계약 · 1회차 · 12월 입금액을 D열에 입력(없으면 0) · 누적 0만원 / 220만원')
  assert.deepEqual(plan.originUpdates, [
    { target: 'line', id: 'u', note: '[분납중] 최근 월 탭 (분납) 행에 입금액 입력', fill: 'yellow' },
  ])
})

test('동기화 — 입금완료가 되면 남은 금액만큼 (잔금) 줄, 원래 줄은 [완납]', () => {
  const plan = planSync({
    cfg, aliases: ['담당A'], year: 2026, month: 12, isLatest: true, carryovers: [],
    crm: [crm({ date: '2026-11-03', sid: 'tx_p', name: '플플', amount: 18480000, status: '입금완료' })],
    lines: [
      existing({ id: 'p', month: 11, sync_id: 'tx_p', sales: 18480000, paid: 3000000, note: '[잔금] D열에 입금액 입력' }),
      existing({ id: 'x', month: 12, sync_id: 'tx_p#12', sales: 0, paid: 1000000, note: '[잔금 정산] 이미 있는 줄' }),
    ],
  })
  assert.deepEqual(plan.add, [{
    client_name: '플플 (잔금)', sales: 0, paid: 14480000,
    note: '[잔금 정산] 11월 계약 · 추가 입금 1,448만원 인센',
    sync_id: 'tx_p#12_2', crm_date: '2026-11-03', kind: 'balance', fill: 'green',
  }])
  assert.deepEqual(plan.originUpdates, [{ target: 'line', id: 'p', note: '[완납] 12월 탭에서 잔금 인센 정산', fill: 'green' }])
})

test('동기화 — 같은 달 미입금 줄이 입금완료로 바뀌면 그 달에 (잔금) 줄', () => {
  const plan = planSync({
    cfg, aliases: ['담당A'], year: 2026, month: 11, isLatest: true, carryovers: [],
    crm: [crm({ date: '2026-11-02', sid: 'tx_m', name: '웹웹', amount: 398099, status: '입금완료' })],
    lines: [existing({ id: 'm', month: 11, sync_id: 'tx_m', sales: 398099, paid: 0, note: '[미입금] 입금 시 인센 지급' })],
  })
  assert.deepEqual(plan.add.map((l) => [l.sync_id, l.paid, l.note]), [
    ['tx_m#11', 398099, '[잔금 정산] 11월 계약 · 추가 입금 40만원 인센'],
  ])
  assert.deepEqual(plan.originUpdates, [{ target: 'line', id: 'm', note: '[완납] 11월 탭에서 잔금 인센 정산', fill: 'green' }])

  // 사람이 붙인 확인 메모는 남긴다
  const memo = planSync({
    cfg, aliases: ['담당A'], year: 2026, month: 11, isLatest: true, carryovers: [],
    crm: [crm({ date: '2026-11-02', sid: 'tx_m', name: '웹웹', amount: 398099, status: '입금완료' })],
    lines: [existing({
      id: 'm', month: 11, sync_id: 'tx_m', sales: 398099, paid: 0,
      note: '[미입금] 입금 시 인센 지급 · [11월 확인] 실비 제외 0% 대상인지 확인',
    })],
  })
  assert.equal(memo.originUpdates[0].note, '[완납] 11월 탭에서 잔금 인센 정산 · [11월 확인] 실비 제외 0% 대상인지 확인')
})

test('동기화 — 손으로 쓴 비고는 색만 바꾸고 환불 처리한 건은 건너뛴다', () => {
  const base = {
    cfg, aliases: ['담당A'], year: 2026, month: 12, isLatest: true,
    crm: [crm({ date: '2026-10-20', sid: 'tx_k', name: '케케', amount: 5500000, status: '입금완료' })],
    lines: [] as ExistingLine[],
  }
  const carry = (note: string): Carryover => ({
    id: 'c', base_sync_id: 'tx_k', origin_year: 2026, origin_month: 10, origin_note: note, settled: 2750000, paid_count: 1,
  })
  const manual = planSync({ ...base, carryovers: [carry('실비 제외 · 공급가 5,000,000 기준')] })
  assert.equal(manual.add[0].paid, 2750000)
  assert.deepEqual(manual.originUpdates, [{ target: 'carryover', id: 'c', note: undefined, fill: 'green' }])

  const refunded = planSync({ ...base, carryovers: [carry('[환불] 2,750,000 환불')] })
  assert.deepEqual(refunded.add, [])
})

test('동기화 — 이미 전액 정산된 건은 아무것도 만들지 않는다', () => {
  const plan = planSync({
    cfg, aliases: ['담당A'], year: 2026, month: 12, isLatest: true,
    crm: [crm({ date: '2026-10-01', sid: 'tx_z', amount: 3300000 })],
    lines: [],
    carryovers: [{
      id: 'c', base_sync_id: 'tx_z', origin_year: 2026, origin_month: 10, origin_note: '', settled: 3300000, paid_count: 1,
    }],
  })
  assert.deepEqual(plan.add, [])
  assert.deepEqual(plan.originUpdates, [])
})
