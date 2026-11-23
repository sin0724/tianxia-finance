import { google } from 'googleapis'
import type { sheets_v4 } from 'googleapis'
import { appendNoteLine, replaceNoteLine } from '@/lib/payments/deposit-note'

export type PaymentStatus = '입금완료' | '잔금 처리 요망' | '미입금' | '추가계약'

export type SheetRow = {
  rowIndex: number       // 시트 내 실제 행 번호 (1-based)
  syncId: string         // M열에 기록된 고유 동기화 ID — tx_ 형식일 때만 인정 (없으면 '')
  idCellOccupied: boolean // M열에 ID가 아닌 다른 내용이 있어 기록 불가
  date: string           // YYYY-MM-DD (B열)
  clientName: string     // 상호명 (C열)
  representative: string // 대표자 (D열)
  phone: string          // 전화번호 (E열)
  manager: string        // 담당자 (F열)
  amount: number         // 금액 (G열)
  memo: string           // 특이사항 (H열)
  status: PaymentStatus  // 입금상태 (I열)
}

/** 동기화 ID를 기록하는 열 — A(체크박스)·J(계산서)·K(메모)는 팀이 사용 중이라 여유를 두고 M열 사용 */
const SYNC_ID_COLUMN = 'M'
const SYNC_ID_HEADER = '동기화ID (수정금지)'
/** 입금상태 열 — 값은 드롭다운, 셀 메모에는 입금 기록 줄 */
const STATUS_COLUMN = 'I'

function getSheetsClient(readonly: boolean): { sheets: sheets_v4.Sheets; sheetId: string; sheetName: string } {
  const credentialsRaw = process.env.GOOGLE_SHEETS_CREDENTIALS
  const sheetId = process.env.GOOGLE_SHEETS_ID
  const sheetName = process.env.GOOGLE_SHEETS_SHEET_NAME ?? 'Sheet1'

  if (!credentialsRaw || !sheetId) {
    throw new Error('GOOGLE_SHEETS_CREDENTIALS 또는 GOOGLE_SHEETS_ID 환경변수가 설정되지 않았습니다.')
  }

  const credentials = JSON.parse(credentialsRaw)
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [readonly
      ? 'https://www.googleapis.com/auth/spreadsheets.readonly'
      : 'https://www.googleapis.com/auth/spreadsheets'],
  })

  return { sheets: google.sheets({ version: 'v4', auth }), sheetId, sheetName }
}

/**
 * 시트 컬럼 구조: B=날짜 C=상호명 D=대표자 E=전화번호 F=담당자 G=금액 H=특이사항 I=입금상태 M=동기화ID(자동 기록)
 * A(체크박스)·J(계산서)·K(수기 메모)는 팀이 사용 중이므로 건드리지 않는다.
 * fromDate 이후 데이터만 반환. M열 ID는 앱이 write-back하며 사용자는 건드리지 않는다.
 */
export async function fetchSheetRows(fromDate = '2026-04-01'): Promise<SheetRow[]> {
  const { sheets, sheetId, sheetName } = getSheetsClient(true)

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${sheetName}!B2:${SYNC_ID_COLUMN}`,  // B열(날짜)부터 M열(동기화 ID)까지, 헤더 제외
  })

  const rows = response.data.values ?? []
  const cutoff = fromDate

  return rows
    .map((row, idx) => {
      // B=row[0], C=row[1], D=row[2], E=row[3], F=row[4], G=row[5], H=row[6], I=row[7], ..., M=row[11]
      const rawDate = String(row[0] ?? '').trim()
      const rawAmount = String(row[5] ?? '').trim().replace(/,/g, '').replace(/[^\d.-]/g, '')
      const amount = parseFloat(rawAmount)

      if (!rawDate || isNaN(amount) || amount <= 0) return null

      const date = parseDate(rawDate)
      if (!date) return null

      if (date < cutoff) return null

      const status = normalizeStatus(String(row[7] ?? '').trim())

      // ID 셀에 tx_ 형식이 아닌 값이 있으면 무시하고 덮어쓰지도 않는다 (사용자 데이터 보호)
      const rawIdCell = String(row[11] ?? '').trim()
      const isValidId = /^tx_/.test(rawIdCell)

      return {
        rowIndex: idx + 2,
        syncId: isValidId ? rawIdCell : '',
        idCellOccupied: !!rawIdCell && !isValidId,
        date,
        clientName: String(row[1] ?? '').trim(),
        representative: String(row[2] ?? '').trim(),
        phone: String(row[3] ?? '').trim(),
        manager: String(row[4] ?? '').trim(),
        amount,
        memo: String(row[6] ?? '').trim(),
        status,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null) as SheetRow[]
}

/**
 * 결제시트 전체를 서식 없는 원래 값으로 읽는다 (1행 머리글 포함, 읽기 전용).
 * 날짜 칸은 일련번호(1899-12-30부터 일수), 숫자 칸은 숫자로 온다 —
 * 인센티브 정산시트의 Apps Script가 읽던 값과 같은 형태라 정산 계산에 그대로 쓴다.
 */
export async function fetchSheetGrid(): Promise<unknown[][]> {
  const { sheets, sheetId, sheetName } = getSheetsClient(true)
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${sheetName}!A1:Z`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER',
  })
  return (response.data.values ?? []) as unknown[][]
}

/**
 * 동기화 ID를 시트 M열에 기록 (write-back).
 * 이후에는 상호명·금액·메모를 수정해도 같은 행으로 인식되어 중복 집계가 발생하지 않는다.
 * 서비스 계정에 시트 편집 권한이 필요하다. M열은 시트에서 숨김 처리해도 무방하다.
 */
export async function writeBackSyncIds(entries: { rowIndex: number; syncId: string }[]): Promise<void> {
  if (entries.length === 0) return
  const { sheets, sheetId, sheetName } = getSheetsClient(false)

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        // 헤더도 함께 유지 — 열의 용도를 시트에서 알 수 있게
        { range: `${sheetName}!${SYNC_ID_COLUMN}1`, values: [[SYNC_ID_HEADER]] },
        ...entries.map((e) => ({
          range: `${sheetName}!${SYNC_ID_COLUMN}${e.rowIndex}`,
          values: [[e.syncId]],
        })),
      ],
    },
  })
}

/** 새 동기화 ID 생성 — 행 내용과 무관한 불변 ID */
export function makeSyncId(): string {
  return `tx_${crypto.randomUUID()}`
}

/**
 * 시트 맨 아래에 결제 행을 추가하고 M열에 동기화 ID까지 기록한다 (`/결제` 슬래시 커맨드용).
 *
 * ID를 함께 남기는 것이 핵심이다. 앱이 payments 에 external_id = syncId 로 저장해두면
 * 이후 sync-sheets 가 이 행을 읽어도 "이미 있는 건"으로 인식해 중복 생성하지 않는다.
 *
 * A(체크박스)·J(계산서)·K(메모)는 팀이 쓰는 열이라 건드리지 않고 B~I 만 쓴다.
 * D(대표자)·E(전화번호)는 폼에서 받지 않으므로 빈 값으로 둔다.
 */
export async function appendSheetRow(row: {
  date: string          // YYYY-MM-DD (B)
  clientName: string    // 상호명 (C)
  representative: string // 대표자 (D)
  phone: string         // 전화번호 (E)
  manager: string       // 담당자 (F)
  amount: number        // 금액 (G)
  memo: string          // 작업내용 및 특이사항 (H)
  status: PaymentStatus // 입금상태 (I)
}): Promise<{ rowIndex: number; syncId: string }> {
  const { sheets, sheetId, sheetName } = getSheetsClient(false)
  const syncId = makeSyncId()

  // values.append 를 쓰지 않는 이유:
  //   시트 아래쪽에는 팀이 미리 서식·드롭다운(입금상태·계산서)을 깔아둔 빈 행이 이어져 있다.
  //   append 는 그 빈 행들 "다음"에 새 행을 만들어버려서, 데이터가 빈 줄 뭉치 아래로 떨어지고
  //   드롭다운 서식도 못 받는다. 그래서 마지막 데이터 행 바로 다음 칸을 직접 찾아 채운다.
  const scan = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${sheetName}!B2:G`,
  })
  const scanned = scan.data.values ?? []

  // 날짜(B)·상호명(C)·금액(G) 중 하나라도 있으면 실제 데이터가 있는 행으로 본다.
  // 중간의 빈 줄은 건너뛰지 않고 항상 "마지막 데이터 행 다음"에 쓴다 —
  // 팀이 일부러 비워둔 구분 행을 덮어쓰지 않기 위해서다.
  let lastDataOffset = -1
  for (let i = 0; i < scanned.length; i++) {
    const r = scanned[i] ?? []
    const hasData = [r[0], r[1], r[5]].some((c) => String(c ?? '').trim() !== '')
    if (hasData) lastDataOffset = i
  }
  const rowIndex = lastDataOffset + 2 + 1 // 배열 0 = 시트 2행

  // USER_ENTERED — 금액이 숫자로 들어가야 팀이 시트에서 쓰는 합계·정렬이 그대로 동작한다.
  // 날짜는 시트 로케일(ko_KR)에 따라 "2026. 8. 10." 로 표시되는데 parseDate 가 이 형식을 읽는다.
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${sheetName}!B${rowIndex}:I${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        row.date, row.clientName, row.representative, row.phone,
        row.manager, row.amount, row.memo, row.status,
      ]],
    },
  })

  await writeBackSyncIds([{ rowIndex, syncId }])

  // 미리 깔아둔 드롭다운 행이 바닥나면 새 행에 입금상태·계산서 드롭다운이 없다 — 위 행에서 복사해 온다.
  // 드롭다운은 부가 기능이라 실패해도 결제 등록 자체는 성공으로 둔다.
  try {
    await ensureDropdowns(rowIndex, rowIndex)
  } catch (err) {
    console.error('[appendSheetRow] 드롭다운 복사 실패:', err)
  }

  return { rowIndex, syncId }
}

/** 드롭다운을 유지해야 하는 열 — I(입금상태)·J(계산서) */
const DROPDOWN_COLUMNS = ['I', 'J'] as const

/**
 * fromRow~toRow 의 I·J열에 드롭다운이 없으면, 그 위에서 드롭다운이 있는 가장 가까운 행의 것을 복사한다.
 * 목록을 코드에 박지 않고 시트에서 복사하므로 팀이 시트에서 선택지·색을 바꿔도 그대로 따라간다.
 * 셀 값은 건드리지 않는다 (PASTE_DATA_VALIDATION).
 */
export async function ensureDropdowns(fromRow: number, toRow: number): Promise<void> {
  const { sheets, sheetId, sheetName } = getSheetsClient(false)
  const scanFrom = Math.max(2, fromRow - 200)

  const res = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    ranges: [`${sheetName}!I${scanFrom}:J${toRow}`],
    includeGridData: true,
    fields: 'sheets(properties(sheetId),data(startRow,rowData.values.dataValidation))',
  })
  const sheet = res.data.sheets?.[0]
  const gid = sheet?.properties?.sheetId
  const grid = sheet?.data?.[0]
  if (gid == null || !grid) return

  const startRow = (grid.startRow ?? scanFrom - 1) + 1 // 1-based
  const rowData = grid.rowData ?? []
  const hasDv = (row: number, col: number) => !!rowData[row - startRow]?.values?.[col]?.dataValidation

  const requests: sheets_v4.Schema$Request[] = []
  DROPDOWN_COLUMNS.forEach((letter, col) => {
    const colIndex = letter.charCodeAt(0) - 'A'.charCodeAt(0)
    let source = -1
    for (let r = fromRow - 1; r >= startRow; r--) {
      if (hasDv(r, col)) { source = r; break }
    }
    if (source < 0) return

    for (let r = fromRow; r <= toRow; r++) {
      if (hasDv(r, col)) continue
      requests.push({
        copyPaste: {
          source: { sheetId: gid, startRowIndex: source - 1, endRowIndex: source, startColumnIndex: colIndex, endColumnIndex: colIndex + 1 },
          destination: { sheetId: gid, startRowIndex: r - 1, endRowIndex: r, startColumnIndex: colIndex, endColumnIndex: colIndex + 1 },
          pasteType: 'PASTE_DATA_VALIDATION',
        },
      })
    }
  })

  if (requests.length === 0) return
  await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests } })
}

/**
 * 동기화 ID(M열)로 시트 행 번호(1-based)를 찾는다. 없으면 null.
 * 부분 입금 잔여분(`{ID}#xxxx`)이 아니라 M열에 실제로 적힌 앞부분 ID 를 넘겨야 한다.
 */
export async function findRowIndexBySyncId(syncId: string): Promise<number | null> {
  const { sheets, sheetId, sheetName } = getSheetsClient(true)
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${sheetName}!${SYNC_ID_COLUMN}2:${SYNC_ID_COLUMN}`,
  })
  const ids = res.data.values ?? []
  const offset = ids.findIndex((r) => String(r?.[0] ?? '').trim() === syncId)
  return offset < 0 ? null : offset + 2
}

/** 시트 행의 I열(입금상태)만 바꾼다 — 다른 열은 건드리지 않는다 */
export async function updateSheetStatusByRowIndex(rowIndex: number, status: PaymentStatus): Promise<void> {
  const { sheets, sheetId, sheetName } = getSheetsClient(false)
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${sheetName}!${STATUS_COLUMN}${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[status]] },
  })
}

/**
 * 동기화 ID(M열)로 행을 찾아 I열(입금상태)만 바꾼다 — 입금 확정을 되돌릴 때 쓴다.
 *
 * 시트가 팀의 원장이라 DB만 고쳐서는 안 된다. 시트에 '입금완료'가 남아 있으면
 * 다음 sync-sheets 가 미확정 건은 시트를 원본으로 보고 다시 confirmed 로 덮어쓴다.
 * 행을 찾지 못하면 null — 호출한 쪽에서 손으로 고치라고 안내한다.
 */
export async function updateSheetStatusBySyncId(
  syncId: string,
  status: PaymentStatus,
): Promise<{ rowIndex: number } | null> {
  const rowIndex = await findRowIndexBySyncId(syncId)
  if (rowIndex == null) return null
  await updateSheetStatusByRowIndex(rowIndex, status)
  return { rowIndex }
}

/** 행 번호로 B~M 을 읽어 SheetRow 로 — 날짜·금액이 없으면 null */
export async function fetchSheetRowByIndex(rowIndex: number): Promise<SheetRow | null> {
  const { sheets, sheetId, sheetName } = getSheetsClient(true)

  const rowRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${sheetName}!B${rowIndex}:${SYNC_ID_COLUMN}${rowIndex}`,
  })
  const row = rowRes.data.values?.[0] ?? []

  const rawDate = String(row[0] ?? '').trim()
  const rawAmount = String(row[5] ?? '').trim().replace(/,/g, '').replace(/[^\d.-]/g, '')
  const amount = parseFloat(rawAmount)

  if (!rawDate || isNaN(amount) || amount <= 0) return null

  const date = parseDate(rawDate)
  if (!date) return null

  const status = normalizeStatus(String(row[7] ?? '').trim())
  const rawIdCell = String(row[11] ?? '').trim()
  const isValidId = /^tx_/.test(rawIdCell)

  return {
    rowIndex,
    syncId: isValidId ? rawIdCell : '',
    idCellOccupied: !!rawIdCell && !isValidId,
    date,
    clientName: String(row[1] ?? '').trim(),
    representative: String(row[2] ?? '').trim(),
    phone: String(row[3] ?? '').trim(),
    manager: String(row[4] ?? '').trim(),
    amount,
    memo: String(row[6] ?? '').trim(),
    status,
  }
}

/**
 * 동기화 ID(M열)로 행을 찾아 전체 결제 정보 읽기 — 수정 모달 pre-fill 용.
 */
export async function fetchSheetRowBySyncId(syncId: string): Promise<SheetRow | null> {
  const rowIndex = await findRowIndexBySyncId(syncId)
  if (rowIndex == null) return null
  return fetchSheetRowByIndex(rowIndex)
}

// ── I열 셀 메모 (입금 기록) ──────────────────────────────────────
// 입금 확정 때마다 "M/D 입금완료 N원" 한 줄을 I열 셀 메모에 남긴다 (형식: lib/payments/deposit-note.ts).
// 메모는 값이 아니라 셀 속성이라 values API 로는 못 다루고 spreadsheets.get/batchUpdate 를 쓴다.

/** 설정된 탭의 숫자 sheetId(gid) — updateCells 에 필요. 탭이 바뀌지 않으니 한 번만 읽는다 */
let cachedTabId: { name: string; id: number } | null = null

export async function getSheetTabId(): Promise<number> {
  const { sheets, sheetId, sheetName } = getSheetsClient(true)
  if (cachedTabId && cachedTabId.name === sheetName) return cachedTabId.id

  const res = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: 'sheets.properties(sheetId,title)',
  })
  const tab = res.data.sheets?.find((s) => s.properties?.title === sheetName)
  const id = tab?.properties?.sheetId
  if (id == null) throw new Error(`시트 탭을 찾을 수 없습니다: ${sheetName}`)
  cachedTabId = { name: sheetName, id }
  return id
}

async function readStatusNote(rowIndex: number): Promise<string> {
  const { sheets, sheetId, sheetName } = getSheetsClient(true)
  const res = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    ranges: [`${sheetName}!${STATUS_COLUMN}${rowIndex}`],
    includeGridData: true,
    fields: 'sheets.data.rowData.values.note',
  })
  return res.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0]?.note ?? ''
}

async function writeStatusNote(rowIndex: number, note: string): Promise<void> {
  const { sheets, sheetId } = getSheetsClient(false)
  const tabId = await getSheetTabId()
  const colIndex = STATUS_COLUMN.charCodeAt(0) - 'A'.charCodeAt(0)
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        updateCells: {
          start: { sheetId: tabId, rowIndex: rowIndex - 1, columnIndex: colIndex },
          rows: [{ values: [{ note }] }],
          fields: 'note',
        },
      }],
    },
  })
}

/** I열 셀 메모 끝에 한 줄 덧붙인다 — 기존 메모는 그대로 둔다 */
export async function appendStatusNote(rowIndex: number, line: string): Promise<void> {
  const existing = await readStatusNote(rowIndex)
  await writeStatusNote(rowIndex, appendNoteLine(existing, line))
}

/**
 * I열 셀 메모에서 oldLine 과 똑같은 줄을 newLine 으로 바꾼다. 그런 줄이 없으면 newLine 을 덧붙인다.
 * 입금 내역에서 확정 금액·날짜를 고쳤을 때 쓴다.
 */
export async function replaceStatusNoteLine(
  rowIndex: number,
  oldLine: string,
  newLine: string,
): Promise<'replaced' | 'appended'> {
  const existing = await readStatusNote(rowIndex)
  const { note, result } = replaceNoteLine(existing, oldLine, newLine)
  await writeStatusNote(rowIndex, note)
  return result
}

/**
 * 동기화 ID(M열)로 행을 찾아 B~I 컬럼 전체 업데이트 — 결제 수정용.
 * 전화번호는 텍스트('010-xxx)로 강제하여 앞자리 0이 사라지지 않게 한다.
 */
export async function updateSheetRowBySyncId(
  syncId: string,
  row: {
    date: string
    clientName: string
    representative: string
    phone: string
    manager: string
    amount: number
    memo: string
    status: PaymentStatus
  },
): Promise<{ rowIndex: number } | null> {
  const rowIndex = await findRowIndexBySyncId(syncId)
  if (rowIndex == null) return null
  const { sheets, sheetId, sheetName } = getSheetsClient(false)

  // B~I 업데이트 (USER_ENTERED 로 날짜/금액은 숫자화, 전화번호는 '로 시작하면 텍스트)
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${sheetName}!B${rowIndex}:I${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        row.date,
        row.clientName,
        row.representative,
        // 전화번호 앞에 ' 붙여서 텍스트로 저장 (앞자리 0 보존)
        row.phone ? `'${row.phone}` : '',
        row.manager,
        row.amount,
        row.memo,
        row.status,
      ]],
    },
  })

  return { rowIndex }
}

/** I열 드롭다운 값을 입금 상태로 정규화 */
function normalizeStatus(raw: string): PaymentStatus {
  if (/미입금/.test(raw)) return '미입금'
  if (/잔금/.test(raw)) return '잔금 처리 요망'
  // '추가/재계약' — 진행 중인 업체라도 별도 계약 입금으로 처리 (새 프로젝트로 분리)
  if (/추가|재계약/.test(raw)) return '추가계약'
  if (/입금완료|완료|완납/.test(raw)) return '입금완료'
  return '입금완료'
}

function parseDate(raw: string): string | null {
  // YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = raw.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/)
  if (isoMatch) {
    const [, y, m, d] = isoMatch
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  // MM/DD/YYYY or M/D/YYYY
  const usMatch = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (usMatch) {
    const [, m, d, y] = usMatch
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  // 한국어: 2026년 4월 1일
  const krMatch = raw.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/)
  if (krMatch) {
    const [, y, m, d] = krMatch
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  // 한국 로케일 표시 형식: "2026. 8. 10" / "2026. 8. 10."
  // 시트에 진짜 날짜값으로 들어간 셀은 values.get 이 이 형태로 돌려준다
  const krLocale = raw.match(/^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?$/)
  if (krLocale) {
    const [, y, m, d] = krLocale
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  return null
}

/**
 * (레거시) 내용 기반 external_id — A열 ID가 없는 기존 데이터와의 매칭에만 사용.
 * 새 행에는 makeSyncId()로 생성한 불변 ID를 쓴다.
 */
export function makeLegacyExternalId(row: SheetRow): string {
  const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '-')
  const key = [
    row.date,
    normalize(row.clientName),
    String(row.amount),
    normalize(row.memo),
    normalize(row.manager),
  ].join('_')
  return `sheet_${key}`
}
