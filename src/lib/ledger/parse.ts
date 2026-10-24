/**
 * 통장·카드 내역 파일 파서 (서버 전용 — 업로드 API에서 호출)
 *
 * 통장: 하나은행 거래내역 CSV (cp949, 최신순)
 *   거래일시, 보낸분/받는분, 출금액(원), 입금액(원), 잔액(원), 내 통장 표시, 적요, 처리점, 구분
 * 카드: KB국민 법인카드 승인내역조회 XLS (헤더 1행)
 *   승인일(YYYY.MM.DD), 승인시간, 카드번호, 가맹점명, 업종명, 승인금액, 부가세, 승인구분, 승인번호, 상태 …
 *   해외 승인금액은 "$240.65" 문자열, 취소는 음수 금액의 별도 행
 */
import { createHash } from 'node:crypto'

export interface ParsedBankTx {
  tx_at: string          // ISO (KST 오프셋 포함)
  tx_date: string        // YYYY-MM-DD
  seq: number
  counterparty: string
  memo: string
  kind: string
  branch: string
  withdrawal: number
  deposit: number
  balance: number
  cancelled: boolean
  row_hash: string
}

export interface ParsedCardTx {
  approved_at: string
  approved_date: string
  card_last4: string
  merchant: string
  industry: string
  amount_krw: number | null
  amount_foreign: number | null
  vat: number
  status: string
  approval_no: string
  is_check_card: boolean
  row_hash: string
}

const hash = (parts: (string | number)[]) => createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)

/** "1,234" · "1234" · "" → 정수 원 */
function toWon(s: string | undefined): number {
  const t = (s ?? '').replace(/[,\s]/g, '')
  if (!t) return 0
  if (!/^-?\d+$/.test(t)) throw new Error(`금액 형식 오류: "${s}"`)
  return Number(t)
}

/** 따옴표·쉼표 포함 CSV 한 줄 */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"') q = false
      else cur += c
    } else if (c === '"') q = true
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out
}

function decodeKorean(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  // UTF-8 BOM 이면 UTF-8, 아니면 은행 기본(cp949). WHATWG 'euc-kr' 디코더는 cp949 확장까지 처리한다
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('euc-kr').decode(bytes)
  }
}

export function parseBankCsv(buf: ArrayBuffer): { rows: ParsedBankTx[]; errors: string[] } {
  const lines = decodeKorean(buf).split(/\r?\n/).filter((l) => l.trim())
  const header = splitCsvLine(lines[0]).map((h) => h.trim())
  const col = (name: string) => {
    const i = header.findIndex((h) => h.startsWith(name))
    if (i < 0) throw new Error(`통장 CSV에 "${name}" 열이 없습니다 — 하나은행 거래내역 CSV인지 확인해 주세요`)
    return i
  }
  const C = {
    at: col('거래일시'), who: col('보낸분/받는분'), out: col('출금액'), in: col('입금액'), bal: col('잔액'),
    memo: col('내 통장 표시'), kind: col('적요'), branch: col('처리점'), flag: col('구분'),
  }
  const errors: string[] = []
  const parsed: Omit<ParsedBankTx, 'seq' | 'row_hash'>[] = []
  for (let i = 1; i < lines.length; i++) {
    const v = splitCsvLine(lines[i])
    const at = (v[C.at] ?? '').trim()
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(at)) { errors.push(`${i + 1}행: 거래일시 형식 오류 "${at}"`); continue }
    const flag = (v[C.flag] ?? '').replace(/　/g, '').trim()
    const kind = (v[C.kind] ?? '').trim()
    try {
      const row = {
        tx_at: `${at.replace(' ', 'T')}+09:00`,
        tx_date: at.slice(0, 10),
        counterparty: (v[C.who] ?? '').trim(),
        memo: (v[C.memo] ?? '').trim(),
        kind,
        branch: (v[C.branch] ?? '').trim(),
        withdrawal: toWon(v[C.out]),
        deposit: toWon(v[C.in]),
        balance: toWon(v[C.bal]),
        cancelled: flag === '취소' || flag === '취소된거래',
      }
      // 계좌 개설 행(신규, 0원)은 거래가 아니다
      if (row.withdrawal === 0 && row.deposit === 0) continue
      parsed.push(row)
    } catch (e) {
      errors.push(`${i + 1}행: ${(e as Error).message}`)
    }
  }
  // 파일은 최신순 — 오래된 순으로 뒤집어 순번을 매긴다. 같은 초에 여러 건이 있어도 잔액이 달라 해시가 겹치지 않는다
  parsed.reverse()
  // 순번 = 초 단위 시각 × 1000 + 같은 초 안에서의 순서. 급여 일괄 이체처럼 같은 초에 수십 건이 몰려도 순서가 유지된다
  const sameSecond = new Map<string, number>()
  const rows = parsed.map((r) => {
    const rank = sameSecond.get(r.tx_at) ?? 0
    sameSecond.set(r.tx_at, rank + 1)
    return {
      ...r,
      seq: (Date.parse(r.tx_at) / 1000) * 1000 + rank,
      row_hash: hash(['bank', r.tx_at, r.counterparty, r.withdrawal, r.deposit, r.balance]),
    }
  })
  return { rows, errors }
}

/** 잔액 연속성 — 앞 거래 잔액 ± 이번 거래 = 이번 잔액 인지 확인. 끊긴 위치를 돌려준다 */
export function checkBalanceChain(rows: Pick<ParsedBankTx, 'tx_at' | 'withdrawal' | 'deposit' | 'balance'>[]) {
  const breaks: { at: string; expected: number; actual: number }[] = []
  for (let i = 1; i < rows.length; i++) {
    const expected = rows[i - 1].balance + rows[i].deposit - rows[i].withdrawal
    if (expected !== rows[i].balance) breaks.push({ at: rows[i].tx_at, expected, actual: rows[i].balance })
  }
  return breaks
}

export async function parseCardXls(buf: ArrayBuffer): Promise<{ rows: ParsedCardTx[]; errors: string[] }> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: true })
  const errors: string[] = []
  const rows: ParsedCardTx[] = []
  const need = ['승인일', '승인시간', '카드번호', '가맹점명', '승인금액', '상태']
  if (data.length && need.some((k) => !(k in data[0]))) {
    throw new Error(`카드 파일에 ${need.filter((k) => !(k in data[0])).join(', ')} 열이 없습니다 — KB 승인내역조회 엑셀인지 확인해 주세요`)
  }
  data.forEach((r, i) => {
    const day = String(r['승인일']).trim().replace(/\./g, '-')
    const time = String(r['승인시간']).trim() || '00:00:00'
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { errors.push(`${i + 2}행: 승인일 형식 오류 "${r['승인일']}"`); return }
    const rawAmt = r['승인금액']
    let amount_krw: number | null = null
    let amount_foreign: number | null = null
    if (typeof rawAmt === 'number') {
      amount_krw = Math.round(rawAmt)
    } else {
      const s = String(rawAmt).replace(/[,\s]/g, '')
      const mUsd = /^(-?)\$(\d+(?:\.\d{1,2})?)$/.exec(s) ?? /^\$(-)(\d+(?:\.\d{1,2})?)$/.exec(s)
      if (mUsd) amount_foreign = Number(`${mUsd[1]}${mUsd[2]}`)
      else if (/^-?\d+$/.test(s)) amount_krw = Number(s)
      else { errors.push(`${i + 2}행: 승인금액 형식 오류 "${rawAmt}"`); return }
    }
    const card = String(r['카드번호'] ?? '')
    const approvalNo = String(r['승인번호'] ?? '')
    rows.push({
      approved_at: `${day}T${time}+09:00`,
      approved_date: day,
      card_last4: card.slice(-4),
      merchant: String(r['가맹점명'] ?? '').trim(),
      industry: String(r['업종명'] ?? '').trim(),
      amount_krw,
      amount_foreign,
      vat: Math.round(Number(r['부가세'] || 0)),
      status: String(r['상태'] ?? '').trim(),
      approval_no: approvalNo,
      is_check_card: false,
      row_hash: hash(['card', day, time, card, approvalNo, String(rawAmt), String(r['상태'] ?? '')]),
    })
  })
  return { rows, errors }
}
