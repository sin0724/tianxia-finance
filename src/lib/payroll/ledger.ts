/**
 * 사업소득지급대장 생성 — `(주)티엔샤 사업소득지급대장양식.xls` 양식 재현
 *
 * 양식 구조 (직원 1명 = 2행)
 *   A: NO           B: 성명        C: 주민등록번호(공란)   D: 귀속년월 / 지급년월
 *   E: 지급액(세전)  F: 기본급 / 인센티브                  G: 소득세
 *   H: 지방소득세    I: 차인지급액(세후)                    J: 합계 차인지급액
 *
 *   · 인센티브가 없는 직원 → A~I 전부 세로 병합, F는 공란, 세액은 한 줄에
 *   · 인센티브가 있는 직원 → A·B·C·E·J만 병합, F/G/H/I는 윗줄 기본급·아랫줄 인센티브로 분리
 *   · 마지막 총계 행은 A~D를 한 블록으로 병합
 */

export interface LedgerEntry {
  name: string
  /** 기본급 (세전) */
  base: number
  /** 기본급분 소득세 */
  baseIncomeTax: number
  /** 기본급분 지방소득세 */
  baseLocalTax: number
  /** 인센티브 (세전, 차감액 반영 후) */
  incentive: number
  /** 인센티브분 소득세 */
  incentiveIncomeTax: number
  /** 인센티브분 지방소득세 */
  incentiveLocalTax: number
}

const HEADER_ROW = 4 // 0-indexed: 5행
const DATA_ROW = 6 // 0-indexed: 7행

type Merge = { s: { c: number; r: number }; e: { c: number; r: number } }

const COL_WIDTHS = [7.71, 12.29, 12.29, 8.57, 11.86, 10.29, 15.71, 10.29, 10.29, 11]

export async function buildBusinessIncomeLedger(
  year: number,
  month: number,
  entries: LedgerEntry[]
): Promise<{ blob: Blob; filename: string }> {
  const XLSX = await import('xlsx')

  const ym = `${year}.${String(month).padStart(2, '0')}`
  const rows: (string | number | null)[][] = []
  const merges: Merge[] = []

  // ── 상단 제목부 ────────────────────────────────────────────
  rows[0] = [ym, null, null, '사업소득지급대장']
  merges.push({ s: { c: 0, r: 0 }, e: { c: 1, r: 0 } })
  merges.push({ s: { c: 3, r: 0 }, e: { c: 8, r: 0 } })
  rows[1] = []
  rows[2] = ['회사명:(주)티엔샤']
  rows[3] = []

  // ── 헤더 (2행) ─────────────────────────────────────────────
  rows[HEADER_ROW] = [
    'NO', '성   명', '주민등록번호', '귀속년월',
    '지급액\n(세전급여)', '기본급', '소득세', '지방소득세', '차인지급액\n(세후급여)',
  ]
  rows[HEADER_ROW + 1] = [null, null, null, '지급년월', null, '인센티브']
  for (const c of [0, 1, 2, 4, 6, 7, 8]) {
    merges.push({ s: { c, r: HEADER_ROW }, e: { c, r: HEADER_ROW + 1 } })
  }

  // ── 직원별 2행 ─────────────────────────────────────────────
  const total = { gross: 0, split: 0, incomeTax: 0, localTax: 0, net: 0 }

  entries.forEach((e, i) => {
    const r = DATA_ROW + i * 2
    const gross = e.base + e.incentive
    const baseNet = e.base - e.baseIncomeTax - e.baseLocalTax
    const incNet = e.incentive - e.incentiveIncomeTax - e.incentiveLocalTax
    const hasIncentive = e.incentive > 0

    if (hasIncentive) {
      // 기본급 줄 / 인센티브 줄로 분리, J열에 합계 차인지급액
      rows[r] = [i + 1, e.name, null, ym, gross, e.base, e.baseIncomeTax, e.baseLocalTax, baseNet, baseNet + incNet]
      rows[r + 1] = [null, null, null, ym, null, e.incentive, e.incentiveIncomeTax, e.incentiveLocalTax, incNet]
      for (const c of [0, 1, 2, 4, 9]) merges.push({ s: { c, r }, e: { c, r: r + 1 } })
      total.split += e.base + e.incentive
    } else {
      // 한 줄만 값이 있고 전 컬럼 세로 병합
      rows[r] = [i + 1, e.name, null, ym, gross, null, e.baseIncomeTax, e.baseLocalTax, baseNet]
      rows[r + 1] = [null, null, null, ym]
      for (const c of [0, 1, 2, 4, 5, 6, 7, 8]) merges.push({ s: { c, r }, e: { c, r: r + 1 } })
    }

    total.gross += gross
    total.incomeTax += e.baseIncomeTax + e.incentiveIncomeTax
    total.localTax += e.baseLocalTax + e.incentiveLocalTax
    total.net += baseNet + incNet
  })

  // ── 총계 ───────────────────────────────────────────────────
  const totalRow = DATA_ROW + entries.length * 2
  rows[totalRow] = [
    '총   계', null, null, null,
    total.gross, total.split || null, total.incomeTax, total.localTax, total.net,
  ]
  rows[totalRow + 1] = []
  merges.push({ s: { c: 0, r: totalRow }, e: { c: 3, r: totalRow + 1 } })
  for (const c of [4, 5, 6, 7, 8]) merges.push({ s: { c, r: totalRow }, e: { c, r: totalRow + 1 } })

  // 빈 행을 null로 채워야 aoa_to_sheet가 행을 건너뛰지 않는다
  for (let i = 0; i <= totalRow + 1; i++) if (!rows[i]) rows[i] = []

  const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: false })
  ws['!merges'] = merges
  ws['!cols'] = COL_WIDTHS.map((wch) => ({ wch }))

  // 금액 칸에 천 단위 콤마 서식 적용
  for (let r = DATA_ROW; r <= totalRow + 1; r++) {
    for (let c = 4; c <= 9; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })]
      if (cell && typeof cell.v === 'number') cell.z = '#,##0'
    }
  }

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, `${String(year).slice(2)}년 ${month}월`)

  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
  return {
    blob: new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    filename: `(주)티엔샤 사업소득지급대장_${year}년${String(month).padStart(2, '0')}월.xlsx`,
  }
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
