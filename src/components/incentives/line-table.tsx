'use client'

import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CurrencyInput } from '@/components/ui/currency-input'
import {
  baseSyncId, calcLine, formatRate, needsPaidInput, parseRate, type IncentiveConfig,
} from '@/lib/incentives/engine'
import type { ContractInfo, CrmView, FinanceView } from '@/lib/incentives/types'
import type { IncentiveLine } from '@/types/database'
import { ConfirmButton, FILL_BG, INPUT_BG, MoneyCell, TextCell, won } from './cells'

export type LinePatch = Partial<Pick<IncentiveLine, 'client_name' | 'sales' | 'paid' | 'rate' | 'note' | 'fill'>>

const KIND_LABEL: Record<IncentiveLine['kind'], string> = {
  contract: '', balance: '잔금 정산', installment: '분납', manual: '수동 추가',
}

const FILLS: { value: IncentiveLine['fill']; label: string; bg: string }[] = [
  { value: null, label: '색 없음', bg: '#ffffff' },
  { value: 'red', label: '빨강 (미입금)', bg: FILL_BG.red },
  { value: 'yellow', label: '노랑 (잔금 남음)', bg: FILL_BG.yellow },
  { value: 'green', label: '초록 (정산 완료)', bg: FILL_BG.green },
]

/** F칸 표시 — 숫자면 %, 계산식 · 작업별 구성이면 실제로 쓴 %와 원문 */
function RateDisplay({ rate, used, error, defaultRate }: { rate: string | null; used: string; error: string | null; defaultRate: number }) {
  if (error) return <span className="text-red-600" title={error}>읽을 수 없음 · {rate}</span>
  const spec = parseRate(rate)
  if (spec.kind === 'default') return <span className="text-gray-400">기본 {formatRate(defaultRate)}</span>
  if (rate && /^-?\d+(\.\d+)?%$/.test(rate.replace(/\s+/g, ''))) return <span>{used}</span>
  return (
    <span title={rate ?? ''}>
      <span className="font-semibold">{used}</span>
      <span className="block truncate max-w-[150px] text-[11px] text-gray-500">{rate}</span>
    </span>
  )
}

export function LineTable({
  lines, config, locked, finance, crm, contracts, onPatch, onDelete, onAdd,
}: {
  lines: IncentiveLine[]
  config: IncentiveConfig
  locked: boolean
  finance: FinanceView | null
  crm: CrmView | null
  contracts: Record<string, ContractInfo>
  onPatch: (line: IncentiveLine, patch: LinePatch) => Promise<unknown>
  onDelete: (line: IncentiveLine) => Promise<unknown>
  onAdd: (fields: { client_name: string; sales: number | null; paid: number | null; rate: string | null; note: string }) => Promise<boolean>
}) {
  const totals = lines.reduce(
    (t, l) => {
      const c = calcLine(l, config)
      return { sales: t.sales + (l.sales ?? 0), net: t.net + (c.net ?? 0), incentive: t.incentive + (c.incentive ?? 0) }
    },
    { sales: 0, net: 0, incentive: 0 },
  )

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
      <table className="w-full min-w-[1180px] text-sm">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs text-gray-500">
            <th className="w-8 px-2 py-2 font-medium">#</th>
            <th className="px-2 py-2 font-medium">A 상호명</th>
            <th className="w-[110px] px-2 py-2 text-right font-medium">B 매출</th>
            <th className="w-[100px] px-2 py-2 text-right font-medium">C 순매출</th>
            <th className="w-[120px] px-2 py-2 text-right font-medium" title="비어 있으면 매출 전액 기준, 0이면 인센 0. 빨간 칸은 입금액을 직접 적는 칸">
              D 인센 기준 입금액
            </th>
            <th className="w-[100px] px-2 py-2 text-right font-medium">E 인센티브</th>
            <th className="w-[120px] px-2 py-2 font-medium" title="비우면 기본율. 20 또는 20% · =230400/2700000 같은 계산식 · 작업별 구성(A 500만 20%, B 1500만 10%)">
              F 인센티브율
            </th>
            <th className="px-2 py-2 font-medium">G 비고</th>
            <th className="w-[170px] px-2 py-2 font-medium">재무관리 입금</th>
            <th className="w-[92px] px-2 py-2" />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const c = calcLine(l, config)
            const base = l.sync_id ? baseSyncId(l.sync_id) : null
            const crmRow = base ? crm?.bySid[base] : undefined
            const fin = base ? finance?.bySid[base] : undefined
            const contract = base ? contracts[base] : undefined
            const needs = needsPaidInput(l)
            // D를 손으로 채우는 줄(빨간 D칸 · 분납)에만 — [미입금] 줄은 CRM 동기화가 (잔금) 줄로 정산한다
            const canApply = !locked && !!fin && fin.monthIn > 0 && l.paid !== fin.monthIn && (needs || l.kind === 'installment')
            return (
              <tr
                key={l.id}
                id={`line-${l.id}`}
                className="group border-b border-gray-100 align-top last:border-0"
                style={l.fill ? { backgroundColor: FILL_BG[l.fill] } : undefined}
              >
                <td className="px-2 py-1.5 text-xs tabular-nums text-gray-400">{i + 1}</td>
                <td className="min-w-[190px] px-1 py-1">
                  <TextCell label="상호명" value={l.client_name} disabled={locked} onSave={(v) => onPatch(l, { client_name: v })} />
                  <div className="flex flex-wrap gap-x-2 px-1.5 text-[11px] text-gray-500">
                    {KIND_LABEL[l.kind] && <span>{KIND_LABEL[l.kind]}</span>}
                    {l.crm_date && <span>CRM {l.crm_date.slice(5).replace('-', '/')}</span>}
                    {crmRow && (
                      <span title={crmRow.memo || undefined} className={crmRow.memo ? 'cursor-help underline decoration-dotted' : undefined}>
                        {crmRow.status || '상태 없음'} · {won(crmRow.amount)}
                      </span>
                    )}
                    {base && crm && !crmRow && <span className="text-red-600">CRM에 없음</span>}
                  </div>
                </td>
                <td className="px-1 py-1">
                  <MoneyCell label="매출" value={l.sales} disabled={locked} onSave={(v) => onPatch(l, { sales: v })} />
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-gray-600">{won(c.net)}</td>
                <td className="px-1 py-1" style={needs ? { backgroundColor: INPUT_BG } : undefined}>
                  <MoneyCell label="인센 기준 입금액" value={l.paid} disabled={locked} placeholder={needs ? '입금액' : ''} onSave={(v) => onPatch(l, { paid: v })} />
                </td>
                <td className="px-2 py-1.5 text-right font-semibold tabular-nums">
                  {c.error ? <span className="text-red-600" title={c.error}>오류</span> : won(c.incentive)}
                </td>
                <td className="px-1 py-1">
                  <TextCell
                    label="인센티브율"
                    value={l.rate ?? ''}
                    disabled={locked}
                    placeholder="기본율"
                    display={<RateDisplay rate={l.rate} used={formatRate(c.rate)} error={c.error} defaultRate={config.defaultRate} />}
                    onSave={(v) => onPatch(l, { rate: v.trim() === '' ? null : v })}
                  />
                </td>
                <td className="min-w-[300px] px-1 py-1">
                  <TextCell label="비고" multiline value={l.note} disabled={locked} onSave={(v) => onPatch(l, { note: v })} />
                </td>
                <td className="px-2 py-1.5 text-[11px] leading-4 text-gray-600">
                  {!base ? (
                    <span className="text-gray-300">CRM 연결 없음</span>
                  ) : !finance ? null : !fin ? (
                    <span className="text-gray-400">재무관리 결제 없음</span>
                  ) : (
                    <div className="space-y-0.5" title={fin.entries.map((e) => `${e.date.slice(5)} ${won(e.amount)}`).join('\n') || undefined}>
                      <div>
                        이 달 입금 <b className={fin.monthIn ? 'text-gray-900' : 'text-gray-400'}>{won(fin.monthIn)}</b>
                        {fin.monthRefund !== 0 && <span className="text-red-600"> · 환불 {won(fin.monthRefund)}</span>}
                      </div>
                      <div className="text-gray-500">
                        누계 {won(fin.toDate)}{fin.pending ? ` · 미수 ${won(fin.pending)}` : ''}
                      </div>
                      {contract && l.kind !== 'contract' && (
                        <div className="text-gray-500">정산 누계 {won(contract.settled)}</div>
                      )}
                      {canApply && (
                        <button type="button" className="font-semibold text-blue-600 hover:underline" onClick={() => onPatch(l, { paid: fin.monthIn })}>
                          D에 {won(fin.monthIn)} 넣기
                        </button>
                      )}
                    </div>
                  )}
                </td>
                <td className="px-1 py-1.5">
                  {!locked && (
                    <div className="flex items-center justify-end gap-1 opacity-40 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      {FILLS.map((f) => (
                        <button
                          key={f.label}
                          type="button"
                          title={f.label}
                          aria-label={`줄 색: ${f.label}`}
                          onClick={() => onPatch(l, { fill: f.value })}
                          className={`size-3.5 rounded-full border ${l.fill === f.value ? 'border-gray-700' : 'border-gray-300'}`}
                          style={{ backgroundColor: f.bg }}
                        />
                      ))}
                      <ConfirmButton
                        confirmText="삭제"
                        onConfirm={() => onDelete(l)}
                        className="ml-0.5 rounded p-0.5 text-gray-400 hover:bg-red-50 hover:text-red-500"
                      >
                        <Trash2 size={13} aria-label="줄 삭제" />
                      </ConfirmButton>
                    </div>
                  )}
                </td>
              </tr>
            )
          })}
          {lines.length === 0 && (
            <tr>
              <td colSpan={10} className="px-3 py-6 text-center text-sm text-gray-400">줄이 없습니다. CRM 동기화를 하거나 줄을 추가해 주세요.</td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr className="border-t border-gray-200 bg-gray-50 text-sm font-semibold">
            <td />
            <td className="px-2 py-2 text-gray-500">합계</td>
            <td className="px-2 py-2 text-right tabular-nums">{won(totals.sales)}</td>
            <td className="px-2 py-2 text-right tabular-nums text-gray-600">{won(totals.net)}</td>
            <td />
            <td className="px-2 py-2 text-right tabular-nums">{won(totals.incentive)}</td>
            <td colSpan={4} />
          </tr>
        </tfoot>
      </table>
      {!locked && <AddLineRow onAdd={onAdd} />}
    </div>
  )
}

function AddLineRow({ onAdd }: { onAdd: (fields: { client_name: string; sales: number | null; paid: number | null; rate: string | null; note: string }) => Promise<boolean> }) {
  const [name, setName] = useState('')
  const [sales, setSales] = useState('')
  const [paid, setPaid] = useState('')
  const [rate, setRate] = useState('20%')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!name.trim()) return
    setSaving(true)
    const ok = await onAdd({
      client_name: name.trim(),
      sales: sales === '' ? 0 : Number(sales),
      paid: paid === '' ? null : Number(paid),
      rate: rate.trim() || null,
      note,
    })
    setSaving(false)
    if (ok) { setName(''); setSales(''); setPaid(''); setRate('20%'); setNote('') }
  }

  const input = 'h-8 rounded-lg border border-gray-200 bg-white px-2 text-sm outline-none focus:border-blue-300'
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-dashed border-gray-200 bg-gray-50/60 px-3 py-2">
      <span className="text-xs font-semibold text-gray-500">줄 추가</span>
      <input className={`${input} w-52`} placeholder="A 상호명" aria-label="새 줄 상호명" value={name} onChange={(e) => setName(e.target.value)} />
      <CurrencyInput className="h-8 w-32 bg-white text-sm" placeholder="B 매출" aria-label="새 줄 매출" value={sales} onChange={setSales} />
      <CurrencyInput className="h-8 w-32 bg-white text-sm" placeholder="D 입금액 (선택)" aria-label="새 줄 인센 기준 입금액" value={paid} onChange={setPaid} />
      <input className={`${input} w-24`} placeholder="F 율" aria-label="새 줄 인센티브율" value={rate} onChange={(e) => setRate(e.target.value)} />
      <input className={`${input} min-w-64 flex-1`} placeholder="G 비고 (예: 분납 12월분 (2,673만 중 6회차 · 수동 추가))" aria-label="새 줄 비고" value={note} onChange={(e) => setNote(e.target.value)} />
      <Button size="sm" variant="outline" disabled={saving || !name.trim()} onClick={submit}>추가</Button>
    </div>
  )
}
