/**
 * CRM 결제시트 → 인센티브 정산용 줄 (정산시트 Apps Script readCrm_ 그대로).
 *
 *   - 1행 머리글을 접두어로 찾는다: 날짜 · 상호명 · 담당자 · 금액 · 입금상태 · 동기화ID
 *     (입금액/선입금/계약금, 잔금/잔여/미수 열이 생기면 잔금 건 선입금 계산에 쓴다)
 *   - 상호명 · 담당자 · 날짜가 있고 금액 > 0 인 줄만, "-" · "1" 줄은 뺀다
 *   - 입금상태는 원문 그대로 둔다 (완납 판정은 설정의 완납 상태와 정확히 같은지로 한다)
 * 정산은 CRM을 읽기만 한다. 동기화ID가 비어 있는 줄은 고르지 않고 따로 알려 준다
 * (ID는 결제 내역의 시트 동기화가 M열에 적는다).
 */
import type { CrmRow } from './engine'

export interface CrmGrid {
  rows: CrmRow[]
  /** 정산 대상인데 동기화ID가 비어 있는 줄 */
  missingSid: { row: number; date: string; name: string; owner: string; amount: number }[]
}

const pad = (n: number) => String(n).padStart(2, '0')

/** 시트 날짜 일련번호 → YYYY-MM-DD */
function serialToDate(serial: number): string {
  const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** Apps Script parseDate_ — 날짜 칸, "2026-11-03" · "2026.11.3" · "2026. 11. 3", 연도 없는 "11/3" */
export function parseCrmDate(v: unknown, year: number): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return serialToDate(v)
  const s = String(v ?? '').trim()
  if (!s) return null
  let m = s.match(/^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})/)
  if (m) return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`
  m = s.match(/^(\d{1,2})[-./](\d{1,2})$/)
  if (m) return `${year}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`
  return null
}

/** Apps Script parseAmount_ — 숫자는 그대로, 글이면 콤마를 빼고 첫 숫자 */
export function parseCrmAmount(v: unknown): number {
  if (typeof v === 'number') return v
  const m = String(v ?? '').replace(/,/g, '').match(/-?\d+(\.\d+)?/)
  return m ? Number(m[0]) : 0
}

export function parseCrmGrid(grid: unknown[][], year: number): CrmGrid {
  const head = (grid[0] ?? []).map((v) => String(v ?? '').trim())
  const col = (prefix: string) => head.findIndex((h) => h !== '' && h.startsWith(prefix))
  const firstCol = (prefixes: string[]) => {
    for (const p of prefixes) {
      const c = col(p)
      if (c >= 0) return c
    }
    return -1
  }
  const idx = {
    date: col('날짜'),
    name: col('상호명'),
    owner: col('담당자'),
    amount: col('금액'),
    status: col('입금상태'),
    memo: firstCol(['작업내용', '특이사항', '메모']),
    sid: col('동기화ID'),
    paid: firstCol(['입금액', '선입금', '계약금']),
    balance: firstCol(['잔금', '잔여', '미수']),
  }
  for (const k of ['date', 'name', 'owner', 'amount', 'status'] as const) {
    if (idx[k] < 0) throw new Error(`CRM 결제시트 1행에서 "${k}"에 해당하는 머리글을 찾지 못했습니다.`)
  }
  if (idx.sid < 0) throw new Error('CRM 결제시트에 동기화ID 열이 없습니다. 결제 내역에서 시트 동기화를 먼저 실행해 주세요.')

  const cell = (r: unknown[], i: number) => (i >= 0 ? r[i] : undefined)
  const rows: CrmRow[] = []
  const missingSid: CrmGrid['missingSid'] = []
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i] ?? []
    const name = String(cell(r, idx.name) ?? '').trim()
    const owner = String(cell(r, idx.owner) ?? '').trim()
    const date = parseCrmDate(cell(r, idx.date), year)
    const amount = parseCrmAmount(cell(r, idx.amount))
    if (!name || !owner || !date || !(amount > 0)) continue
    if (name === '-' || name === '1' || owner === '-' || owner === '1') continue
    const sid = String(cell(r, idx.sid) ?? '').trim()
    if (!sid) {
      missingSid.push({ row: i + 1, date, name, owner, amount })
      continue
    }
    rows.push({
      row: i + 1,
      date,
      name,
      owner,
      amount,
      status: String(cell(r, idx.status) ?? '').trim(),
      sid,
      memo: String(cell(r, idx.memo) ?? '').trim(),
      paidRaw: idx.paid >= 0 ? parseCrmAmount(cell(r, idx.paid)) : 0,
      balanceRaw: idx.balance >= 0 ? parseCrmAmount(cell(r, idx.balance)) : 0,
    })
  }
  return { rows, missingSid }
}
