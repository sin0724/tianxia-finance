'use client'

import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CurrencyInput } from '@/components/ui/currency-input'
import { calcClawback, type IncentiveConfig } from '@/lib/incentives/engine'
import type { IncentiveClawback } from '@/types/database'
import { ConfirmButton, MoneyCell, TextCell, won } from './cells'

export type ClawbackPatch = Partial<Pick<IncentiveClawback, 'client_name' | 'direct_amount' | 'contract_amount' | 'progress' | 'memo' | 'registered_on'>>

const pct = (n: number | null) => (n === null ? '' : `${Math.round(n * 10000) / 100}%`)

/** 정산시트 "환수내역" 탭 — 이 달 이 담당자 줄만. L 합계가 월 탭 O(환수 차감액)가 된다 */
export function ClawbackTable({
  rows, config, locked, onPatch, onDelete, onAdd,
}: {
  rows: IncentiveClawback[]
  config: IncentiveConfig
  locked: boolean
  onPatch: (row: IncentiveClawback, patch: ClawbackPatch) => Promise<unknown>
  onDelete: (row: IncentiveClawback) => Promise<unknown>
  onAdd: (fields: { client_name: string; direct_amount: number | null; contract_amount: number | null; progress: number | null; memo: string }) => Promise<boolean>
}) {
  const total = rows.reduce((s, r) => s + calcClawback(r, config).total, 0)
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
      <table className="w-full min-w-[1240px] text-sm">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs text-gray-500">
            <th className="px-2 py-2 font-medium">C 상호명</th>
            <th className="w-[120px] px-2 py-2 text-right font-medium" title="적으면 계산 대신 이 금액을 환수한다">D 환수액(직접입력)</th>
            <th className="w-[120px] px-2 py-2 text-right font-medium">E 계약금액(VAT포함)</th>
            <th className="w-[100px] px-2 py-2 text-right font-medium">F 공급가</th>
            <th className="w-[60px] px-2 py-2 text-right font-medium">G 지급률</th>
            <th className="w-[70px] px-2 py-2 text-right font-medium">H 진행률</th>
            <th className="w-[60px] px-2 py-2 text-right font-medium">I 인정률</th>
            <th className="w-[100px] px-2 py-2 text-right font-medium">J 지급액</th>
            <th className="w-[100px] px-2 py-2 text-right font-medium">K 인정액</th>
            <th className="w-[100px] px-2 py-2 text-right font-medium">L 환수액(최종)</th>
            <th className="px-2 py-2 font-medium">M 메모</th>
            <th className="w-[100px] px-2 py-2 font-medium">N 등록일</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const c = calcClawback(r, config)
            return (
              <tr key={r.id} className="group border-b border-gray-100 align-top last:border-0">
                <td className="min-w-[180px] px-1 py-1">
                  <TextCell label="상호명" value={r.client_name} disabled={locked} onSave={(v) => onPatch(r, { client_name: v })} />
                </td>
                <td className="px-1 py-1">
                  <MoneyCell label="환수액 직접 입력" value={r.direct_amount} disabled={locked} onSave={(v) => onPatch(r, { direct_amount: v })} />
                </td>
                <td className="px-1 py-1">
                  <MoneyCell label="계약금액" value={r.contract_amount} disabled={locked} onSave={(v) => onPatch(r, { contract_amount: v })} />
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-600">{won(c.supply)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-600">{pct(c.paidRate)}</td>
                <td className="px-1 py-1">
                  <TextCell
                    label="진행률"
                    value={r.progress === null ? '' : String(r.progress)}
                    disabled={locked}
                    className="text-right tabular-nums"
                    display={r.progress === null ? <span className="text-gray-300">0%</span> : `${r.progress}%`}
                    onSave={async (v) => {
                      const t = v.replace('%', '').trim()
                      if (t === '') return onPatch(r, { progress: null })
                      const n = Number(t)
                      if (Number.isFinite(n) && n >= 0 && n <= 100) return onPatch(r, { progress: n })
                    }}
                  />
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-600">{pct(c.allowedRate)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-600">{won(c.paidAmount)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-600">{won(c.allowedAmount)}</td>
                <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{won(c.total)}</td>
                <td className="min-w-[220px] px-1 py-1">
                  <TextCell label="메모" multiline value={r.memo} disabled={locked} onSave={(v) => onPatch(r, { memo: v })} />
                </td>
                <td className="px-1 py-1">
                  <TextCell label="등록일" value={r.registered_on ?? ''} disabled={locked} placeholder="YYYY-MM-DD"
                    onSave={async (v) => {
                      const t = v.trim()
                      if (t === '') return onPatch(r, { registered_on: null })
                      if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return onPatch(r, { registered_on: t })
                    }} />
                </td>
                <td className="px-1 py-1.5">
                  {!locked && (
                    <ConfirmButton confirmText="삭제" onConfirm={() => onDelete(r)}
                      className="rounded p-0.5 text-gray-400 opacity-40 hover:bg-red-50 hover:text-red-500 group-hover:opacity-100">
                      <Trash2 size={13} aria-label="환수 줄 삭제" />
                    </ConfirmButton>
                  )}
                </td>
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr><td colSpan={13} className="px-3 py-4 text-center text-sm text-gray-400">이 달 환수 건이 없습니다.</td></tr>
          )}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr className="border-t border-gray-200 bg-gray-50 font-semibold">
              <td colSpan={9} className="px-2 py-2 text-right text-gray-500">환수 합계 (월 정산 O)</td>
              <td className="px-2 py-2 text-right tabular-nums">{won(total)}</td>
              <td colSpan={3} />
            </tr>
          </tfoot>
        )}
      </table>
      {!locked && <AddClawbackRow onAdd={onAdd} />}
    </div>
  )
}

function AddClawbackRow({ onAdd }: { onAdd: (fields: { client_name: string; direct_amount: number | null; contract_amount: number | null; progress: number | null; memo: string }) => Promise<boolean> }) {
  const [name, setName] = useState('')
  const [direct, setDirect] = useState('')
  const [contract, setContract] = useState('')
  const [progress, setProgress] = useState('')
  const [memo, setMemo] = useState('')
  const [saving, setSaving] = useState(false)

  const progressValue = progress.trim() === '' ? null : Number(progress.replace('%', ''))
  const progressOk = progressValue === null || (Number.isFinite(progressValue) && progressValue >= 0 && progressValue <= 100)

  async function submit() {
    if (!name.trim() || !progressOk) return
    setSaving(true)
    const ok = await onAdd({
      client_name: name.trim(),
      direct_amount: direct === '' ? null : Number(direct),
      contract_amount: contract === '' ? null : Number(contract),
      progress: progressValue,
      memo,
    })
    setSaving(false)
    if (ok) { setName(''); setDirect(''); setContract(''); setProgress(''); setMemo('') }
  }

  const input = 'h-8 rounded-lg border border-gray-200 bg-white px-2 text-sm outline-none focus:border-blue-300'
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-dashed border-gray-200 bg-gray-50/60 px-3 py-2">
      <span className="text-xs font-semibold text-gray-500">환수 추가</span>
      <input className={`${input} w-52`} placeholder="C 상호명" aria-label="환수 상호명" value={name} onChange={(e) => setName(e.target.value)} />
      <CurrencyInput className="h-8 w-32 bg-white text-sm" placeholder="E 계약금액" aria-label="환수 계약금액" value={contract} onChange={setContract} />
      <input className={`${input} w-24 ${progressOk ? '' : 'border-red-400'}`} placeholder="H 진행률 %" aria-label="환수 진행률" value={progress} onChange={(e) => setProgress(e.target.value)} />
      <CurrencyInput className="h-8 w-32 bg-white text-sm" placeholder="D 직접 (선택)" aria-label="환수액 직접 입력" value={direct} onChange={setDirect} />
      <input className={`${input} min-w-56 flex-1`} placeholder="M 메모" aria-label="환수 메모" value={memo} onChange={(e) => setMemo(e.target.value)} />
      <Button size="sm" variant="outline" disabled={saving || !name.trim() || !progressOk} onClick={submit}>추가</Button>
    </div>
  )
}
