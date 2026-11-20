'use client'

import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { baseSyncId, calcLine, needsPaidInput } from '@/lib/incentives/engine'
import type { CrmView, FinanceView, MonthView } from '@/lib/incentives/types'
import { won } from './cells'

/**
 * 이 달 정산 전에 확인할 것 — 컴퓨터 사용으로 하던 확인 작업을 한곳에 모은다.
 * [M월 확인] 메모, D칸 입력, F칸 오류, CRM에서 아직 안 가져온 줄, 재무관리 입금 · 환불.
 */
export function Checklist({
  view, finance, crm, crmError, crmLoading, onFocusLine, onSync, busy,
}: {
  view: MonthView
  finance: FinanceView | null
  crm: CrmView | null
  crmError: string | null
  crmLoading: boolean
  onFocusLine: (managerId: string, lineId: string) => void
  onSync: () => void
  busy: boolean
}) {
  const name = (id: string) => view.managers.find((m) => m.id === id)?.name ?? ''
  const closed = new Set(view.months.filter((m) => m.status === 'closed').map((m) => m.manager_id))
  const openLines = view.lines.filter((l) => !closed.has(l.manager_id))
  const tag = `[${view.month}월 확인]`

  const checks = view.checks.filter((c) => !(c.year === view.year && c.month === view.month && closed.has(c.managerId)))
  const needs = openLines.filter((l) => needsPaidInput(l))
  const errors = openLines
    .map((l) => ({ line: l, error: calcLine(l, view.config).error }))
    .filter((x): x is { line: typeof x.line; error: string } => x.error !== null)
  const gone = crm ? openLines.filter((l) => l.sync_id && !crm.bySid[baseSyncId(l.sync_id)]) : []
  const pending = crm ? Object.entries(crm.preview).filter(([, p]) => p.add.length > 0) : []
  const unmatched = finance?.unmatched ?? []
  const refunds = finance?.refunds ?? []
  const missingSid = crm?.missingSid ?? []

  const total = checks.length + needs.length + errors.length + gone.length + pending.length + unmatched.length + refunds.length + missingSid.length

  const jump = (managerId: string, lineId: string, label: React.ReactNode) => (
    <button type="button" className="text-left font-medium text-gray-900 hover:text-blue-600 hover:underline" onClick={() => onFocusLine(managerId, lineId)}>
      {label}
    </button>
  )

  return (
    <div className="space-y-3 rounded-2xl bg-white px-5 py-4 ring-1 ring-gray-200/70">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-bold text-gray-900">
          {total > 0 ? <AlertTriangle size={15} className="text-amber-500" /> : <CheckCircle2 size={15} className="text-green-600" />}
          확인할 것 {total > 0 && <span className="text-amber-600">{total}</span>}
        </p>
        <span className="text-xs text-gray-400">
          {crmLoading ? 'CRM 읽는 중…' : crmError ? <span className="text-red-600">CRM을 읽지 못했습니다: {crmError}</span> : 'CRM 확인 완료'}
        </span>
      </div>

      {total === 0 && !crmLoading && <p className="text-sm text-gray-500">지금 확인할 것이 없습니다.</p>}

      <Section title={`${tag} 메모`} count={checks.length}>
        {checks.map((c) => {
          const here = c.year === view.year && c.month === view.month
          const at = c.note.indexOf(tag)
          return (
            <li key={c.lineId}>
              <span className="text-gray-500">{name(c.managerId)}{here ? '' : ` · ${c.month}월 탭`} · </span>
              {here ? jump(c.managerId, c.lineId, c.clientName) : <span className="font-medium">{c.clientName}</span>}
              <span className="block text-xs text-gray-600">{at >= 0 ? c.note.slice(at) : c.note}</span>
            </li>
          )
        })}
      </Section>

      <Section title="D칸에 입금액을 적어야 하는 줄" count={needs.length}>
        {needs.map((l) => {
          const fin = l.sync_id ? finance?.bySid[baseSyncId(l.sync_id)] : undefined
          return (
            <li key={l.id}>
              <span className="text-gray-500">{name(l.manager_id)} · </span>
              {jump(l.manager_id, l.id, l.client_name)}
              {fin && <span className="text-xs text-gray-600"> — 재무관리 이 달 입금 {won(fin.monthIn)}</span>}
            </li>
          )
        })}
      </Section>

      <Section title="F 인센티브율을 읽을 수 없는 줄 (마감 불가)" count={errors.length} tone="red">
        {errors.map(({ line, error }) => (
          <li key={line.id}>
            <span className="text-gray-500">{name(line.manager_id)} · </span>
            {jump(line.manager_id, line.id, line.client_name)}
            <span className="block text-xs text-red-600">{line.rate} — {error}</span>
          </li>
        ))}
      </Section>

      <Section title="CRM에서 아직 안 가져온 줄" count={pending.length}>
        {pending.map(([managerId, p]) => (
          <li key={managerId} className="flex flex-wrap items-center gap-2">
            <span>
              <span className="font-medium">{name(managerId)}</span> {p.add.length}개
              <span className="text-xs text-gray-500"> — {p.add.slice(0, 4).map((a) => a.client_name).join(', ')}{p.add.length > 4 ? ' 외' : ''}</span>
              {!p.latest && <span className="text-xs text-gray-500"> (가장 최근 달이 아니라 잔금 · 분납 줄은 만들지 않음)</span>}
            </span>
            <Button size="xs" variant="outline" disabled={busy} onClick={onSync}>CRM 동기화</Button>
          </li>
        ))}
      </Section>

      <Section title="CRM에 동기화ID가 없어 가져오지 못한 줄" count={missingSid.length}>
        {missingSid.map((r) => (
          <li key={r.row}>
            결제시트 {r.row}행 · {r.date} · <span className="font-medium">{r.name}</span> · {r.owner} · {won(r.amount)}
          </li>
        ))}
        {missingSid.length > 0 && (
          <li className="text-xs text-gray-500">재무관리의 결제시트 동기화가 ID를 채웁니다. 그 뒤 CRM 동기화를 다시 해 주세요.</li>
        )}
      </Section>

      <Section title="CRM 결제시트에서 찾을 수 없는 줄" count={gone.length}>
        {gone.map((l) => (
          <li key={l.id}>
            <span className="text-gray-500">{name(l.manager_id)} · </span>
            {jump(l.manager_id, l.id, l.client_name)}
            <span className="text-xs text-gray-500"> — CRM에서 지워졌거나 금액이 비었습니다</span>
          </li>
        ))}
      </Section>

      <Section title="이 달 정산표 줄과 이어지지 않은 재무관리 입금" count={unmatched.length}>
        {unmatched.map((p) => (
          <li key={p.id}>
            {p.date.slice(5).replace('-', '/')} · {name(p.managerId)} · <span className="font-medium">{p.client ?? p.projectName ?? '(상호 없음)'}</span> · {won(p.amount)}
            {p.projectName && p.projectName !== p.client && <span className="text-xs text-gray-500"> · {p.projectName}</span>}
            {p.memo && <span className="block text-xs text-gray-500">{p.memo}</span>}
          </li>
        ))}
        {unmatched.length > 0 && (
          <li className="text-xs text-gray-500">지난 계약의 잔금 · 분납이거나 손으로 넣는 줄일 수 있습니다. CRM 입금상태가 바뀌면 동기화가 (잔금) 줄을 만듭니다.</li>
        )}
      </Section>

      <Section title="이 달 환불" count={refunds.length} tone="red">
        {refunds.map((p) => (
          <li key={p.id}>
            {p.date.slice(5).replace('-', '/')} · {name(p.managerId)} · <span className="font-medium">{p.client ?? p.projectName ?? '(상호 없음)'}</span> · <span className="text-red-600">{won(p.amount)}</span>
            <span className="text-xs text-gray-500"> — 환수내역에 넣을지 확인</span>
          </li>
        ))}
      </Section>
    </div>
  )
}

function Section({ title, count, tone, children }: { title: string; count: number; tone?: 'red'; children: React.ReactNode }) {
  if (count === 0) return null
  return (
    <div>
      <p className={`mb-1 text-xs font-semibold ${tone === 'red' ? 'text-red-600' : 'text-gray-500'}`}>{title} · {count}</p>
      <ul className="space-y-1.5 text-sm text-gray-800">{children}</ul>
    </div>
  )
}
