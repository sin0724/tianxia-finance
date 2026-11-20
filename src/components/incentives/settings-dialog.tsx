'use client'

import { useState } from 'react'
import Decimal from 'decimal.js'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CurrencyInput } from '@/components/ui/currency-input'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/lib/toast'
import type { IncentiveConfig } from '@/lib/incentives/engine'
import { duplicateCrmNames, slackOptions } from '@/lib/incentives/owners'
import type { IncentiveManager } from '@/types/database'
import { call, errorText } from './cells'

/** 정산시트 "설정" 탭 — 기본값 · 담당자 매핑 · 환수 인정률 구간 */

const toPct = (n: number) => new Decimal(String(n)).times(100).toString()
function fromPct(s: string): number | null {
  const t = s.replace('%', '').trim()
  if (!/^\d+(\.\d+)?$/.test(t)) return null
  const v = new Decimal(t).div(100)
  return v.gt(1) ? null : v.toNumber()
}
const splitNames = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

interface ManagerDraft {
  id?: string
  name: string
  crm: string
  /** Slack /결제 담당자 목록에 보일 이름 — 저장할 때 CRM 담당자명에도 들어간다 */
  slack: string
  base: string
  /** 담당자 기본 인센티브율 (%). 비우면 설정의 기본 인센티브율 */
  rate: string
  sort: string
  active: boolean
}

interface TierDraft { min: string; rate: string }

export function SettingsDialog({
  open, onOpenChange, config, managers, onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  config: IncentiveConfig
  managers: IncentiveManager[]
  onSaved: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl">
        {/* 열 때마다 저장된 값으로 새로 시작한다 */}
        {open && <SettingsForm config={config} managers={managers} onClose={() => onOpenChange(false)} onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  )
}

function SettingsForm({ config, managers, onClose, onSaved }: {
  config: IncentiveConfig
  managers: IncentiveManager[]
  onClose: () => void
  onSaved: () => void
}) {
  const [vat, setVat] = useState(toPct(config.vatRate))
  const [rate, setRate] = useState(toPct(config.defaultRate))
  const [base, setBase] = useState(String(config.defaultBase))
  const [statuses, setStatuses] = useState(config.fullStatuses.join(', '))
  const [paidRate, setPaidRate] = useState(toPct(config.paidRate))
  const [tiers, setTiers] = useState<TierDraft[]>(config.tiers.map((t) => ({ min: String(t.min), rate: String(t.rate) })))
  const [people, setPeople] = useState<ManagerDraft[]>(managers.map((m) => ({
    id: m.id, name: m.name, crm: m.crm_names.join(', '), slack: (m.slack_names ?? []).join(', '),
    base: m.base_salary === null ? '' : String(m.base_salary),
    rate: (m.default_rate ?? null) === null ? '' : toPct(Number(m.default_rate)),
    sort: String(m.sort_order), active: m.active,
  })))
  const [saving, setSaving] = useState(false)

  const setPerson = (i: number, patch: Partial<ManagerDraft>) => setPeople((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  const setTier = (i: number, patch: Partial<TierDraft>) => setTiers((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)))
  /** 저장될 CRM 담당자명 — 적은 CRM 담당자명 + Slack 결제 담당자 */
  const crmOf = (p: ManagerDraft) => [...new Set([...splitNames(p.crm), ...splitNames(p.slack)])]
  const slackPreview = slackOptions(people.map((p, i) => ({
    name: p.name, active: p.active, slack_names: splitNames(p.slack),
    sort_order: p.sort.trim() === '' || !Number.isInteger(Number(p.sort)) ? i + 1 : Number(p.sort),
  })))

  async function save() {
    const vatRate = fromPct(vat)
    const defaultRate = fromPct(rate)
    const paid = fromPct(paidRate)
    if (vatRate === null || defaultRate === null || paid === null) { toast.error('비율은 0~100 사이 숫자로 적어 주세요.'); return }
    if (base === '' || !Number.isSafeInteger(Number(base)) || Number(base) < 0) { toast.error('기본급을 확인해 주세요.'); return }
    const full = splitNames(statuses)
    if (!full.length) { toast.error('동기화 대상 입금상태를 하나 이상 적어 주세요.'); return }
    const tierRows = tiers.filter((t) => t.min.trim() !== '' || t.rate.trim() !== '').map((t) => ({ min: Number(t.min), rate: Number(t.rate) }))
    if (!tierRows.length || tierRows.some((t) => !Number.isFinite(t.min) || !Number.isFinite(t.rate) || t.min < 0 || t.min > 100 || t.rate < 0 || t.rate > 100)) {
      toast.error('환수 인정률 구간을 확인해 주세요 (0~100).'); return
    }
    const peopleRows = people.filter((p) => p.id || p.name.trim())
    for (const p of peopleRows) {
      if (!p.name.trim() || !crmOf(p).length) { toast.error('담당자 이름과 CRM 담당자명(또는 Slack 결제 담당자)을 적어 주세요.'); return }
      if (p.base !== '' && (!Number.isSafeInteger(Number(p.base)) || Number(p.base) < 0)) { toast.error(`${p.name} 기본급을 확인해 주세요.`); return }
      if (p.rate.trim() !== '' && fromPct(p.rate) === null) { toast.error(`${p.name} 기본율을 확인해 주세요 (0~100, 비우면 설정의 기본 인센티브율).`); return }
    }
    const dup = duplicateCrmNames(peopleRows.map((p) => ({ name: p.name.trim(), crm_names: crmOf(p) })))
    if (dup.length) {
      toast.error(`CRM 담당자명은 한 담당자에만 둡니다: ${dup.map((d) => `‘${d.crmName}’ (${d.managers.join(', ')})`).join(' · ')}`)
      return
    }

    setSaving(true)
    try {
      await call('PATCH', '/api/incentives/setup', {
        settings: {
          vat_rate: vatRate, default_rate: defaultRate, default_base: Number(base), full_statuses: full, paid_rate: paid, tiers: tierRows,
        },
        managers: peopleRows.map((p, i) => ({
          id: p.id, name: p.name.trim(), crm_names: crmOf(p), slack_names: splitNames(p.slack),
          base_salary: p.base === '' ? null : Number(p.base),
          default_rate: p.rate.trim() === '' ? null : fromPct(p.rate),
          sort_order: p.sort.trim() === '' || !Number.isInteger(Number(p.sort)) ? i + 1 : Number(p.sort),
          active: p.active,
        })),
      })
      toast.success('설정을 저장했습니다.')
      onSaved()
      onClose()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  const input = 'h-8 w-full rounded-lg border border-gray-200 bg-white px-2 text-sm outline-none focus:border-blue-300'
  const label = 'text-xs font-semibold text-gray-500'
  return (
    <>
      <DialogHeader><DialogTitle>인센티브 정산 설정</DialogTitle></DialogHeader>
      <div className="space-y-6">
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className="space-y-1"><span className={label}>VAT율 (%)</span>
            <input className={input} value={vat} onChange={(e) => setVat(e.target.value)} aria-label="VAT율" />
          </label>
          <label className="space-y-1"><span className={label}>기본 인센티브율 (%) — F를 비우면</span>
            <input className={input} value={rate} onChange={(e) => setRate(e.target.value)} aria-label="기본 인센티브율" />
          </label>
          <label className="space-y-1"><span className={label}>기본급 (새 달 I 기본값)</span>
            <CurrencyInput className="h-8 bg-white text-sm" value={base} onChange={setBase} aria-label="기본급" />
          </label>
          <label className="col-span-2 space-y-1"><span className={label}>동기화 대상 입금상태 (쉼표로 여러 개)</span>
            <input className={input} value={statuses} onChange={(e) => setStatuses(e.target.value)} aria-label="동기화 대상 입금상태" />
          </label>
          <label className="space-y-1"><span className={label}>기본 지급률 (%) — 환수 계산</span>
            <input className={input} value={paidRate} onChange={(e) => setPaidRate(e.target.value)} aria-label="기본 지급률" />
          </label>
        </section>

        <section className="space-y-2">
          <p className="text-sm font-bold text-gray-900">담당자 매핑</p>
          <div className="grid grid-cols-[0.9fr_1.5fr_1.3fr_1fr_76px_52px_44px_24px] items-center gap-2 text-xs text-gray-500">
            <span>정산표 이름</span><span>CRM 담당자명 (쉼표로 여러 개)</span><span>Slack /결제 담당자 (쉼표)</span>
            <span>기본급 (비우면 기본값)</span><span>기본율 %</span><span>순서</span><span>사용</span><span />
            {people.map((p, i) => (
              <div key={p.id ?? `new-${i}`} className="contents">
                <input className={input} value={p.name} onChange={(e) => setPerson(i, { name: e.target.value })} aria-label="정산표 이름" />
                <input className={input} value={p.crm} onChange={(e) => setPerson(i, { crm: e.target.value })} aria-label={`${p.name || '새 담당자'} CRM 담당자명`} />
                <input className={input} value={p.slack} placeholder="예: 이름 0팀" onChange={(e) => setPerson(i, { slack: e.target.value })} aria-label={`${p.name || '새 담당자'} Slack 결제 담당자`} />
                <CurrencyInput className="h-8 bg-white text-sm" placeholder="기본값" value={p.base} onChange={(v) => setPerson(i, { base: v })} aria-label={`${p.name || '새 담당자'} 기본급`} />
                <input className={input} value={p.rate} placeholder={toPct(config.defaultRate)} onChange={(e) => setPerson(i, { rate: e.target.value })} aria-label={`${p.name || '새 담당자'} 기본 인센티브율`} />
                <input className={input} value={p.sort} onChange={(e) => setPerson(i, { sort: e.target.value })} aria-label="순서" />
                <input type="checkbox" className="size-4 justify-self-center" checked={p.active} onChange={(e) => setPerson(i, { active: e.target.checked })} aria-label="사용" />
                {p.id ? <span /> : (
                  <button type="button" className="text-gray-400 hover:text-red-500" aria-label="새 담당자 줄 지우기" onClick={() => setPeople((ps) => ps.filter((_, j) => j !== i))}>
                    <X size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <Button size="xs" variant="outline" onClick={() => setPeople((ps) => [...ps, { name: '', crm: '', slack: '', base: '', rate: '', sort: String(ps.length + 1), active: true }])}>
            <Plus size={12} /> 담당자 추가
          </Button>
          <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
            <span className="font-semibold">Slack /결제 담당자 목록</span>{' '}
            {slackPreview.length ? slackPreview.join(' · ') : '(아무도 적지 않음 — Slack은 예전 고정 목록을 씁니다)'}
          </p>
          <p className="text-xs text-gray-400">
            새 사람이 오면 담당자를 추가하고 Slack /결제 담당자에 &lsquo;이름 0팀&rsquo;처럼 적으면 됩니다. 저장하면 Slack /결제 목록에 나오고, 그 이름으로 등록한 결제는 이 담당자 정산에 들어갑니다 (CRM 담당자명에도 자동으로 들어감).
            CRM 담당자명은 결제시트 담당자 칸과 글자까지 같게 적고, 한 이름은 한 담당자에만 넣습니다. 새 담당자를 저장하면 화면 위에 이 달 정산표 만들기가 나옵니다.
            담당자 기본급 · 기본율은 비우면 위 기본값을 쓰고, 새로 만드는 달부터 들어갑니다. 이미 만든 달은 정산표 위 I 기본급 · 기본 인센티브율에서 고칩니다.
            담당자는 지우지 않고 &lsquo;사용&rsquo;을 끕니다. 끈 담당자는 새 달 정산표 · CRM 동기화 · Slack 목록에서 빠집니다.
          </p>
        </section>

        <section className="space-y-2">
          <p className="text-sm font-bold text-gray-900">환수 인정률 구간 (진행률 → 인정 인센티브율)</p>
          <div className="grid max-w-sm grid-cols-[1fr_1fr_24px] items-center gap-2 text-xs text-gray-500">
            <span>진행률 이상 (%)</span><span>인정 인센티브율 (%)</span><span />
            {tiers.map((t, i) => (
              <div key={i} className="contents">
                <input className={input} value={t.min} onChange={(e) => setTier(i, { min: e.target.value })} aria-label="진행률 이상" />
                <input className={input} value={t.rate} onChange={(e) => setTier(i, { rate: e.target.value })} aria-label="인정 인센티브율" />
                <button type="button" className="text-gray-400 hover:text-red-500" aria-label="구간 지우기" onClick={() => setTiers((ts) => ts.filter((_, j) => j !== i))}>
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
          <Button size="xs" variant="outline" onClick={() => setTiers((ts) => [...ts, { min: '', rate: '' }])}>
            <Plus size={12} /> 구간 추가
          </Button>
        </section>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>취소</Button>
        <Button onClick={save} disabled={saving}>{saving ? '저장 중…' : '저장'}</Button>
      </DialogFooter>
    </>
  )
}
