/**
 * 담당자 인센티브 정산 — 정산시트(구글 시트 + Apps Script)의 계산을 그대로 옮긴 순수 함수.
 *
 * 원본은 정산시트의 apps-script/Sync.gs 와 월 탭 수식이다.
 *   C 순매출   = ROUND(B / (1 + VAT), 0)
 *   E 인센티브 = ROUND((D가 비면 C, 아니면 D / (1 + VAT)) × F, 0)
 *   F 인센티브율: 비면 기본율, 숫자면 그 값, 글이면 MIXRATE(작업별 가중 평균)
 *   요약: H = ΣB, J = ΣE, M = I + J + K, N = M − O, O = 환수내역 L의 담당자·월 합계
 * 시트와 한 원이라도 달라지면 안 되므로 계산 순서 · 반올림 · 비고 문구를 바꾸지 않는다.
 * 금액은 정수 원, 나눗셈 · 비율 곱은 Decimal 로 한다.
 */
import Decimal from 'decimal.js'

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP })
type Dec = InstanceType<typeof Dec>

/** 구글 시트 ROUND(x, 0) — 0.5는 0에서 먼 쪽으로 */
const round0 = (x: Dec) => x.toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
/** 구글 시트 ROUNDDOWN(x, 0) — 0 쪽으로 버림 */
const roundDown0 = (x: Dec) => x.toDecimalPlaces(0, Decimal.ROUND_DOWN)

export type Fill = 'red' | 'yellow' | 'green' | null
export type LineKind = 'contract' | 'balance' | 'installment' | 'manual'

export interface IncentiveConfig {
  vatRate: number
  defaultRate: number
  defaultBase: number
  /** 완납으로 보는 CRM 입금상태 (설정 탭 "동기화 대상 입금상태") */
  fullStatuses: string[]
  /** 환수 계산의 지급률 */
  paidRate: number
  /** 진행률(%) 이상 → 인정 인센티브율(%) */
  tiers: { min: number; rate: number }[]
}

export const DEFAULT_CONFIG: IncentiveConfig = {
  vatRate: 0.1,
  defaultRate: 0.2,
  defaultBase: 2_000_000,
  fullStatuses: ['입금완료'],
  paidRate: 0.2,
  tiers: [
    { min: 0, rate: 5 }, { min: 30, rate: 5 }, { min: 50, rate: 10 }, { min: 70, rate: 15 }, { min: 100, rate: 20 },
  ],
}

/** 숫자 설정값을 Decimal 로 — 0.1 같은 값이 부동소수 오차 없이 들어가게 문자열을 거친다 */
const dec = (n: number | string) => new Dec(String(n))

/**
 * 이 달 정산표에 쓰는 설정 — 그 달에 담당자별 기본율을 남겼으면 설정의 기본 인센티브율 대신 쓴다.
 * F칸을 비운 줄과 작업별 구성의 나머지에 이 기본율이 들어간다 (환수 계산의 지급률 · 인정률은 그대로).
 */
export function monthConfig(cfg: IncentiveConfig, month: { default_rate?: number | string | null } | null | undefined): IncentiveConfig {
  const r = month?.default_rate
  return r === null || r === undefined ? cfg : { ...cfg, defaultRate: Number(r) }
}

/** 화면에 적은 % (5 · 5% · 12.5) → 비율 0.05. 빈칸은 null, 0~100 숫자가 아니면 undefined */
export function percentInput(raw: string): number | null | undefined {
  const t = raw.replace('%', '').trim()
  if (!t) return null
  if (!/^\d+(\.\d+)?$/.test(t)) return undefined
  const v = new Dec(t).div(100)
  return v.gt(1) ? undefined : v.toNumber()
}

// ── 표시용 (Apps Script comma_ · man_) ───────────────────────

/** 1234567 → "1,234,567" (Apps Script comma_) */
export function comma(n: number): string {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 1034000 → "103만원" (Apps Script man_ — 만원 단위 반올림) */
export function man(n: number): string {
  return comma(Math.round((Number(n) || 0) / 10000)) + '만원'
}

// ── F 인센티브율 ─────────────────────────────────────────────

export class RateError extends Error {}

export type RateSpec =
  | { kind: 'default' }
  | { kind: 'number'; value: Dec }
  | { kind: 'invalid'; message: string }
  | { kind: 'mix'; text: string }

const PERCENT = /^(-?\d+(?:\.\d+)?)%$/
const FRACTION = /^(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/
const PLAIN = /^-?\d+(?:\.\d+)?$/

/**
 * F칸 계산식 (=로 시작). 시트처럼 숫자 · % · + − × ÷ · 괄호를 계산한다.
 *   예) =230400/2700000, =((15500000*20%+14500000*15%)-3000000)/15000000
 */
export function evalFormula(src: string): Dec {
  const s = src.trim().replace(/^=/, '')
  let i = 0
  const peek = () => {
    while (i < s.length && /\s/.test(s[i])) i++
    return s[i]
  }
  const fail = (): never => { throw new RateError(`계산식을 읽을 수 없습니다: "${src.trim()}"`) }
  function expr(): Dec {
    let v = term()
    for (;;) {
      const c = peek()
      if (c === '+') { i++; v = v.plus(term()) }
      else if (c === '-' || c === '−') { i++; v = v.minus(term()) }
      else return v
    }
  }
  function term(): Dec {
    let v = unary()
    for (;;) {
      const c = peek()
      if (c === '*' || c === '×') { i++; v = v.times(unary()) }
      else if (c === '/' || c === '÷') {
        i++
        const d = unary()
        if (d.isZero()) throw new RateError('0으로 나눌 수 없습니다.')
        v = v.div(d)
      } else return v
    }
  }
  function unary(): Dec {
    const c = peek()
    if (c === '-' || c === '−') { i++; return unary().neg() }
    if (c === '+') { i++; return unary() }
    let v = primary()
    while (peek() === '%') { i++; v = v.div(100) }
    return v
  }
  function primary(): Dec {
    if (peek() === '(') {
      i++
      const v = expr()
      if (peek() !== ')') fail()
      i++
      return v
    }
    const m = /^\d+(?:\.\d+)?/.exec(s.slice(i))
    if (!m) return fail()
    i += m[0].length
    return dec(m[0])
  }
  const v = expr()
  if (peek() !== undefined) fail()
  return v
}

/**
 * 저장된 F 값 해석. 시트의 F칸과 같다.
 *   빈칸 → 기본율 / "20%" · "=230400/2700000" 같은 숫자·계산식 → 그 값 / 그 밖의 글 → MIXRATE
 */
export function parseRate(text: string | null | undefined): RateSpec {
  const s = (text ?? '').trim()
  if (!s) return { kind: 'default' }
  if (s.startsWith('=')) {
    try {
      return { kind: 'number', value: evalFormula(s) }
    } catch (e) {
      return { kind: 'invalid', message: e instanceof Error ? e.message : String(e) }
    }
  }
  const body = s.replace(/\s+/g, '')
  let m = body.match(PERCENT)
  if (m) return { kind: 'number', value: dec(m[1]).div(100) }
  m = body.match(FRACTION)
  if (m && Number(m[2]) !== 0) return { kind: 'number', value: dec(m[1]).div(dec(m[2])) }
  if (PLAIN.test(body)) return { kind: 'number', value: dec(body) }
  return { kind: 'mix', text: s }
}

/**
 * 화면에서 입력한 F 값을 저장 형태로 바꾼다.
 * 시트의 F열은 % 서식이라 20을 치면 20%가 되고 0.2를 쳐도 20%가 된다 — 같은 규칙을 쓴다.
 * "230400/2700000"처럼 = 없이 적은 나눗셈은 계산식으로 저장한다.
 * 계산식과 작업별 구성 글은 읽히는지 미리 확인한다 (읽을 수 없으면 RateError).
 */
export function normalizeRateInput(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  if (s.startsWith('=')) {
    evalFormula(s)
    return s
  }
  const body = s.replace(/\s+/g, '')
  if (PERCENT.test(body)) return body
  if (FRACTION.test(body)) {
    evalFormula(body)
    return '=' + body
  }
  if (PLAIN.test(body)) {
    const n = dec(body)
    const pct = n.abs().gte(1) ? n : n.times(100)
    return `${pct.toString()}%`
  }
  mixRate(s, 0, DEFAULT_CONFIG.defaultRate)
  return s
}

/** 인센티브율을 화면에 보이는 % 글로 (소수가 있으면 둘째 자리까지) */
export function formatRate(rate: Dec | number | null): string {
  if (rate === null) return ''
  const pct = dec(rate.toString()).times(100)
  return pct.isInteger() ? `${pct.toString()}%` : `${pct.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)}%`
}

const UNITS: Record<string, number> = { '억': 1e8, '천만': 1e7, '백만': 1e6, '만': 1e4 }

/**
 * 작업별로 인센티브율이 다른 건의 실제 인센티브율 (Apps Script MIXRATE 그대로).
 *   "C작업 1500만 10%"                      → 1500만원은 10%, 나머지(순매출 − 1500만)는 기본율
 *   "A 500만 20%, B 500만 20%, C 1500만 10%" → 적은 금액 비율대로
 *   금액은 공급가. 1500만 / 15,000,000 / 1500 (만원) 모두 가능
 */
export function mixRate(spec: string, net: number | Dec, defaultRate: number | Dec): Dec {
  const def = dec(defaultRate.toString())
  const total = dec((Number(net.toString()) || 0).toString())
  const parts = String(spec || '').split(/,(?!\d{3})|[\n/;]+/)
  let sumAmt = dec(0)
  let sumInc = dec(0)
  for (const raw of parts) {
    const p = raw.trim()
    if (!p) continue
    const rm = p.match(/(\d+(?:\.\d+)?)\s*%/)
    if (!rm) throw new RateError(`인센율(%)이 없습니다: "${p}"`)
    const rate = dec(rm[1]).div(100)
    const rest = p.replace(rm[0], ' ')
    // "2차작업 500만"처럼 이름에 숫자가 있어도 단위가 붙은(없으면 가장 큰) 숫자를 금액으로 본다
    const re = /(\d[\d,]*(?:\.\d+)?)\s*(억|천만|백만|만)?/g
    let m: RegExpExecArray | null
    let am: RegExpExecArray | null = null
    while ((m = re.exec(rest))) {
      if (!am || (m[2] && !am[2]) || (!!m[2] === !!am[2] &&
          Number(m[1].replace(/,/g, '')) > Number(am[1].replace(/,/g, '')))) am = m
    }
    if (!am) throw new RateError(`금액이 없습니다: "${p}"`)
    const n = dec(am[1].replace(/,/g, ''))
    let unit = UNITS[am[2] ?? ''] ?? 1
    if (unit === 1 && n.lt(100000)) unit = 1e4 // "1500"처럼 단위 없이 작은 숫자는 만원으로 본다
    const amt = n.times(unit)
    sumAmt = sumAmt.plus(amt)
    sumInc = sumInc.plus(amt.times(rate))
  }
  if (sumAmt.isZero()) return def
  const remain = total.minus(sumAmt)
  if (remain.gt(1)) {
    sumInc = sumInc.plus(remain.times(def))
    sumAmt = sumAmt.plus(remain)
  }
  return sumInc.div(sumAmt)
}

// ── 줄 계산 (C · E) ──────────────────────────────────────────

export interface LineAmounts {
  /** B 매출 (VAT 포함) */
  sales: number | null
  /** D 인센 기준 입금액 (VAT 포함). null = 빈칸 */
  paid: number | null
  /** F 인센티브율 (저장 형태) */
  rate: string | null
}

export interface LineCalc {
  /** C 순매출 */
  net: number | null
  /** E 인센티브 */
  incentive: number | null
  /** 실제로 쓴 인센티브율 */
  rate: Dec | null
  /** MIXRATE 를 읽지 못하면 시트처럼 E가 오류가 된다 */
  error: string | null
}

export function calcLine(line: LineAmounts, cfg: IncentiveConfig): LineCalc {
  if (line.sales === null) return { net: null, incentive: null, rate: null, error: null }
  const onePlusVat = dec(1).plus(dec(cfg.vatRate))
  const net = round0(dec(line.sales).div(onePlusVat))
  const basis = line.paid === null ? net : dec(line.paid).div(onePlusVat)
  const spec = parseRate(line.rate)
  let rate: Dec
  if (spec.kind === 'default') rate = dec(cfg.defaultRate)
  else if (spec.kind === 'number') rate = spec.value
  else if (spec.kind === 'invalid') return { net: net.toNumber(), incentive: null, rate: null, error: spec.message }
  else {
    try {
      rate = mixRate(spec.text, net, cfg.defaultRate)
    } catch (e) {
      return { net: net.toNumber(), incentive: null, rate: null, error: e instanceof Error ? e.message : String(e) }
    }
  }
  return { net: net.toNumber(), incentive: round0(basis.times(rate)).toNumber(), rate, error: null }
}

/**
 * D칸을 손으로 채워야 하는 줄 — 시트의 빨간 칸 조건부 서식과 같다.
 *   비고가 "[잔금]"으로 시작하고 D가 0(또는 빈칸) / "[분납]"으로 시작하고 D가 빈칸
 */
export function needsPaidInput(line: { note: string; paid: number | null }): boolean {
  const head = line.note.slice(0, 4)
  return (head === '[잔금]' && (line.paid ?? 0) === 0) || (head === '[분납]' && line.paid === null)
}

// ── 환수내역 ─────────────────────────────────────────────────

export interface ClawbackInput {
  /** D 환수액(직접입력) */
  direct_amount: number | null
  /** E 계약금액 (VAT 포함) */
  contract_amount: number | null
  /** H 진행률(%) */
  progress: number | null
}

export interface ClawbackCalc {
  /** F 공급가 */
  supply: number | null
  /** G 지급률 */
  paidRate: number | null
  /** I 인정률 (0.15 = 15%) */
  allowedRate: number | null
  /** J 지급액 */
  paidAmount: number | null
  /** K 인정액 */
  allowedAmount: number | null
  /** L 환수액(최종) */
  total: number
}

export function calcClawback(c: ClawbackInput, cfg: IncentiveConfig): ClawbackCalc {
  const direct = c.direct_amount
  if (c.contract_amount === null) {
    return { supply: null, paidRate: null, allowedRate: null, paidAmount: null, allowedAmount: null, total: direct ?? 0 }
  }
  const supply = round0(dec(c.contract_amount).div(dec(1).plus(dec(cfg.vatRate))))
  const progress = c.progress ?? 0 // N(H): 빈칸은 0
  const hits = cfg.tiers.filter((t) => t.min <= progress).map((t) => t.rate)
  const allowed = hits.length ? dec(Math.max(...hits)).div(100) : dec(0) // IFERROR(MAX(FILTER(...)),0)
  const paidAmount = roundDown0(supply.times(dec(cfg.paidRate)))
  const allowedAmount = roundDown0(supply.times(allowed))
  const computed = Decimal.max(0, paidAmount.minus(allowedAmount)).toNumber()
  return {
    supply: supply.toNumber(),
    paidRate: cfg.paidRate,
    allowedRate: allowed.toNumber(),
    paidAmount: paidAmount.toNumber(),
    allowedAmount: allowedAmount.toNumber(),
    total: direct ?? computed,
  }
}

// ── 월 요약 (H~O) ────────────────────────────────────────────

export interface MonthSummary {
  /** H 총 매출 */
  totalSales: number
  /** I 기본급 */
  baseSalary: number
  /** J 인센티브 */
  incentive: number
  /** K 특별수당 */
  special: number
  /** M 세전 급여 */
  gross: number
  /** O 환수(차감액) */
  clawback: number
  /** N 차감액 포함 */
  net: number
  /** E가 오류인 줄 수 — 시트라면 J2부터 오류가 된다 */
  errors: number
}

export function summarize(
  lines: LineAmounts[],
  month: { base_salary: number; special_allowance: number | null },
  clawbacks: ClawbackInput[],
  cfg: IncentiveConfig,
): MonthSummary {
  let totalSales = 0
  let incentive = 0
  let errors = 0
  for (const l of lines) {
    totalSales += l.sales ?? 0
    const c = calcLine(l, cfg)
    if (c.error) errors++
    incentive += c.incentive ?? 0
  }
  const clawback = clawbacks.reduce((s, c) => s + calcClawback(c, cfg).total, 0)
  const baseSalary = month.base_salary
  const special = month.special_allowance ?? 0
  const gross = baseSalary + incentive + special
  return { totalSales, baseSalary, incentive, special, gross, clawback, net: gross - clawback, errors }
}

// ── CRM 입금 현황 (Apps Script paymentOf_) ───────────────────

export interface CrmRow {
  /** CRM 시트 행 번호 (정렬용) */
  row: number
  /** YYYY-MM-DD */
  date: string
  name: string
  owner: string
  amount: number
  /** 입금상태 원문 */
  status: string
  sid: string
  memo: string
  /** CRM에 입금액 · 잔금 열이 있을 때만 (지금 결제시트에는 없다) */
  paidRaw?: number
  balanceRaw?: number
}

export type PaymentKind = 'full' | 'partial' | 'unpaid'

export function paymentOf(cfg: IncentiveConfig, r: CrmRow): { kind: PaymentKind; paid: number | null } {
  if (cfg.fullStatuses.includes(r.status)) return { kind: 'full', paid: r.amount }
  if (!r.status || r.status.includes('미입금')) return { kind: 'unpaid', paid: 0 }
  let paid: number
  const paidRaw = r.paidRaw ?? 0
  const balanceRaw = r.balanceRaw ?? 0
  if (paidRaw > 0) paid = paidRaw
  else if (balanceRaw > 0) paid = r.amount - balanceRaw
  else return { kind: 'partial', paid: null }
  paid = Math.max(0, Math.min(paid, r.amount))
  if (paid >= r.amount) return { kind: 'full', paid: r.amount }
  if (paid <= 0) return { kind: 'unpaid', paid: 0 }
  return { kind: 'partial', paid }
}

// ── 동기화 (Apps Script syncSheet_ · settledMap_ · balanceRows_) ──

export interface ExistingLine {
  id: string
  year: number
  month: number
  position: number
  sync_id: string | null
  sales: number | null
  paid: number | null
  note: string
}

export interface Carryover {
  id: string
  base_sync_id: string
  origin_year: number
  origin_month: number
  origin_note: string
  settled: number
  paid_count: number
}

export interface NewLine {
  client_name: string
  sales: number
  paid: number | null
  note: string
  sync_id: string
  crm_date: string
  kind: LineKind
  fill: Fill
}

export interface OriginUpdate {
  target: 'line' | 'carryover'
  id: string
  /** 스크립트가 쓴 비고일 때만 바꾼다 — 없으면 비고는 그대로 */
  note?: string
  fill: Fill
}

export interface SyncPlan {
  add: NewLine[]
  originUpdates: OriginUpdate[]
  stats: {
    candidates: number
    fresh: number
    kept: number
    unpaid: number
    partial: number
    balance: number
    install: number
    latest: boolean
  }
}

interface SettledEntry {
  settled: number
  paidCount: number
  origin: { target: 'line' | 'carryover'; id: string; year: number; month: number; note: string } | null
  /** 이 계약의 줄 ID — 같은 연·월 안에서 겹치지 않게 할 때 쓴다 */
  ids: { id: string; year: number; month: number }[]
}

export const baseSyncId = (id: string) => id.split('#')[0]
const ym = (year: number, month: number) => year * 100 + month

/**
 * 담당자의 모든 달에서 CRM 건별로 "이미 인센을 잡은 입금액"을 모은다.
 *   원래 줄(동기화ID 그대로): D가 있으면 D, 비어 있으면 B
 *   잔금 · 분납 줄(동기화ID#…): D
 * 앱으로 옮기기 전 달은 carryover 에 합계로 들어 있다.
 */
export function settledMap(lines: ExistingLine[], carryovers: Carryover[]): Map<string, SettledEntry> {
  const map = new Map<string, SettledEntry>()
  for (const c of carryovers) {
    map.set(c.base_sync_id, {
      settled: c.settled,
      paidCount: c.paid_count,
      origin: { target: 'carryover', id: c.id, year: c.origin_year, month: c.origin_month, note: c.origin_note },
      ids: [],
    })
  }
  const ordered = [...lines].sort((a, b) => ym(a.year, a.month) - ym(b.year, b.month) || a.position - b.position)
  for (const l of ordered) {
    if (!l.sync_id) continue
    const base = baseSyncId(l.sync_id)
    let e = map.get(base)
    if (!e) {
      e = { settled: 0, paidCount: 0, origin: null, ids: [] }
      map.set(base, e)
    }
    e.ids.push({ id: l.sync_id, year: l.year, month: l.month })
    let amt: number
    if (l.sync_id === base) {
      amt = l.paid ?? l.sales ?? 0
      e.origin = { target: 'line', id: l.id, year: l.year, month: l.month, note: l.note }
    } else {
      amt = l.paid ?? 0
    }
    e.settled += amt
    if (amt > 0) e.paidCount++
  }
  return map
}

/** CRM 새 건 → 입금 현황에 따라 D · 비고 · 색 (syncSheet_) */
function freshLine(cfg: IncentiveConfig, r: CrmRow): { line: NewLine; pay: PaymentKind } {
  const p = paymentOf(cfg, r)
  const line: NewLine = {
    client_name: r.name, sales: r.amount, paid: null, note: '', sync_id: r.sid, crm_date: r.date,
    kind: 'contract', fill: null,
  }
  if (p.kind === 'unpaid') {
    line.paid = 0
    line.note = '[미입금] 입금 시 인센 지급'
    line.fill = 'red'
  } else if (p.kind === 'partial' && p.paid === null) {
    line.paid = 0 // 입금액을 적기 전까지 인센 0, D칸은 빨간색
    line.note = '[잔금] D열에 입금액 입력 → 그 금액만큼 인센 선지급'
    line.fill = 'yellow'
  } else if (p.kind === 'partial' && p.paid !== null) {
    line.paid = p.paid
    line.note = `[잔금] 선입금 ${man(p.paid)} 인센 선지급 · 잔금 ${man(r.amount - p.paid)} 미입금`
    line.fill = 'yellow'
  }
  return { line, pay: p.kind }
}

/**
 * 원래 줄 비고를 스크립트 문구로 바꿀 때 사람이 붙여 둔 "[N월 확인] …" 메모는 뒤에 남긴다.
 * 시트 스크립트는 비고 전체를 덮어써서 확인 메모까지 지웠다 — 정산 금액과는 상관없고
 * 확인할 일을 잃지 않으려고 이것만 다르게 한다.
 */
export function keepCheckMemo(next: string, prev: string): string {
  const at = prev.search(/\[\d{1,2}월 확인\]/)
  return at < 0 ? next : `${next} · ${prev.slice(at)}`
}

/** 전에 덜 받았던 건 중 추가 입금된 금액 → (잔금) 줄, 아직 잔금 처리 요망인 건 → (분납) 줄 (balanceRows_) */
function balanceRows(args: {
  cfg: IncentiveConfig
  aliases: string[]
  year: number
  month: number
  crm: CrmRow[]
  settled: Map<string, SettledEntry>
}): { rows: NewLine[]; originUpdates: OriginUpdate[] } {
  const { cfg, aliases, year, month, crm, settled } = args
  const rows: NewLine[] = []
  const originUpdates: OriginUpdate[] = []

  for (const r of crm) {
    if (!aliases.includes(r.owner)) continue
    const e = settled.get(r.sid)
    if (!e || !e.origin) continue // 아직 어느 달에도 안 들어온 건은 대상 아님
    const o = e.origin
    // 환불 처리한 건: 매출을 줄여 둔 것이지 잔금이 남은 게 아니므로 뺀다
    if (/^\[환불\]/.test(o.note)) continue
    const sameMonthIds = e.ids.filter((x) => x.year === year && x.month === month).map((x) => x.id)
    const p = paymentOf(cfg, r)

    if (p.paid === null) {
      // 아직 "잔금 처리 요망"인 건 → 계약 달 이후 최근 달마다 (분납) 줄을 하나씩 만들어 그 달 입금액을 적게 한다
      if (ym(o.year, o.month) >= ym(year, month)) continue // 계약 달에는 원래 줄 D칸에 적는다
      const prefix = `${r.sid}#${month}`
      if (sameMonthIds.some((x) => x === prefix || x.startsWith(prefix + '_'))) continue
      rows.push({
        client_name: `${r.name} (분납)`,
        sales: 0,
        paid: null, // 비워 두면 빨간 칸 → 이번 달 입금액 입력 (안 들어왔으면 0)
        note: `[분납] ${o.month}월 계약 · ${e.paidCount + 1}회차 · ${month}월 입금액을 D열에 입력(없으면 0) · ` +
          `누적 ${man(e.settled)} / ${man(r.amount)}`,
        sync_id: prefix,
        crm_date: r.date,
        kind: 'installment',
        fill: 'yellow',
      })
      if (/^\[미입금\]/.test(o.note)) {
        originUpdates.push({
          target: o.target, id: o.id, note: keepCheckMemo('[분납중] 최근 월 탭 (분납) 행에 입금액 입력', o.note), fill: 'yellow',
        })
      }
      continue
    }

    const diff = Math.round(p.paid - e.settled)
    if (diff <= 0) continue
    let id = `${r.sid}#${month}`
    for (let k = 2; sameMonthIds.includes(id); k++) id = `${r.sid}#${month}_${k}`
    const left = r.amount - p.paid
    rows.push({
      client_name: `${r.name} (잔금)`,
      sales: 0, // 매출은 원래 달에 이미 잡혀 있으므로 0
      paid: diff,
      note: `[잔금 정산] ${o.month}월 계약 · 추가 입금 ${man(diff)} 인센` + (left > 0 ? ` · 잔금 ${man(left)} 남음` : ''),
      sync_id: id,
      crm_date: r.date,
      kind: 'balance',
      fill: 'green',
    })

    // 원래 줄 표시 갱신 (스크립트가 적은 비고일 때만 문구를 고친다)
    const auto = !o.note || /^\[(미입금|잔금|분납중)\]/.test(o.note)
    if (left <= 0) {
      originUpdates.push({
        target: o.target, id: o.id, note: auto ? keepCheckMemo(`[완납] ${month}월 탭에서 잔금 인센 정산`, o.note) : undefined, fill: 'green',
      })
    } else {
      originUpdates.push({
        target: o.target, id: o.id,
        note: auto ? keepCheckMemo(`[잔금] ${month}월 추가 입금 ${man(diff)} 정산 · 잔금 ${man(left)} 미입금`, o.note) : undefined,
        fill: 'yellow',
      })
    }
  }
  return { rows, originUpdates }
}

/**
 * 한 담당자 · 한 달 동기화 계획 (syncSheet_).
 *   1) CRM에서 그 담당자 · 그 달 건 중 아직 이 달에 없는 동기화ID를 순서대로 추가
 *   2) 가장 최근 달이면 잔금 · 분납 줄을 뒤에 붙인다
 * 이미 있는 줄은 사람이 고친 값이므로 건드리지 않는다 (원래 줄의 비고 · 색 표시만 바뀐다).
 */
export function planSync(args: {
  cfg: IncentiveConfig
  aliases: string[]
  year: number
  month: number
  crm: CrmRow[]
  /** 이 담당자의 모든 달 줄 */
  lines: ExistingLine[]
  carryovers: Carryover[]
  /** 이 담당자의 가장 최근 달인지 — 잔금 · 분납 줄은 여기에만 */
  isLatest: boolean
}): SyncPlan {
  const { cfg, aliases, year, month, crm, lines, carryovers, isLatest } = args
  const wanted = crm
    .filter((r) => Number(r.date.slice(0, 4)) === year && Number(r.date.slice(5, 7)) === month && aliases.includes(r.owner))
    .sort((a, b) => a.date.localeCompare(b.date) || a.row - b.row)
  const have = new Set(lines.filter((l) => l.year === year && l.month === month && l.sync_id).map((l) => l.sync_id))
  const fresh = wanted.filter((r) => !have.has(r.sid)).map((r) => freshLine(cfg, r))

  // 잔금 정산은 이번에 새로 들어오는 줄을 빼고 계산한다 (시트도 쓰기 전에 읽는다)
  const bal = isLatest
    ? balanceRows({ cfg, aliases, year, month, crm, settled: settledMap(lines, carryovers) })
    : { rows: [], originUpdates: [] }

  const add: NewLine[] = [...fresh.map((f) => f.line), ...bal.rows]
  return {
    add,
    originUpdates: bal.originUpdates,
    stats: {
      candidates: wanted.length,
      fresh: fresh.length,
      kept: wanted.length - fresh.length,
      unpaid: fresh.filter((l) => l.pay === 'unpaid').length,
      partial: fresh.filter((l) => l.pay === 'partial').length,
      balance: bal.rows.filter((l) => l.kind === 'balance').length,
      install: bal.rows.filter((l) => l.kind === 'installment').length,
      latest: isLatest,
    },
  }
}

/** 동기화 결과 한 줄 요약 (Apps Script short 메시지) */
export function syncShort(s: SyncPlan['stats']): string {
  return `새로 ${s.fresh}건 추가 (기존 ${s.kept}건 유지)` +
    (s.unpaid || s.partial ? ` · 미입금 ${s.unpaid} / 잔금 ${s.partial}` : '') +
    (s.balance ? ` · 잔금 정산 ${s.balance}건` : '') +
    (s.install ? ` · 분납 입력 ${s.install}건` : '') +
    (s.latest ? '' : ' (잔금 정산 · 분납은 가장 최근 달에서만 처리)')
}
