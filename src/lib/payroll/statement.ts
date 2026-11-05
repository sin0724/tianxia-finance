/**
 * 세무사 명세서 파서 — 엑셀·PDF에서 뽑은 표(Grid)를 직원별 최종 금액으로 바꾼다.
 *
 * 앱은 급여를 계산하지 않는다. 명세서 금액이 그대로 최종 금액이고, 여기서는 잘못 읽지 않았는지만 검증한다.
 *   · 행 검산: 지급액 − 공제 = 차인지급액
 *   · 파일 검산: 읽은 합계 = 파일의 총계 행
 *   · 귀속월: 파일에 적힌 귀속이 고른 달과 다르면 막는다 (예: 10월 귀속 = 11월 지급)
 *
 * 지원 양식
 *   business  사업소득지급대장 — 직원 1명 2행, 윗줄 기본급·아랫줄 인센티브
 *   insured   4대보험 급여대장 — 직원 1명 1행 이상의 표, 또는 직원별 급여명세서
 */

import { findSimilar } from '@/lib/utils/levenshtein'

export type Grid = string[][]
export type StatementKind = 'business' | 'insured'

export const STATEMENT_KIND_LABEL: Record<StatementKind, string> = {
  business: '3.3% 사업소득',
  insured: '4대보험 급여',
}

export interface StatementSheet {
  name: string
  grid: Grid
}

export interface StatementRow {
  rawName: string
  base: number
  incentive: number
  baseIncomeTax: number
  baseLocalTax: number
  incentiveIncomeTax: number
  incentiveLocalTax: number
  /** 근로자부담 4대보험 등 세금 외 공제 */
  otherDeductions: number
  /** 파일에 회사부담이 없으면 0 — 정산이 통장 납부액으로 추정한다 */
  employerInsurance: number
  net: number
}

export interface Attribution {
  year: number
  month: number
  /** 파일에 귀속이라고 명시된 경우. "11월 지급", "10월분" 처럼 미루어 본 값은 false */
  sure: boolean
}

export interface ParsedStatement {
  kind: StatementKind
  sheetName: string
  rows: StatementRow[]
  /** 있으면 확정할 수 없다 */
  errors: string[]
  warnings: string[]
  attribution: Attribution | null
  fileTotal: { gross: number; net: number } | null
}

const norm = (s: string | undefined) => (s ?? '').replace(/\s/g, '')

/** 금액 칸이면 정수, 아니면 null. 2026.10 같은 귀속년월은 금액이 아니다 */
function amountOf(cell: string | undefined): number | null {
  const cleaned = (cell ?? '').replace(/[,\s₩원]/g, '')
  if (!/^-?\d+(\.0+)?$/.test(cleaned)) return null
  return Math.round(Number(cleaned))
}

const money = (cell: string | undefined) => amountOf(cell) ?? 0
const won = (n: number) => `${n.toLocaleString('ko-KR')}원`

const LABEL = {
  name: /^(성명|이름|사원명|직원명|소득자(성명)?)$/,
  net: /차인지급|차감지급|실지급|실수령|세후/,
  deduction: /공제합계|공제총액|공제액계|공제계|총공제/,
  gross: /지급합계|지급총액|총지급|급여합계|급여총액|지급액계|지급계|지급액|세전/,
  localTax: /지방소득세|주민세|지방세/,
  incomeTax: /소득세|갑근세/,
  employer: /회사부담|사업주부담|사업자부담/,
  split: /기본급|인센티브/,
} as const

const SUMMARY_NAME = /^(총계|합계|소계|계|누계)$|(합|총|소)계$|인원/

/** 명세서에서 직원 이름으로 볼 수 있는 칸 — 머리글·합계·사번은 제외 */
const isPersonName = (cell: string) => {
  const n = norm(cell)
  return /^[가-힣a-zA-Z]{2,20}$/.test(n) && !SUMMARY_NAME.test(n) && !LABEL.name.test(n)
}

const hasInsuredTerms = (text: string) => /국민연금|건강보험|고용보험|공제합계|장기요양/.test(text)

// ── 귀속월 ─────────────────────────────────────────────────

const PERIOD = String.raw`(\d{4})\s*[년.\-/]\s*(\d{1,2})`

function attributionOf(sheet: StatementSheet, kind: StatementKind): Attribution | null {
  const top = sheet.grid.slice(0, 12).map((r) => r.filter(Boolean).join(' ')).join('\n')
  const at = (m: RegExpExecArray, sure: boolean): Attribution => ({ year: Number(m[1]), month: Number(m[2]), sure })

  const stated = new RegExp(String.raw`귀속[^\d\n]{0,8}${PERIOD}`).exec(top)
    ?? new RegExp(String.raw`${PERIOD}\s*월?\s*귀속`).exec(top)
  if (stated) return at(stated, true)

  if (kind === 'business') {
    // 대장의 귀속년월 칸: 2026.10 또는 2026.10.
    const cell = sheet.grid.flat().map(norm).find((c) => /^\d{4}\.\d{1,2}\.?$/.test(c))
    const m = cell ? /^(\d{4})\.(\d{1,2})/.exec(cell) : null
    if (m) return at(m, true)
  }

  const portion = new RegExp(String.raw`${PERIOD}\s*월?\s*분`).exec(top)
  if (portion) return at(portion, false)

  const paid = new RegExp(String.raw`지급[^\d\n]{0,8}${PERIOD}`).exec(top)
    ?? /(\d{2,4})\s*년\s*(\d{1,2})\s*월\s*지급/.exec(`${sheet.name}\n${top}`)
  if (paid) {
    const year = Number(paid[1]) < 100 ? 2000 + Number(paid[1]) : Number(paid[1])
    const month = Number(paid[2])
    return month === 1 ? { year: year - 1, month: 12, sure: false } : { year, month: month - 1, sure: false }
  }
  return null
}

// ── 사업소득지급대장 ───────────────────────────────────────

interface BusinessColumns { name: number; gross: number; split: number; incomeTax: number; localTax: number; net: number }

function businessColumns(grid: Grid): { cols: BusinessColumns; start: number } | null {
  for (let r = 0; r < Math.min(grid.length, 30); r++) {
    const top = grid[r].map(norm)
    if (!top.some((c) => LABEL.incomeTax.test(c)) || !top.some((c) => /성명|이름/.test(c))) continue

    const next = (grid[r + 1] ?? []).map(norm)
    const cols: Partial<BusinessColumns> = {}
    for (let c = 0; c < Math.max(top.length, next.length); c++) {
      const l = `${top[c] ?? ''}${next[c] ?? ''}`
      // 좁은 패턴부터 — "차인지급액"이 지급액에, "지방소득세"가 소득세에 먼저 걸리면 안 된다
      if (/성명|이름/.test(l)) cols.name ??= c
      else if (/귀속|주민/.test(l)) continue
      else if (LABEL.net.test(l)) cols.net ??= c
      else if (LABEL.localTax.test(l)) cols.localTax ??= c
      else if (LABEL.incomeTax.test(l)) cols.incomeTax ??= c
      else if (LABEL.split.test(l)) cols.split ??= c
      else if (LABEL.gross.test(l)) cols.gross ??= c
    }
    const { name, gross, split, incomeTax, localTax, net } = cols
    if (name === undefined || gross === undefined || incomeTax === undefined || localTax === undefined || net === undefined) continue
    return { cols: { name, gross, split: split ?? -1, incomeTax, localTax, net }, start: r + 2 }
  }
  return null
}

function parseBusiness(grid: Grid) {
  const found = businessColumns(grid)
  if (!found) return null
  const { cols, start } = found

  const rows: StatementRow[] = []
  const errors: string[] = []
  let fileTotal: ParsedStatement['fileTotal'] = null
  const claimed = new Set<number>()

  const nameAt = (r: number) => (grid[r]?.[cols.name] ?? '').trim()
  // 기본급·세액·차인지급액이 적힌 줄. PDF는 세로 병합 칸이 가운데 줄에 찍혀서 이름 줄과 어긋날 수 있다
  const isDetail = (r: number) => {
    const c = grid[r]
    return !!c && [cols.split, cols.incomeTax, cols.localTax, cols.net].some((k) => k >= 0 && money(c[k]) !== 0)
  }

  for (let r = start; r < grid.length; r++) {
    const name = nameAt(r)
    const label = norm(grid[r].join(''))
    if (/^(NO)?(총|합)계/.test(label)) {
      fileTotal = { gross: money(grid[r][cols.gross]), net: money(grid[r][cols.net]) }
      continue
    }
    if (!isPersonName(name)) continue

    const before = r > start && !nameAt(r - 1) && !claimed.has(r - 1) && isDetail(r - 1) ? r - 1 : null
    const nextOwnsIt = isPersonName(nameAt(r + 2)) && !isDetail(r + 2) // PDF에서 다음 직원의 윗줄인 경우
    const after = !nameAt(r + 1) && isDetail(r + 1) && !nextOwnsIt ? r + 1 : null
    const lines = [before, r, after].filter((x): x is number => x !== null)
    lines.forEach((l) => claimed.add(l))

    const gross = lines.reduce((s, l) => s + money(grid[l][cols.gross]), 0)
    const upper = lines.find((l) => l <= r && isDetail(l)) ?? null
    const lower = lines.find((l) => l > r && isDetail(l)) ?? null
    const cell = (line: number | null, col: number) => (line === null || col < 0 ? 0 : money(grid[line][col]))

    const incentive = cell(lower, cols.split)
    const splitBase = cell(upper, cols.split)
    const base = splitBase > 0 ? splitBase : Math.max(0, gross - incentive)
    const row: StatementRow = {
      rawName: name, base, incentive,
      baseIncomeTax: cell(upper, cols.incomeTax), baseLocalTax: cell(upper, cols.localTax),
      incentiveIncomeTax: cell(lower, cols.incomeTax), incentiveLocalTax: cell(lower, cols.localTax),
      otherDeductions: 0, employerInsurance: 0,
      net: cell(upper, cols.net) + cell(lower, cols.net),
    }
    if (gross === 0 && row.net === 0) continue // 양식에 이름만 남은 무지급 직원

    if (base + incentive !== gross) errors.push(`${name}: 기본급+인센티브 ${won(base + incentive)}이 지급액 ${won(gross)}과 다릅니다.`)
    rows.push(row)
  }
  return { rows, errors, fileTotal }
}

// ── 4대보험 급여대장 (표) ──────────────────────────────────

interface Slot { col: number; offset: number }
type InsuredKey = 'name' | 'gross' | 'deduction' | 'net' | 'incomeTax' | 'localTax' | 'employer'

/** 머리글이 여러 줄로 쌓인 양식이 많아 라벨마다 (열, 몇 번째 줄)을 찾는다. 예: 지급합계 / 공제합계 가 같은 열 */
function insuredSlots(grid: Grid): { slots: Partial<Record<InsuredKey, Slot>>; start: number } | null {
  for (let r = 0; r < Math.min(grid.length, 40); r++) {
    if (!grid[r].some((c) => LABEL.name.test(norm(c)))) continue

    const headerRows = [grid[r]]
    for (let k = 1; k < 4 && grid[r + k]; k++) {
      if (grid[r + k].some((c) => (amountOf(c) ?? 0) >= 1000)) break
      headerRows.push(grid[r + k])
    }

    const slots: Partial<Record<InsuredKey, Slot>> = {}
    const put = (key: InsuredKey, slot: Slot) => { slots[key] ??= slot }
    headerRows.forEach((row, offset) => row.forEach((raw, col) => {
      const l = norm(raw)
      if (!l || /d/.test(l)) return
      if (LABEL.name.test(l)) put('name', { col, offset })
      else if (LABEL.employer.test(l)) put('employer', { col, offset })
      else if (LABEL.net.test(l)) put('net', { col, offset })
      else if (LABEL.deduction.test(l)) put('deduction', { col, offset })
      else if (LABEL.localTax.test(l)) put('localTax', { col, offset })
      else if (LABEL.incomeTax.test(l)) put('incomeTax', { col, offset })
      else if (LABEL.gross.test(l)) put('gross', { col, offset })
    }))

    if (slots.name && slots.gross && (slots.net || slots.deduction)) return { slots, start: r + headerRows.length }
  }
  return null
}

function parseInsuredTable(grid: Grid) {
  const found = insuredSlots(grid)
  if (!found) return null
  const { slots, start } = found
  const name = slots.name as Slot

  const nameRows: number[] = []
  for (let r = start; r < grid.length; r++) if (isPersonName(grid[r][name.col] ?? '')) nameRows.push(r)

  // 이름 줄 간격이 곧 직원 1명의 줄 수다
  const gaps = nameRows.slice(1).map((r, i) => r - nameRows[i]).filter((g) => g > 0)
  const height = gaps.length > 0 ? Math.min(...gaps) : 1
  const at = (blockTop: number, slot: Slot | undefined) => {
    if (!slot) return undefined
    return grid[blockTop + (height > 1 ? slot.offset % height : 0)]?.[slot.col]
  }
  const topOf = (nameRow: number) => nameRow - (height > 1 ? name.offset % height : 0)

  const rows: StatementRow[] = []
  const errors: string[] = []
  for (const nameRow of nameRows) {
    const top = topOf(nameRow)
    const rawName = grid[nameRow][name.col].trim()
    const gross = amountOf(at(top, slots.gross))
    if (gross === null) { errors.push(`${rawName}: 지급합계를 읽지 못했습니다.`); continue }

    const net = amountOf(at(top, slots.net))
    const deduction = amountOf(at(top, slots.deduction))
    const row = insuredRow(rawName, gross, deduction, net, money(at(top, slots.incomeTax)), money(at(top, slots.localTax)), money(at(top, slots.employer)))
    if (row) rows.push(row)
    else errors.push(`${rawName}: 공제합계·차인지급액을 읽지 못했습니다.`)
  }

  let fileTotal: ParsedStatement['fileTotal'] = null
  for (let r = start; r < grid.length; r++) {
    if (!grid[r].slice(0, name.col + 2).some((c) => SUMMARY_NAME.test(norm(c)))) continue
    const top = height > 1 ? r - (name.offset % height) : r
    const gross = amountOf(at(top, slots.gross)) ?? amountOf(grid[r][(slots.gross as Slot).col])
    const net = amountOf(at(top, slots.net))
    if (gross !== null && net !== null) fileTotal = { gross, net }
  }
  return { rows, errors, fileTotal }
}

function insuredRow(
  rawName: string, gross: number, deduction: number | null, net: number | null,
  incomeTax: number, localTax: number, employerInsurance: number,
): StatementRow | null {
  const totalDeduction = deduction ?? (net === null ? null : gross - net)
  if (totalDeduction === null) return null
  return {
    rawName, base: gross, incentive: 0,
    baseIncomeTax: incomeTax, baseLocalTax: localTax, incentiveIncomeTax: 0, incentiveLocalTax: 0,
    otherDeductions: totalDeduction - incomeTax - localTax,
    employerInsurance,
    net: net ?? gross - totalDeduction,
  }
}

// ── 직원별 급여명세서 ──────────────────────────────────────

const PERSON_GROSS = /지급합계|지급총액|총지급액?|급여합계|급여총액|지급액계|지급계/

const labelledAmount = (text: string, label: RegExp) => {
  const m = new RegExp(String.raw`(?:${label.source})[^\d\n-]{0,12}(-?[\d,]+)`).exec(text)
  return m ? amountOf(m[1]) : null
}

/** 표 없이 "성명 홍길동 … 지급합계 3,000,000" 처럼 직원마다 따로 적힌 양식 */
function parsePerPerson(grid: Grid) {
  const lines = grid.map((r) => r.filter(Boolean).join(' '))
  const heads = lines.flatMap((l, i) => {
    const m = /(?:성\s*명|이\s*름)\s*[:：]?\s*([가-힣]{2,10})/.exec(l)
    return m ? [{ line: i, name: m[1] }] : []
  })
  if (heads.length === 0) return null

  const rows: StatementRow[] = []
  const errors: string[] = []
  heads.forEach(({ line, name }, i) => {
    const text = lines.slice(line, heads[i + 1]?.line ?? lines.length).join('\n')
    const gross = labelledAmount(text, PERSON_GROSS)
    if (gross === null) { errors.push(`${name}: 지급합계를 읽지 못했습니다.`); return }
    const row = insuredRow(
      name, gross, labelledAmount(text, LABEL.deduction), labelledAmount(text, LABEL.net),
      labelledAmount(text, /(?<!지방)소득세|갑근세/) ?? 0, labelledAmount(text, LABEL.localTax) ?? 0, labelledAmount(text, LABEL.employer) ?? 0,
    )
    if (row) rows.push(row)
    else errors.push(`${name}: 공제합계·차인지급액을 읽지 못했습니다.`)
  })
  return { rows, errors, fileTotal: null }
}

// ── 공통 ───────────────────────────────────────────────────

const AMOUNT_KEYS = [
  'base', 'incentive', 'baseIncomeTax', 'baseLocalTax', 'incentiveIncomeTax', 'incentiveLocalTax',
  'otherDeductions', 'employerInsurance', 'net',
] as const

export const deductionsOf = (r: StatementRow) =>
  r.baseIncomeTax + r.baseLocalTax + r.incentiveIncomeTax + r.incentiveLocalTax + r.otherDeductions

export const grossOf = (r: StatementRow) => r.base + r.incentive

/** 같은 사람이 두 줄로 나오는 대장이 있다. 총계에 둘 다 들어가므로 합친다 */
function mergeSameName(rows: StatementRow[], warnings: string[]) {
  const merged = new Map<string, StatementRow>()
  for (const r of rows) {
    const key = norm(r.rawName)
    const seen = merged.get(key)
    if (!seen) { merged.set(key, { ...r }); continue }
    for (const k of AMOUNT_KEYS) seen[k] += r[k]
    warnings.push(`${r.rawName}: 파일에 여러 번 나와 금액을 합쳤습니다.`)
  }
  return [...merged.values()]
}

function parseSheet(sheet: StatementSheet): ParsedStatement | null {
  const kind: StatementKind = hasInsuredTerms(sheet.grid.flat().join(' ')) ? 'insured' : 'business'
  const body = kind === 'business'
    ? parseBusiness(sheet.grid)
    : parseInsuredTable(sheet.grid) ?? parsePerPerson(sheet.grid)
  if (!body || (body.rows.length === 0 && body.errors.length === 0)) return null

  const errors = [...body.errors]
  const warnings: string[] = []
  for (const r of body.rows) {
    const expected = grossOf(r) - deductionsOf(r)
    if (expected !== r.net) errors.push(`${r.rawName}: 지급액−공제 ${won(expected)}이 차인지급액 ${won(r.net)}과 다릅니다.`)
  }

  const rows = mergeSameName(body.rows, warnings)

  if (body.fileTotal) {
    const gross = rows.reduce((s, r) => s + grossOf(r), 0)
    const net = rows.reduce((s, r) => s + r.net, 0)
    if (gross !== body.fileTotal.gross) errors.push(`읽은 지급액 합계 ${won(gross)}이 파일 총계 ${won(body.fileTotal.gross)}과 다릅니다.`)
    if (net !== body.fileTotal.net) errors.push(`읽은 차인지급액 합계 ${won(net)}이 파일 총계 ${won(body.fileTotal.net)}과 다릅니다.`)
  }

  return {
    kind, sheetName: sheet.name, rows, errors, warnings,
    attribution: attributionOf(sheet, kind), fileTotal: body.fileTotal,
  }
}

/** 선택한 달(귀속)의 시트를 골라 읽는다. 한 파일에 여러 달 시트가 있어도 귀속이 맞는 시트만 쓴다 */
export function parseStatement(sheets: StatementSheet[], year: number, month: number): ParsedStatement | null {
  const parsed = sheets.map(parseSheet).filter((p): p is ParsedStatement => p !== null)
  if (parsed.length === 0) return null

  const isTarget = (a: Attribution | null) => a?.year === year && a.month === month
  const chosen = parsed.find((p) => isTarget(p.attribution))
  if (chosen) return chosen

  if (parsed.length > 1) {
    const [first] = parsed
    return {
      ...first, rows: [],
      errors: [`이 파일에는 ${month}월 귀속 시트가 없습니다. 시트: ${parsed.map((p) => p.sheetName).join(', ')}`],
    }
  }

  const [only] = parsed
  const a = only.attribution
  if (!a) return { ...only, warnings: [...only.warnings, `파일에서 귀속월을 찾지 못했습니다. ${month}월 귀속이 맞는지 확인해 주세요.`] }
  const text = `파일은 ${a.year}년 ${a.month}월 귀속${a.sure ? '' : '으로 보입니다'}. 지금 고른 달은 ${year}년 ${month}월입니다.`
  return a.sure ? { ...only, errors: [text, ...only.errors] } : { ...only, warnings: [...only.warnings, text] }
}

/** 이름으로 직원을 찾는다. 정확히 같지 않으면 추정으로 표시해 사람이 확인하게 한다 */
export function matchEmployee<E extends { id: string; name: string }>(rawName: string, employees: E[]) {
  const exact = employees.find((e) => norm(e.name) === norm(rawName))
  if (exact) return { employeeId: exact.id, fuzzy: false }
  const [best] = findSimilar(rawName, employees, 1, 0.6)
  return best ? { employeeId: best.id, fuzzy: true } : { employeeId: null, fuzzy: false }
}
