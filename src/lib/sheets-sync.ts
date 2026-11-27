/**
 * 결제시트(Google Sheets) → Supabase payments 동기화 본체.
 * POST /api/sync-sheets(수동·Bearer 호출)와 instrumentation 스케줄러(15분 자동)가 함께 쓴다.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchSheetRows, writeBackSyncIds, makeSyncId, readStatusNote, appendStatusNote,
  type SheetRow,
} from '@/lib/google-sheets'
import { createAdminClient } from '@/lib/supabase/admin'
import { findOrCreateClient, findOrCreateProject, type ClientCache } from '@/lib/payments/project-match'
import { toDbStatus, toPaymentType } from '@/lib/payments/status'
import { findDepositInNote, formatDepositNoteLine, removeAccountedLines } from '@/lib/payments/deposit-note'
import { buildPaymentMemo } from '@/lib/payments/register'
import { computeRemaining, pendingTotal } from '@/lib/payments/remaining'
import { getReceivablesSummary } from '@/lib/payments/receivables'
import type { Database } from '@/types/database'

type Admin = SupabaseClient<Database>

type ExistingPayment = {
  id: string
  external_id: string | null
  payment_date: string
  client_name_raw: string | null
  amount: number
  memo: string | null
  manager: string | null
  status: 'confirmed' | 'balance_due' | 'unpaid'
  source: string
  project_id: string | null
}

/**
 * 시트 행 하나가 DB 결제 여러 건으로 나뉜 경우의 잔여분 ID — `{시트 동기화 ID}#{접미사}`.
 * 수금 관리에서 일부만 입금 확정하면 원래 건(시트 ID 보유)은 확정되고 차액이 새 건으로 남는데,
 * 이 잔여분이 시트 행과 이어져 있어야 시트를 '입금완료'로 바꿨을 때 함께 확정할 수 있다.
 */
const SPLIT_SEP = '#'
const makeSplitId = (syncId: string) => `${syncId}${SPLIT_SEP}${crypto.randomUUID().slice(0, 8)}`

/** 시트를 읽는 하한 — 이 이전 행은 앱 도입 전 데이터라 읽지 않는다 */
const SHEET_FLOOR_DATE = '2026-04-01'

/**
 * 시트가 '입금완료'로 바뀐 잔여분의 입금일 기본값 — 동기화한 날(KST).
 * I열 메모에 그 금액의 입금 줄("M/D 입금완료 N원")이 있으면 그 날짜를 쓴다.
 */
const todayKst = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)

/**
 * 시트 행 → DB 메모 (상태 태그 없이 순수 메모만).
 * `/결제` 모달 등록도 같은 함수를 쓴다 — 형식이 갈라지면 동기화가 매번 "변경됨"으로 오인한다.
 */
const buildMemo = (row: SheetRow): string | null =>
  buildPaymentMemo(row.memo, row.representative, row.phone)
export type SyncTrigger = 'cron' | 'manual'

export type SyncSuccess = {
  synced: number
  updated: number
  skipped: number
  unmatched: number
  pending: number
  created: number
  errors?: { row: number; reason: string }[]
  writeBackError?: string
  total?: number
  timestamp?: string
}

export type SyncFailure = { error: string }

export type SyncResult = SyncSuccess | SyncFailure

export const isSyncFailure = (r: SyncResult): r is SyncFailure => 'error' in r && typeof r.error === 'string'

/**
 * 시트 동기화 1회 실행. 실패해도 throw 하지 않고 `{ error }` 를 돌려준다 (sync_logs 에도 기록).
 * fromDate 를 주지 않으면 SHEET_FLOOR_DATE 부터 읽는다.
 */
export async function runSheetSync(opts: { trigger: SyncTrigger; fromDate?: string }): Promise<SyncResult> {
  const supabase = createAdminClient()
  const result = await runSheetSyncBody(supabase, opts)
  await logReceivables(supabase)
  return result
}

/** 동기화가 끝날 때마다 수금 관리 탭 기준 미수금 건수·합계를 한 줄 남긴다 */
async function logReceivables(supabase: Admin) {
  try {
    const { count, total } = await getReceivablesSummary(supabase)
    console.log(`[sheet-sync] receivables count=${count} total=${total}`)
  } catch (e) {
    console.warn(`[sheet-sync] receivables 집계 실패: ${e instanceof Error ? e.message : e}`)
  }
}

async function runSheetSyncBody(supabase: Admin, opts: { trigger: SyncTrigger; fromDate?: string }): Promise<SyncResult> {
  const trigger = opts.trigger
  let fromDate = SHEET_FLOOR_DATE
  if (opts.fromDate) fromDate = opts.fromDate

  try {
    // fromDate 는 "새 행을 가져올 범위"일 뿐이다. 이미 동기화된 행(M열 ID 보유)의 상태 변경은
    // 날짜와 무관하게 반영해야 한다 — 9월 미입금 건을 10월에 '입금완료'로 바꾸는 게 흔한 흐름인데
    // 대시보드 기본값(이번 달 1일)으로 동기화하면 그 행을 아예 읽지 않아 반영되지 않았다.
    const rows = await fetchSheetRows(fromDate < SHEET_FLOOR_DATE ? fromDate : SHEET_FLOOR_DATE)
    if (rows.length === 0) {
      await logSync(supabase, { trigger, fromDate })
      return { synced: 0, updated: 0, skipped: 0, unmatched: 0, pending: 0, created: 0 }
    }

    const { data: existingRaw } = await supabase
      .from('payments')
      .select('id, external_id, payment_date, client_name_raw, amount, memo, manager, status, source, project_id')
    const existing = (existingRaw ?? []) as ExistingPayment[]

    // M열 동기화 ID 기준 매칭 (신규 방식 — 내용이 바뀌어도 같은 행으로 인식)
    const byExternalId = new Map<string, ExistingPayment>()
    // 부분 입금으로 갈라진 잔여분 — 시트 ID별로 묶는다
    const splitsBySyncId = new Map<string, ExistingPayment[]>()
    for (const p of existing) {
      if (!p.external_id) continue
      byExternalId.set(p.external_id, p)
      const sep = p.external_id.indexOf(SPLIT_SEP)
      if (sep > 0) {
        const base = p.external_id.slice(0, sep)
        splitsBySyncId.set(base, [...(splitsBySyncId.get(base) ?? []), p])
      }
    }
    // 시트와 연결이 끊긴 수금 예정 건 (예전 부분 입금의 잔여분·손으로 추가한 잔금) — 프로젝트별
    const orphansByProject = new Map<string, ExistingPayment[]>()
    for (const p of existing) {
      if (p.external_id || p.status === 'confirmed' || !p.project_id) continue
      orphansByProject.set(p.project_id, [...(orphansByProject.get(p.project_id) ?? []), p])
    }

    // ── M열 ID가 없는 행의 기존 건 탐색용 ──────────────────────────
    // (M열 기록이 실패했던 행, 손으로 넣은 결제를 다시 잇는다)
    const normName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '-')
    const normMemo = (s: string | null) => (s ?? '').toLowerCase().replace(/\s+/g, '')
    // 날짜+상호명+금액+메모 soft 매칭 — 메모 포함으로 같은 날 동일 금액의 추가·재계약 구분 유지
    const softDupMap = new Map<string, ExistingPayment>()
    for (const p of existing) {
      if (!p.client_name_raw) continue
      const key = `${p.payment_date}|${normName(p.client_name_raw)}|${p.amount}|${normMemo(p.memo)}`
      if (!softDupMap.has(key)) softDupMap.set(key, p)
    }
    // 수기 입력(external_id 없는) 항목 — 메모가 달라도 날짜+상호명+금액이 같으면 같은 건으로 인식
    const manualDupMap = new Map<string, ExistingPayment>()
    for (const p of existing) {
      if (p.external_id || !p.client_name_raw) continue
      const key = `${p.payment_date}|${normName(p.client_name_raw)}|${p.amount}`
      if (!manualDupMap.has(key)) manualDupMap.set(key, p)
    }

    // 클라이언트 목록 (매칭·자동생성용) — 동기화 중 생성된 항목도 누적
    const { data: clients } = await supabase.from('clients').select('id, name')
    const clientCache: ClientCache = (clients ?? []).map((c) => ({ id: c.id, name: c.name }))

    let synced = 0
    let updated = 0       // 시트 수정이 기존 건에 반영됨
    let skipped = 0       // 변경 없음
    let unmatched = 0     // 클라이언트명 없어서 미매칭
    let pending = 0       // 잔금/미입금
    let created = 0       // 자동 생성된 프로젝트 수
    const errors: { row: number; reason: string }[] = []
    const writeBacks: { rowIndex: number; syncId: string }[] = []

    for (const row of rows) {
      const dbStatus = toDbStatus(row.status)
      const dbMemo = buildMemo(row)
      // 범위 밖 행은 상태 변경만 반영하고 "변동 없음" 집계에는 넣지 않는다 (토스트 숫자가 부풀지 않게)
      const inWindow = row.date >= fromDate

      // ── 1) M열 동기화 ID로 기존 건 매칭 ─────────────────────────
      if (row.syncId) {
        const found = byExternalId.get(row.syncId)
        const splits = splitsBySyncId.get(row.syncId) ?? []
        let changedAny = false
        // 아래에서 DB 를 고친 뒤의 상태 — 잔액 점검(읽기 전용 로그)에 쓴다
        let foundNow: ExistingPayment | undefined = found
        const confirmedSplitIds = new Set<string>()

        // 부분 입금으로 확정분이 시트 금액보다 작은데 잔여분이 시트와 끊겨 있으면 다시 잇는다.
        // (예전 confirm_pending_payment 는 잔여분에 ID를 남기지 않았고, 잔금을 손으로 추가한 경우도 있다)
        if (found?.project_id) {
          const orphans = orphansByProject.get(found.project_id) ?? []
          const covered = found.amount + splits.reduce((s, p) => s + p.amount, 0)
          const orphanSum = orphans.reduce((s, p) => s + p.amount, 0)
          if (orphans.length > 0 && covered < row.amount && covered + orphanSum <= row.amount + 1) {
            for (const o of orphans) {
              const splitId = makeSplitId(row.syncId)
              const { error } = await supabase.from('payments')
                .update({ external_id: splitId }).eq('id', o.id).is('external_id', null)
              if (error) { errors.push({ row: row.rowIndex, reason: `잔여분 연결 실패: ${error.message}` }); continue }
              const linked = { ...o, external_id: splitId }
              byExternalId.set(splitId, linked)
              splits.push(linked)
            }
            orphansByProject.delete(found.project_id)
          }
        }

        if (found) {
          if (found.status !== 'confirmed') {
            // 미확정(수금 예정) 건 — 시트가 원본이므로 수정 사항을 그대로 반영.
            // 단 잔여분으로 갈라진 건은 시트 금액이 여러 건의 합계라 금액·날짜를 덮어쓰지 않는다.
            const syncAmount = splits.length === 0
            const changed =
              found.client_name_raw !== (row.clientName || null) ||
              (syncAmount && found.amount !== row.amount) ||
              (syncAmount && found.payment_date !== row.date) ||
              found.manager !== (row.manager || null) ||
              found.memo !== dbMemo ||
              found.status !== dbStatus
            if (changed) {
              const { error } = await supabase.from('payments').update({
                client_name_raw: row.clientName || null,
                ...(syncAmount ? { amount: row.amount, payment_date: row.date } : {}),
                manager: row.manager || null,
                memo: dbMemo,
                status: dbStatus,
              }).eq('id', found.id)
              if (error) errors.push({ row: row.rowIndex, reason: `업데이트 실패: ${error.message}` })
              else {
                changedAny = true
                foundNow = { ...found, status: dbStatus, ...(syncAmount ? { amount: row.amount } : {}) }
              }
            }
          } else {
            // 확정 건 — 금액·날짜는 앱에서 확정한 값을 유지하고 표시 필드만 반영
            const changed =
              found.client_name_raw !== (row.clientName || null) ||
              found.manager !== (row.manager || null)
            if (changed) {
              const { error } = await supabase.from('payments').update({
                client_name_raw: row.clientName || null,
                manager: row.manager || null,
              }).eq('id', found.id)
              if (error) errors.push({ row: row.rowIndex, reason: `업데이트 실패: ${error.message}` })
              else changedAny = true
            }
          }
        }
        // ID는 있는데 DB에 없음 → 앱에서 삭제된 건. 재생성하지 않는다.

        // 시트가 입금완료면 남은 잔여분도 확정 — 원래 건이 이미 확정돼 있어 위에서는 아무 일도 일어나지 않던 경우
        // 입금일은 I열 메모의 입금 줄에서 찾고, 메모에 그 입금 줄이 없으면 덧붙여 메모가 입금 기록 전체가 되게 한다.
        if (dbStatus === 'confirmed') {
          const toConfirm = splits.filter((s) => s.status !== 'confirmed')
          // 메모는 이 행에 확정할 잔여분이 있을 때만 한 번 읽는다 (드문 경로). null = 읽기 실패
          let note: string | null = null
          if (toConfirm.length > 0) {
            try {
              note = await readStatusNote(row.rowIndex)
            } catch (e) {
              errors.push({ row: row.rowIndex, reason: `I열 메모 읽기 실패 — 잔여분 입금일을 오늘로 둡니다: ${e instanceof Error ? e.message : e}` })
            }
          }
          // 이미 확정된 같은 그룹 입금이 차지한 줄은 매칭용 사본에서 뺀다 — 50:50 계약에서 앞선 입금 줄을
          // 잔여분의 입금일로 잘못 쓰지 않게. 줄인 메모는 매칭에만 쓰고 시트에는 쓰지 않는다
          // (appendStatusNote 는 시트의 실제 메모를 직접 읽는다).
          if (note != null) {
            const alreadyConfirmed = [
              ...(foundNow?.status === 'confirmed' ? [foundNow] : []),
              ...splits.filter((s) => s.status === 'confirmed'),
            ].map((p) => ({ amount: p.amount, paymentDate: p.payment_date }))
            note = removeAccountedLines(note, alreadyConfirmed)
          }
          const syncDate = todayKst()
          for (const s of toConfirm) {
            const found = note != null ? findDepositInNote(note, s.amount, syncDate) : null
            if (found && note != null) {
              // 같은 금액의 잔여분이 또 있으면 다른 줄을 찾도록 쓴 줄은 (이 실행 안에서만) 지운다
              const lines = note.split('\n')
              lines.splice(found.lineIndex, 1)
              note = lines.join('\n')
            }
            const paymentDate = found?.date ?? syncDate
            const { error } = await supabase.from('payments')
              .update({ status: 'confirmed', payment_date: paymentDate }).eq('id', s.id)
            if (error) { errors.push({ row: row.rowIndex, reason: `잔여분 확정 실패: ${error.message}` }); continue }
            changedAny = true
            confirmedSplitIds.add(s.id)

            // 메모를 읽지 못했으면 줄이 이미 있는지 몰라 덧붙이지 않는다 (중복 방지)
            if (!found && note != null) {
              try {
                await appendStatusNote(row.rowIndex, formatDepositNoteLine(paymentDate, s.amount))
              } catch (e) {
                errors.push({ row: row.rowIndex, reason: `I열 메모 입금 줄 기록 실패: ${e instanceof Error ? e.message : e}` })
              }
            }
          }
        }

        // 잔액 점검 (읽기 전용) — 저장된 수금 예정 금액과 "시트 금액 − 확정 입금 합계"가 다르면 로그만 남긴다.
        // 여러 달 계약은 예전 입금이 그룹 밖에 기록돼 있어 계산값이 틀릴 수 있으므로 절대 고치지 않는다.
        // 원래 건이 확정됐거나 잔여분이 있는 그룹만 (아니면 위에서 시트 금액을 그대로 반영한다)
        if (foundNow?.status === 'confirmed' || splits.length > 0) {
          const group = [
            ...(foundNow ? [foundNow] : []),
            ...splits.map((s) => (confirmedSplitIds.has(s.id) ? { ...s, status: 'confirmed' as const } : s)),
          ]
          const stored = pendingTotal(group)
          const sheetMinusConfirmed = computeRemaining(row.amount, group)
          if (Math.abs(stored - sheetMinusConfirmed) > 1) {
            console.log(`[sheet-sync] check remainder ${row.syncId} ${row.clientName} stored=${stored} sheetMinusConfirmed=${sheetMinusConfirmed}`)
          }
        }

        if (changedAny) updated++
        else if (inWindow) skipped++
        continue
      }

      // 범위 밖의 ID 없는 행은 새로 가져오지 않는다
      if (!inWindow) continue

      // ── 2) M열 ID가 없는 행 — 내용(날짜·상호명·금액)으로 기존 건 탐색 ───
      const contentMatch =
        (row.clientName
          ? softDupMap.get(`${row.date}|${normName(row.clientName)}|${row.amount}|${normMemo(buildMemo(row))}`)
          : undefined) ??
        (row.clientName
          ? manualDupMap.get(`${row.date}|${normName(row.clientName)}|${row.amount}`)
          : undefined)

      const newSyncId = makeSyncId()

      if (contentMatch) {
        // 기존 건에 새 동기화 ID를 부여하고 시트에도 기록 — 다음부터는 내용이 바뀌어도 중복되지 않는다
        // (ID 셀에 다른 내용이 있으면 기록하지 않고 매번 내용 매칭으로 처리)
        if (!row.idCellOccupied) {
          const { error } = await supabase.from('payments')
            .update({ external_id: newSyncId }).eq('id', contentMatch.id)
          if (!error) {
            byExternalId.set(newSyncId, { ...contentMatch, external_id: newSyncId })
            writeBacks.push({ rowIndex: row.rowIndex, syncId: newSyncId })
          }
        }
        skipped++
        continue
      }

      // ── 3) 신규 행 — 결제 생성 ──────────────────────────────────
      const isPending = dbStatus !== 'confirmed'

      let projectId: string | null = null
      let matched = false

      if (row.clientName) {
        // 클라이언트·프로젝트 연결 규칙은 project-match.ts 한 곳에 있다 (/결제 등록과 공유)
        const client = await findOrCreateClient(
          supabase,
          { name: row.clientName, representative: row.representative, phone: row.phone },
          clientCache,
        )
        if ('error' in client) {
          errors.push({ row: row.rowIndex, reason: `클라이언트 생성 실패: ${client.error}` })
        } else {
          const project = await findOrCreateProject(supabase, {
            clientId: client.id,
            clientName: row.clientName,
            amount: row.amount,
            date: row.date,
            status: row.status,
            memo: row.memo,
          })
          if ('error' in project) {
            errors.push({ row: row.rowIndex, reason: `프로젝트 생성 실패: ${project.error}` })
          } else {
            projectId = project.id
            matched = true
            if (project.isNew) created++
          }
        }
      }

      if (!matched) unmatched++
      if (isPending) pending++

      const paymentType = toPaymentType(row.status)

      const { error: insertErr } = await supabase.from('payments').insert({
        project_id: projectId,
        amount: row.amount,
        payment_date: row.date,
        payment_type: paymentType,
        manager: row.manager || null,
        memo: dbMemo,
        source: 'slack',
        external_id: newSyncId,
        client_name_raw: row.clientName || null,
        matched,
        status: dbStatus,
      })

      if (insertErr) {
        errors.push({ row: row.rowIndex, reason: `결제 저장 실패: ${insertErr.message}` })
      } else {
        synced++
        if (!row.idCellOccupied) writeBacks.push({ rowIndex: row.rowIndex, syncId: newSyncId })
        if (row.clientName) {
          softDupMap.set(`${row.date}|${normName(row.clientName)}|${row.amount}|${normMemo(dbMemo)}`, {
            id: '', external_id: newSyncId, payment_date: row.date,
            client_name_raw: row.clientName, amount: row.amount,
            memo: dbMemo, manager: row.manager || null, status: dbStatus, source: 'slack', project_id: projectId,
          })
        }
      }
    }

    // 시트 M열에 동기화 ID 기록 — 실패해도 동기화 자체는 성공 처리 (다음 실행에서 내용 매칭으로 복구됨)
    let writeBackError: string | null = null
    try {
      await writeBackSyncIds(writeBacks)
    } catch (e) {
      writeBackError = e instanceof Error ? e.message : '시트 ID 기록 실패'
    }

    await logSync(supabase, { trigger, fromDate, synced, updated, skipped, created, pending, unmatched })

    return {
      synced,
      updated,
      skipped,
      unmatched,
      pending,
      created,
      errors: errors.length > 0 ? errors : undefined,
      writeBackError: writeBackError ?? undefined,
      total: rows.length,
      timestamp: new Date().toISOString(),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '알 수 없는 오류'
    await logSync(supabase, { trigger, fromDate, error: message })
    return { error: message }
  }
}

async function logSync(supabase: Admin, log: {
  trigger: string; fromDate: string
  synced?: number; updated?: number; skipped?: number
  created?: number; pending?: number; unmatched?: number; error?: string
}) {
  try {
    await supabase.from('sync_logs').insert({
      trigger: log.trigger,
      from_date: log.fromDate,
      synced: log.synced ?? 0,
      updated: log.updated ?? 0,
      skipped: log.skipped ?? 0,
      created_projects: log.created ?? 0,
      pending: log.pending ?? 0,
      unmatched: log.unmatched ?? 0,
      error: log.error ?? null,
    })
  } catch { /* 로그 실패는 무시 */ }
}

// ── 중복 실행 잠금 ──────────────────────────────────────────────
// instrumentation 과 라우트 핸들러는 서로 다른 번들로 빌드돼 이 모듈이 두 번 로드될 수 있다.
// 그래서 실행 중 플래그를 모듈 변수가 아니라 globalThis 에 둔다 — 어느 쪽에서 불러도 같은 잠금을 본다.
const LOCK_KEY = Symbol.for('tianxia.sheetSync.running')
type LockHolder = { [LOCK_KEY]?: boolean }
const lockHolder = globalThis as LockHolder

export const isSheetSyncRunning = () => lockHolder[LOCK_KEY] === true

export type SyncSkipped = { skipped: 'already running' }

export const isSyncSkipped = (r: SyncResult | SyncSkipped): r is SyncSkipped =>
  typeof (r as SyncSkipped).skipped === 'string'

/** 다른 동기화가 진행 중이면 실행하지 않고 `{ skipped: 'already running' }` 을 돌려준다 */
export async function runSheetSyncLocked(
  opts: { trigger: SyncTrigger; fromDate?: string },
): Promise<SyncResult | SyncSkipped> {
  if (isSheetSyncRunning()) return { skipped: 'already running' }
  lockHolder[LOCK_KEY] = true
  try {
    return await runSheetSync(opts)
  } finally {
    lockHolder[LOCK_KEY] = false
  }
}
