/**
 * 수금 예정(미수금) 집계 — 결제 내역 → 수금 관리 탭과 정확히 같은 기준.
 * 상태가 잔금 처리 요망·미입금인 결제 중 취소된 프로젝트에 연결된 건은 뺀다.
 *
 * getReceivables 가 유일한 조회 지점이고, getReceivablesSummary 는 그 결과를 합산만 한다.
 * 그래야 동기화 로그의 숫자와 /api/receivables 가 어긋나지 않는다.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { baseSyncId } from '@/lib/payments/remaining'

export type ReceivableStatus = 'balance_due' | 'unpaid'

export type ReceivableRow = {
  id: string
  clientName: string
  projectName: string | null
  /** payments.manager 원문 (예: "나병훈 0팀") */
  manager: string | null
  /** 팀 접미사를 뗀 담당자 이름 — 없으면 "미지정" */
  managerName: string
  amount: number
  status: ReceivableStatus
  statusLabel: '잔금 처리 요망' | '미입금'
  paymentDate: string
  /** 시트 동기화 ID (잔여분이면 # 앞부분) — 시트에서 온 건이 아니면 null */
  syncId: string | null
  /** 부분 입금 후 남은 잔여분인지 (external_id 에 # 포함) */
  isSplit: boolean
  excluded: boolean
}

export type ReceivablesSummary = { count: number; total: number }

export const UNASSIGNED_MANAGER = '미지정'

const STATUS_LABEL: Record<ReceivableStatus, ReceivableRow['statusLabel']> = {
  balance_due: '잔금 처리 요망',
  unpaid: '미입금',
}

/** "나병훈 0팀" → "나병훈", "신현준" → "신현준", 비어 있으면 "미지정" — 순수 함수 */
export function managerPersonName(raw: string | null | undefined): string {
  const name = (raw ?? '').trim().replace(/\s*\d+\s*팀$/, '').trim()
  return name || UNASSIGNED_MANAGER
}

type RawRow = {
  id: string
  amount: number
  status: ReceivableStatus
  manager: string | null
  payment_date: string
  external_id: string | null
  client_name_raw: string | null
  excluded: boolean
  projects: { name: string; status: string; clients: { name: string } | null } | null
}

export async function getReceivables(db: SupabaseClient<Database>): Promise<ReceivableRow[]> {
  const { data, error } = await db
    .from('payments')
    .select('id, amount, status, manager, payment_date, external_id, client_name_raw, excluded, projects(name, status, clients(name))')
    .in('status', ['balance_due', 'unpaid'])
  if (error) throw new Error(error.message)

  return ((data ?? []) as unknown as RawRow[])
    .filter((p) => p.projects?.status !== 'cancelled')
    .map((p) => ({
      id: p.id,
      clientName: p.client_name_raw ?? p.projects?.clients?.name ?? p.projects?.name ?? '(상호명 없음)',
      projectName: p.projects?.name ?? null,
      manager: p.manager,
      managerName: managerPersonName(p.manager),
      amount: Number(p.amount),
      status: p.status,
      statusLabel: STATUS_LABEL[p.status],
      paymentDate: p.payment_date,
      syncId: baseSyncId(p.external_id),
      isSplit: !!p.external_id && p.external_id.includes('#'),
      excluded: p.excluded,
    }))
}

export async function getReceivablesSummary(db: SupabaseClient<Database>): Promise<ReceivablesSummary> {
  const rows = await getReceivables(db)
  return {
    count: rows.length,
    total: rows.reduce((s, p) => s + p.amount, 0),
  }
}

export type ManagerReceivables = { managerName: string; count: number; total: number; rows: ReceivableRow[] }

/** 담당자별로 묶는다 — 그룹은 합계 큰 순, 그룹 안 행은 금액 큰 순 (순수 함수) */
export function groupReceivablesByManager(rows: ReceivableRow[]): ManagerReceivables[] {
  const groups = new Map<string, ReceivableRow[]>()
  for (const r of rows) {
    const list = groups.get(r.managerName)
    if (list) list.push(r)
    else groups.set(r.managerName, [r])
  }
  return [...groups.entries()]
    .map(([managerName, list]) => ({
      managerName,
      count: list.length,
      total: list.reduce((s, r) => s + r.amount, 0),
      rows: [...list].sort((a, b) => b.amount - a.amount),
    }))
    .sort((a, b) => b.total - a.total)
}
