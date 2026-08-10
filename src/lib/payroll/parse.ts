/**
 * 세무사 회신 급여장부 붙여넣기 파서
 *
 * 세무사가 보내온 사업소득지급대장에서 표 영역을 그대로 복사해 붙여넣으면
 * (엑셀 복사 = 탭 구분 텍스트) 직원별 세액·차인지급액을 읽어낸다.
 *
 * 양식은 직원 1명당 2행이고 병합 셀 때문에 아랫줄 성명이 비어 있다.
 *   홍길동 | 2026.08 | 600,000   |           | 18,000 | 1,800 | 580,200    ← 기본급 줄
 *          | 2026.08 |           |           |        |       |            ← (병합 여백)
 *   김철수 | 2026.08 | 3,000,000 | 2,000,000 | 60,000 | 6,000 | 1,934,000  ← 기본급 줄
 *          | 2026.08 |           | 1,000,000 | 30,000 | 3,000 |   967,000  ← 인센티브 줄
 *
 * 컬럼은 헤더 키워드로 찾고, 헤더를 못 찾으면 양식 기본 위치로 되돌린다.
 * 결과는 항상 미리보기로 확인시킨 뒤 반영한다 — 자동으로 덮어쓰지 않는다.
 */

import { findSimilar } from '@/lib/utils/levenshtein'

export interface ParsedRow {
  /** 붙여넣은 원본 이름 */
  rawName: string
  /** 매칭된 직원 id (못 찾으면 null) */
  employeeId: string | null
  matchedName: string | null
  /** 이름이 정확히 일치하지 않고 유사도로 추정된 경우 */
  fuzzy: boolean
  base: number
  baseIncomeTax: number
  baseLocalTax: number
  incentive: number
  incentiveIncomeTax: number
  incentiveLocalTax: number
  employerInsurance: number
}

export interface ParseResult {
  rows: ParsedRow[]
  warnings: string[]
}

interface ColumnMap {
  name: number
  gross: number
  split: number
  incomeTax: number
  localTax: number
  net: number
  insurance: number
}

/** 양식 기본 컬럼 위치 (헤더를 못 찾았을 때) */
const FALLBACK: ColumnMap = { name: 1, gross: 4, split: 5, incomeTax: 6, localTax: 7, net: 8, insurance: -1 }

/** 귀속년월(2026.08) 같은 날짜 표기 — 금액으로 읽으면 안 된다 */
const DATE_LIKE = /^\d{4}[.\-/]\d{1,2}([.\-/]\d{1,2})?$/

function toNumber(cell: string | undefined): number {
  if (!cell) return 0
  const cleaned = cell.replace(/[,\s₩원]/g, '')
  if (DATE_LIKE.test(cleaned)) return 0
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return 0
  return Math.round(Number(cleaned))
}

function normalize(s: string): string {
  return s.replace(/\s/g, '')
}

/**
 * 엑셀에서 복사한 표를 셀 격자로 만든다.
 * 줄바꿈이 들어 있는 셀("지급액\n(세전급여)" 같은 머리글)은 엑셀이 큰따옴표로 감싸서
 * 클립보드에 넣으므로, 단순 줄 분리로는 표가 깨진다. 따옴표 안의 줄바꿈·탭은 셀 내용으로 취급한다.
 */
function splitClipboardTable(text: string): string[][] {
  const s = text.replace(/\r\n?/g, '\n')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++ } // 이스케이프된 따옴표
        else inQuotes = false
      } else cell += ch
      continue
    }
    if (ch === '"' && cell === '') { inQuotes = true; continue }
    if (ch === '\t') { row.push(cell); cell = ''; continue }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue }
    cell += ch
  }
  row.push(cell)
  rows.push(row)

  return rows
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some((c) => c !== ''))
}

/** 헤더 2행을 합쳐 컬럼 위치를 찾는다. */
function detectColumns(grid: string[][]): { map: ColumnMap; headerRow: number } | null {
  for (let r = 0; r < Math.min(grid.length, 12); r++) {
    const joined = grid[r].map(normalize)
    if (!joined.some((c) => c.includes('소득세'))) continue

    // 헤더가 2행에 걸쳐 있으므로 다음 행 라벨도 같은 컬럼으로 합쳐 본다
    const next = (grid[r + 1] ?? []).map(normalize)
    const label = (c: number) => `${joined[c] ?? ''}${next[c] ?? ''}`

    const map: ColumnMap = { ...FALLBACK }
    let found = 0
    for (let c = 0; c < Math.max(joined.length, next.length); c++) {
      const l = label(c)
      if (!l) continue
      // 순서 중요 — "차인지급액(세후급여)"가 /지급액/에 먼저 걸리면 안 되고,
      // "지방소득세"가 /소득세/에 먼저 걸려도 안 된다. 좁은 패턴부터 검사한다.
      if (/성명|이름/.test(l)) { map.name = c; found++ }
      else if (/귀속|지급년월|연월/.test(l)) { /* 날짜 컬럼 — 금액이 아니므로 매핑하지 않는다 */ }
      else if (/4대보험|사대보험|회사부담|사업주부담/.test(l)) { map.insurance = c; found++ }
      else if (/차인지급|세후|실지급/.test(l)) { map.net = c; found++ }
      else if (/지방소득세|지방세/.test(l)) { map.localTax = c; found++ }
      else if (/소득세|원천징수/.test(l)) { map.incomeTax = c; found++ }
      else if (/기본급|인센티브/.test(l)) { map.split = c; found++ }
      else if (/지급액|세전|총지급/.test(l)) { map.gross = c; found++ }
    }
    if (found >= 3) return { map, headerRow: r }
  }
  return null
}

export function parseLedgerPaste(
  text: string,
  employees: { id: string; name: string }[]
): ParseResult {
  const warnings: string[] = []

  const grid = splitClipboardTable(text)
  if (grid.length === 0) return { rows: [], warnings: ['붙여넣은 내용이 없습니다.'] }

  const detected = detectColumns(grid)
  if (!detected) warnings.push('헤더를 찾지 못해 양식 기본 컬럼 위치로 읽었습니다. 미리보기를 꼭 확인해주세요.')
  const map = detected?.map ?? FALLBACK
  const startRow = detected ? detected.headerRow + 2 : 0

  const nameSet = new Map(employees.map((e) => [normalize(e.name), e]))
  const rows: ParsedRow[] = []
  const seen = new Set<string>()

  for (let r = startRow; r < grid.length; r++) {
    const cells = grid[r]
    const rawName = (cells[map.name] ?? '').trim()
    if (!rawName) continue
    if (/^(총\s*계|합\s*계|계)$/.test(normalize(rawName))) continue

    // 이름 매칭: 정확 일치 → 유사도
    const exact = nameSet.get(normalize(rawName))
    let employeeId: string | null = exact?.id ?? null
    let matchedName: string | null = exact?.name ?? null
    let fuzzy = false
    if (!employeeId) {
      const [best] = findSimilar(rawName, employees, 1, 0.6)
      if (best) {
        employeeId = best.id
        matchedName = best.name
        fuzzy = true
        warnings.push(`"${rawName}" → "${best.name}" 으로 추정했습니다. 확인해주세요.`)
      } else {
        warnings.push(`"${rawName}" 은 등록된 직원과 매칭되지 않아 건너뜁니다.`)
        continue
      }
    }

    if (employeeId && seen.has(employeeId)) {
      warnings.push(`"${matchedName}" 이 두 번 나옵니다. 첫 번째 행만 반영합니다.`)
      continue
    }

    // 기본급 줄
    const gross = toNumber(cells[map.gross])
    const splitBase = toNumber(cells[map.split])
    const baseIncomeTax = toNumber(cells[map.incomeTax])
    const baseLocalTax = toNumber(cells[map.localTax])
    const employerInsurance = map.insurance >= 0 ? toNumber(cells[map.insurance]) : 0

    // 다음 줄이 같은 직원의 인센티브 줄인지 판단 (성명 비어 있고 금액이 있음)
    const next = grid[r + 1] ?? []
    const nextName = (next[map.name] ?? '').trim()
    const nextSplit = toNumber(next[map.split])
    const isIncentiveLine = !nextName && nextSplit > 0

    const incentive = isIncentiveLine ? nextSplit : 0
    const incentiveIncomeTax = isIncentiveLine ? toNumber(next[map.incomeTax]) : 0
    const incentiveLocalTax = isIncentiveLine ? toNumber(next[map.localTax]) : 0

    // 기본급: 분리 표기가 있으면 그 값, 없으면 지급액 전체가 기본급
    const base = splitBase > 0 ? splitBase : Math.max(0, gross - incentive)

    rows.push({
      rawName, employeeId, matchedName, fuzzy,
      base, baseIncomeTax, baseLocalTax,
      incentive, incentiveIncomeTax, incentiveLocalTax,
      employerInsurance,
    })
    seen.add(employeeId)
    if (isIncentiveLine) r++
  }

  if (rows.length === 0) warnings.push('읽어낼 수 있는 직원 행이 없습니다. 표 머리글부터 총계까지 함께 복사해보세요.')

  return { rows, warnings }
}
