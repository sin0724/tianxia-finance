'use client'

/**
 * 월 마감 — 통장·카드 내역을 올리면 분류·결제 매칭·정산까지 이어진다.
 *
 *   1. 통장 거래내역 CSV / 카드 승인내역 XLS 업로드 (겹쳐 올려도 중복 저장 안 됨)
 *   2. 점검: 월말까지 들어왔는지, 잔액 연속, 미분류, 결제와 연결 안 된 매출 입금, 급여 확정 여부
 *   3. 거래 분류 확인·수정 — "앞으로도 이렇게"를 고르면 다음 업로드부터 자동 적용
 *   4. 정산 미리보기 → 저장 (대시보드·연간 분석에 반영)
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/lib/toast'
import { formatKRW } from '@/lib/calculations/settlement'
import { MonthNavigator } from '@/components/shared/month-navigator'
import { useMonth } from '@/components/shared/month-context'
import { CATEGORIES, categoryOf, type CategoryKey } from '@/lib/ledger/categories'
import { pendingConfirmAmount, rankPaymentCandidates, type MatchPayment } from '@/lib/ledger/match'
import type { SettleResult } from '@/lib/ledger/settle'
import type { ClosingChecks } from '@/lib/ledger/server'
import type { BankTransaction, CardTransaction } from '@/types/database'
import { AlertTriangle, CheckCircle2, RefreshCw, Upload } from 'lucide-react'

type Filter = 'review' | 'all' | 'non_pl'

type LinkablePayment = MatchPayment & { project_id: string | null }

const SEARCH_DAYS = 120
const shiftDate = (date: string, days: number) => new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10)

const CLS_LABEL: Record<string, string> = {
  revenue: '매출', expense: '비용', payroll_cash: '급여 현금', card: '카드대금', non_pl: '손익 외', unclassified: '미분류',
}
const CLS_COLOR: Record<string, string> = {
  revenue: 'text-blue-700 bg-blue-50', expense: 'text-gray-700 bg-gray-50', payroll_cash: 'text-purple-700 bg-purple-50',
  card: 'text-amber-700 bg-amber-50', non_pl: 'text-teal-700 bg-teal-50', unclassified: 'text-red-700 bg-red-50',
}

function CheckRow({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm py-1">
      {ok ? <CheckCircle2 size={16} className="text-green-600 mt-0.5 shrink-0" /> : <AlertTriangle size={16} className="text-amber-500 mt-0.5 shrink-0" />}
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export default function ClosingPage() {
  const supabase = createClient()
  const { year, month } = useMonth()
  const mm = String(month).padStart(2, '0')
  const start = `${year}-${mm}-01`
  const end = `${year}-${mm}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`

  const [txs, setTxs] = useState<BankTransaction[]>([])
  const [cards, setCards] = useState<CardTransaction[]>([])
  const [result, setResult] = useState<SettleResult | null>(null)
  const [checks, setChecks] = useState<ClosingChecks | null>(null)
  const [saved, setSaved] = useState<{ basis: string; calculated_at: string; distributable_profit: number } | null>(null)
  const [reps, setReps] = useState<{ id: string; name: string; share_ratio: number }[]>([])
  const [fx, setFx] = useState('')
  const [filter, setFilter] = useState<Filter>('review')
  const [uploading, setUploading] = useState<'bank' | 'card' | null>(null)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [remember, setRemember] = useState(true)
  const [linkTx, setLinkTx] = useState<BankTransaction | null>(null)
  const [linkPays, setLinkPays] = useState<LinkablePayment[] | null>(null)
  const [linkQuery, setLinkQuery] = useState('')
  const [linkedIds, setLinkedIds] = useState<Set<string>>(new Set())
  const [linking, setLinking] = useState(false)

  const loadPreview = useCallback(async (fxValue?: string) => {
    const q = new URLSearchParams({ year: String(year), month: String(month) })
    if (fxValue) q.set('fx', fxValue)
    const res = await fetch(`/api/ledger/settle?${q}`)
    const json = await res.json()
    if (!res.ok) { toast.error(json.error ?? '정산 미리보기 실패'); return }
    setResult(json.result)
    setChecks(json.checks)
    if (!fxValue) setFx(String(json.result.card_fx_rate))
  }, [year, month])

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: bank }, { data: card }, { data: st }, { data: repRows }] = await Promise.all([
      supabase.from('bank_transactions').select('*').gte('tx_date', start).lte('tx_date', end).order('seq'),
      supabase.from('card_transactions').select('*').gte('approved_date', start).lte('approved_date', end).order('approved_at'),
      supabase.from('monthly_settlements').select('basis, calculated_at, distributable_profit').eq('year', year).eq('month', month).maybeSingle(),
      supabase.from('representatives').select('id, name, share_ratio').order('created_at'),
    ])
    setTxs(bank ?? [])
    setCards(card ?? [])
    setSaved(st ?? null)
    setReps(repRows ?? [])
    await loadPreview()
    setLoading(false)
  }, [supabase, start, end, year, month, loadPreview])

  useEffect(() => { load() }, [load])

  async function upload(kind: 'bank' | 'card', file: File | undefined) {
    if (!file) return
    setUploading(kind)
    try {
      const form = new FormData()
      form.set('kind', kind)
      form.set('file', file)
      const res = await fetch('/api/ledger/import', { method: 'POST', body: form })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error ?? '업로드 실패'); return }
      const parts = [`${json.inserted}건 저장`, json.skipped ? `${json.skipped}건은 이미 있음` : '']
      if (kind === 'bank') {
        if (json.matchedPayments) parts.push(`결제 ${json.matchedPayments}건 연결`)
        if (json.confirmedPending) parts.push(`수금 예정 ${json.confirmedPending}건 입금 확정`)
      }
      toast.success(`${kind === 'bank' ? '통장' : '카드'} ${json.period?.start ?? ''} ~ ${json.period?.end ?? ''}: ${parts.filter(Boolean).join(' · ')}`)
      for (const w of json.joinBreaks ?? []) toast.warning(w)
      if (json.balanceBreaks) toast.warning(`파일 안에서 잔액이 ${json.balanceBreaks}곳 끊깁니다. 원본 파일을 확인해 주세요.`)
      await load()
    } finally {
      setUploading(null)
    }
  }

  async function reclassify(tx: BankTransaction, category: CategoryKey) {
    const { error } = await supabase.from('bank_transactions')
      .update({ category, classified_by: 'manual' }).eq('id', tx.id)
    if (error) { toast.error(error.message); return }
    if (remember && tx.counterparty) {
      const direction = tx.deposit > 0 ? 'in' : 'out'
      await supabase.from('classification_rules').insert({ counterparty: tx.counterparty, direction, category, priority: 100 })
      // 같은 거래처의 자동 분류 거래(이 달)도 함께 바꾼다 — 손으로 고친 건과 급여 이체는 그대로 둔다
      await supabase.from('bank_transactions').update({ category, classified_by: 'user_rule' })
        .eq('counterparty', tx.counterparty).eq('classified_by', 'rule')
        .not('category', 'in', '(payroll_pay,incentive_pay)')
        .gte('tx_date', start).lte('tx_date', end)
        .gt(direction === 'in' ? 'deposit' : 'withdrawal', 0)
    }
    await load()
  }

  // 새로 등록하기 전에 수기로 넣어 둔 결제부터 찾는다. 바로 등록하면 같은 입금이 두 번 잡힌다
  async function openLink(tx: BankTransaction) {
    setLinkTx(tx)
    setLinkPays(null)
    setLinkQuery('')
    const [{ data: pays, error }, { data: linked }] = await Promise.all([
      supabase.from('payments')
        .select('id, payment_date, amount, status, client_name_raw, memo, project_id, excluded, projects(name)')
        .gte('payment_date', shiftDate(tx.tx_date, -SEARCH_DAYS)).lte('payment_date', shiftDate(tx.tx_date, SEARCH_DAYS)),
      supabase.from('bank_transactions').select('payment_id').not('payment_id', 'is', null),
    ])
    if (error) { toast.error(error.message); setLinkTx(null); return }
    const list: LinkablePayment[] = (pays ?? []).filter((p) => !p.excluded).map((p) => ({
      ...p, project_name: (p.projects as unknown as { name: string } | null)?.name ?? null,
    }))
    setLinkedIds(new Set((linked ?? []).map((r) => r.payment_id as string)))
    setLinkPays(list)
  }

  async function linkPayment(tx: BankTransaction, p: LinkablePayment) {
    setLinking(true)
    try {
      if (p.status !== 'confirmed') {
        const { error } = await supabase.rpc('confirm_pending_payment', {
          p_payment_id: p.id, p_amount: pendingConfirmAmount(tx, p), p_payment_date: tx.tx_date, p_project_id: p.project_id,
        })
        if (error) { toast.error(error.message); return }
      }
      const { error } = await supabase.from('bank_transactions').update({ payment_id: p.id }).eq('id', tx.id)
      if (error) { toast.error(error.message); return }
      toast.success(`${tx.counterparty} 입금을 기존 결제에 연결했어요.`)
      setLinkTx(null)
      await load()
    } finally {
      setLinking(false)
    }
  }

  async function registerPayment(tx: BankTransaction) {
    const amount = tx.deposit - tx.withdrawal
    const { data, error } = await supabase.rpc('add_payment_with_auto_project', {
      p_amount: amount, p_payment_date: tx.tx_date, p_client_name: tx.counterparty,
      p_memo: tx.memo || '통장 입금으로 등록', p_status: 'confirmed',
    })
    if (error) { toast.error(error.message); return }
    const paymentId = (data as { payment_id: string }).payment_id
    await supabase.from('bank_transactions').update({ payment_id: paymentId }).eq('id', tx.id)
    toast.success(`${tx.counterparty} ${formatKRW(amount)} 결제 내역에 등록했어요. 프로젝트·담당자는 결제 내역에서 확인해 주세요.`)
    setLinkTx(null)
    await load()
  }

  async function toggleCardExcluded(c: CardTransaction) {
    const { error } = await supabase.from('card_transactions').update({ excluded: !c.excluded }).eq('id', c.id)
    if (error) { toast.error(error.message); return }
    await load()
  }

  async function save() {
    setSaving(true)
    try {
      const res = await fetch('/api/ledger/settle', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, month, fx: Number(fx) || undefined }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error ?? '저장 실패'); return }
      toast.success(`${year}년 ${month}월 정산을 저장했어요 (통장 기준)`)
      await load()
    } finally {
      setSaving(false)
    }
  }

  // 자동으로 기타 경비가 된 건만 확인 대상이다. 사람이 확인·지정한 건은 다시 묻지 않는다
  const needsExpenseCheck = (t: BankTransaction) => t.category === 'other_expense' && t.classified_by === 'rule'
  const candidates = useMemo(
    () => (linkTx && linkPays ? rankPaymentCandidates(linkTx, linkPays, { query: linkQuery }) : null),
    [linkTx, linkPays, linkQuery],
  )
  const unmatchedIds = useMemo(() => new Set((checks?.unmatchedRevenue ?? []).map((r) => r.id)), [checks])
  const shown = txs.filter((t) => {
    const cls = categoryOf(t.category).cls
    if (filter === 'all') return true
    if (filter === 'non_pl') return cls === 'non_pl'
    return !t.cancelled && (cls === 'unclassified' || unmatchedIds.has(t.id) || needsExpenseCheck(t))
  })

  const r = result
  const lines: { label: string; value: number; strong?: boolean }[] = r ? [
    { label: '총매출 (VAT 포함, 통장 입금 − 환불)', value: r.total_revenue },
    { label: '공급가액', value: r.supply_value },
    { label: '− 인센티브', value: -r.total_incentive },
    { label: '− 실행비 (실제 지급)', value: -r.total_product_cost },
    { label: '매출총이익', value: r.gross_profit, strong: true },
    { label: '− 고정비', value: -r.total_fixed_cost },
    { label: `− 변동비 (카드 ${formatKRW(r.breakdown.card.krw + r.breakdown.card.foreignKrw)} 포함)`, value: -r.total_variable_cost },
    { label: '− 특수비용', value: -r.total_special_cost },
    { label: '− 급여 (세전, 급여 대장)', value: -r.total_payroll },
    { label: `− 4대보험 회사부담${r.breakdown.employerInsuranceEstimated ? ' (납부액으로 추정)' : ''}`, value: -r.total_employer_insurance },
    ...(r.gonggu_margin ? [{ label: '+ 공구 마진', value: r.gonggu_margin }] : []),
    { label: '영업이익', value: r.operating_profit, strong: true },
    { label: '− 법인세 적립', value: -r.corporate_tax_reserve },
    { label: '− 유보금 적립', value: -r.retained_earnings },
    { label: '분배 가능 이익', value: r.distributable_profit, strong: true },
  ] : []

  const nonPl = r ? Object.entries(r.breakdown.byCategory)
    .filter(([k]) => ['non_pl', 'payroll_cash', 'card'].includes(categoryOf(k).cls))
    .sort((a, b) => (b[1].out + b[1].in) - (a[1].out + a[1].in)) : []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">월 마감</h1>
          <p className="text-xs text-gray-500 mt-0.5">통장·카드 내역을 올리면 분류·결제 매칭·정산까지 자동으로 계산합니다</p>
        </div>
        <div className="flex items-center gap-2">
          <MonthNavigator />
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </Button>
        </div>
      </div>

      {/* 1. 업로드 */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">1. 내역 올리기</CardTitle></CardHeader>
        <CardContent className="grid sm:grid-cols-2 gap-3">
          {([
            ['bank', '통장 거래내역', 'KB국민은행 거래내역 CSV·XLS', '.csv,.xls,.xlsx'],
            ['card', '카드 승인내역', 'KB 법인카드 승인내역조회 XLS', '.xls,.xlsx'],
          ] as const).map(([kind, title, hint, accept]) => (
            <label key={kind} className="border border-dashed rounded-lg p-4 flex items-center gap-3 cursor-pointer hover:bg-gray-50">
              {uploading === kind ? <RefreshCw size={20} className="animate-spin text-gray-400" /> : <Upload size={20} className="text-gray-400" />}
              <div className="min-w-0">
                <div className="text-sm font-medium">{title}</div>
                <div className="text-xs text-gray-500">{hint} · 기간이 겹쳐도 중복 저장되지 않아요</div>
              </div>
              <input type="file" accept={accept} className="hidden" disabled={!!uploading}
                onChange={(e) => { upload(kind, e.target.files?.[0]); e.target.value = '' }} />
            </label>
          ))}
          <p className="text-xs text-gray-500 sm:col-span-2">
            급여는 <Link href="/payroll" className="underline">급여 관리</Link>에서 세무사 대장을 붙여넣어 확정하면 정산에 들어갑니다.
          </p>
        </CardContent>
      </Card>

      {/* 2. 점검 */}
      {checks && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">2. {month}월 마감 점검</CardTitle></CardHeader>
          <CardContent>
            <CheckRow ok={checks.bankRows > 0 && checks.monthComplete}>
              통장 {checks.bankRows}건{checks.lastBankDate ? ` · 마지막 거래 ${checks.lastBankDate}` : ''}
              {checks.bankRows > 0 && !checks.monthComplete && <span className="text-amber-600"> — 월말({end})까지의 내역이 아직 없어요</span>}
            </CheckRow>
            <CheckRow ok={checks.balanceBreaks === 0}>
              잔액 연속성 {checks.balanceBreaks === 0 ? '이상 없음' : `${checks.balanceBreaks}곳 끊김 — 빠진 거래가 있을 수 있어요`}
              {r && <span className="text-gray-500"> · 월초 {formatKRW(r.cash_opening)} → 월말 {formatKRW(r.cash_closing)}</span>}
            </CheckRow>
            <CheckRow ok={checks.cardRows > 0}>
              카드 승인 {checks.cardRows}건{checks.lastCardDate ? ` · 마지막 승인 ${checks.lastCardDate}` : ' — 카드 승인내역을 올려 주세요'}
            </CheckRow>
            <CheckRow ok={checks.unclassified === 0}>미분류 거래 {checks.unclassified}건</CheckRow>
            <CheckRow ok={checks.unmatchedRevenue.length === 0}>
              결제 내역과 연결 안 된 매출 입금 {checks.unmatchedRevenue.length}건
              {checks.unmatchedRevenue.length > 0 && <span className="text-gray-500"> — 아래 표에서 결제를 연결하거나 매출이 아니면 분류를 바꿔 주세요</span>}
            </CheckRow>
            <CheckRow ok={checks.payroll.total > 0 && checks.payroll.draft === 0}>
              급여 대장 {checks.payroll.total === 0 ? '없음' : `${checks.payroll.confirmed}/${checks.payroll.total}명 확정`}
              {checks.payroll.draft > 0 && <> — <Link href="/payroll" className="underline">급여 관리</Link>에서 세무사 대장으로 확정해 주세요</>}
            </CheckRow>
            {checks.employerInsuranceEstimated && (
              <CheckRow ok={false}>4대보험 회사부담을 통장 납부액(연금·건강 50%, 고용 56%, 산재 100%)으로 추정했어요. 급여 화면에 입력하면 그 값을 씁니다.</CheckRow>
            )}
          </CardContent>
        </Card>
      )}

      {/* 3. 거래 분류 */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base">3. 거래 분류</CardTitle>
            <div className="flex items-center gap-2 text-xs">
              {(['review', 'all', 'non_pl'] as const).map((f) => (
                <button key={f} onClick={() => setFilter(f)}
                  className={`px-2 py-1 rounded border ${filter === f ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-200 text-gray-600'}`}>
                  {f === 'review' ? '확인 필요' : f === 'all' ? `전체 ${txs.length}` : '손익 외'}
                </button>
              ))}
              <label className="flex items-center gap-1 ml-2 text-gray-600">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                같은 거래처는 앞으로도
              </label>
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {shown.length === 0 ? (
            <p className="text-sm text-gray-400 py-4">{txs.length === 0 ? '이 달 통장 내역이 없습니다.' : '확인할 거래가 없습니다.'}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500 border-b">
                <tr>
                  <th className="text-left py-1.5 pr-2">날짜</th>
                  <th className="text-left pr-2">거래처</th>
                  <th className="text-left pr-2">메모</th>
                  <th className="text-right pr-2">입금</th>
                  <th className="text-right pr-2">출금</th>
                  <th className="text-left pr-2">분류</th>
                  <th className="text-left">처리</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => {
                  const def = categoryOf(t.category)
                  const side = t.deposit > 0 ? 'in' : 'out'
                  return (
                    <tr key={t.id} className={`border-b last:border-0 ${t.cancelled ? 'opacity-40' : ''}`}>
                      <td className="py-1.5 pr-2 whitespace-nowrap text-gray-500">{t.tx_date.slice(5)}</td>
                      <td className="pr-2 max-w-40 truncate" title={t.counterparty}>{t.counterparty}</td>
                      <td className="pr-2 max-w-40 truncate text-gray-500" title={t.memo}>{t.memo}</td>
                      <td className="pr-2 text-right tabular-nums text-blue-700">{t.deposit ? t.deposit.toLocaleString() : ''}</td>
                      <td className="pr-2 text-right tabular-nums">{t.withdrawal ? t.withdrawal.toLocaleString() : ''}</td>
                      <td className="pr-2">
                        {t.cancelled ? <span className="text-xs text-gray-400">취소 거래</span> : (
                          <div className="flex items-center gap-1">
                            <span className={`text-[10px] px-1 rounded ${CLS_COLOR[def.cls]}`}>{CLS_LABEL[def.cls]}</span>
                            <select className="text-xs border rounded px-1 py-0.5 bg-white" value={t.category}
                              onChange={(e) => reclassify(t, e.target.value as CategoryKey)}>
                              {(Object.entries(CATEGORIES) as [CategoryKey, (typeof CATEGORIES)[CategoryKey]][])
                                .filter(([k, c]) => c.side === 'both' || c.side === side || k === t.category)
                                .map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}
                            </select>
                          </div>
                        )}
                      </td>
                      <td className="text-xs whitespace-nowrap">
                        {t.payment_id ? <span className="text-green-700">연결됨</span>
                          : unmatchedIds.has(t.id) ? (
                            <Button size="sm" variant="outline" className="h-6 text-xs px-2" onClick={() => openLink(t)}>결제 연결</Button>
                          ) : !t.cancelled && needsExpenseCheck(t) ? (
                            <Button size="sm" variant="outline" className="h-6 text-xs px-2" onClick={() => reclassify(t, 'other_expense')}>확인</Button>
                          ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* 결제 연결 */}
      <Dialog open={!!linkTx} onOpenChange={(open) => { if (!open) setLinkTx(null) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>결제 연결</DialogTitle></DialogHeader>
          {linkTx && (
            <div className="space-y-3">
              <p className="text-sm text-gray-600">
                {linkTx.tx_date} · {linkTx.counterparty} · <strong>{formatKRW(linkTx.deposit - linkTx.withdrawal)}</strong>
              </p>
              <Input placeholder="거래처·프로젝트 이름으로 찾기" value={linkQuery} onChange={(e) => setLinkQuery(e.target.value)} />
              {candidates === null ? (
                <p className="text-sm text-gray-400 py-3">결제 내역을 찾는 중이에요...</p>
              ) : candidates.length === 0 ? (
                <p className="text-sm text-gray-500 py-3">앞뒤 {SEARCH_DAYS}일 안에 맞는 결제가 없어요.{linkQuery ? '' : ' 카드 입금처럼 이름이 다르면 거래처 이름으로 찾아보세요.'}</p>
              ) : (
                <div className="max-h-72 overflow-y-auto divide-y border rounded-lg">
                  {candidates.map(({ payment: p, exact, feeDeducted }) => {
                    const deposit = linkTx.deposit - linkTx.withdrawal
                    const remainder = p.amount - pendingConfirmAmount(linkTx, p)
                    return (
                    <button key={p.id} disabled={linking} onClick={() => linkPayment(linkTx, p)}
                      className="w-full text-left p-2.5 hover:bg-gray-50 disabled:opacity-50">
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="truncate">{p.client_name_raw ?? p.project_name ?? '이름 없음'}</span>
                        <span className={`tabular-nums shrink-0 ${exact ? 'font-semibold' : 'text-amber-600'}`}>{formatKRW(p.amount)}</span>
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {[p.payment_date, p.project_name,
                          exact ? '금액 일치' : feeDeducted ? `카드 수수료 차이 ${formatKRW(p.amount - deposit)}` : '금액 다름',
                          p.status === 'confirmed' ? null : remainder > 0 ? `부분 입금 확정, 잔여 ${formatKRW(remainder)}` : '수금 예정 → 입금 확정',
                          linkedIds.has(p.id) ? '다른 입금과 이미 연결됨' : null].filter(Boolean).join(' · ')}
                      </div>
                    </button>
                    )
                  })}
                </div>
              )}
              <div className="border-t pt-3 flex items-center justify-between gap-3">
                <p className="text-xs text-gray-500">
                  {candidates?.some((c) => c.exact || c.feeDeducted) ? '이 입금으로 보이는 결제가 있어요. 새로 등록하면 중복될 수 있습니다.' : '위에 없을 때만 새로 등록하세요.'}
                </p>
                <Button size="sm" variant="outline" className="shrink-0" disabled={linking || candidates === null}
                  onClick={() => registerPayment(linkTx)}>새 결제로 등록</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 카드 */}
      {cards.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">카드 승인 {cards.length}건</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {r && (
              <p className="text-sm text-gray-600">
                국내 {formatKRW(r.breakdown.card.krw)} + 해외 ${r.breakdown.card.foreign.toLocaleString()} × {r.card_fx_rate.toLocaleString()}원 = {formatKRW(r.breakdown.card.krw + r.breakdown.card.foreignKrw)}
                {r.breakdown.card.excluded !== 0 && <span className="text-gray-400"> · 제외 {formatKRW(r.breakdown.card.excluded)}</span>}
              </p>
            )}
            <details>
              <summary className="text-xs text-gray-500 cursor-pointer">승인 내역 보기 · 법인 비용이 아닌 건은 제외 표시</summary>
              <div className="max-h-80 overflow-y-auto mt-2">
                <table className="w-full text-xs">
                  <tbody>
                    {cards.map((c) => (
                      <tr key={c.id} className={`border-b last:border-0 ${c.excluded ? 'opacity-40 line-through' : ''}`}>
                        <td className="py-1 pr-2 text-gray-500 whitespace-nowrap">{c.approved_date.slice(5)}</td>
                        <td className="pr-2 text-gray-400">{c.card_last4}{c.is_check_card ? ' 체크' : ''}</td>
                        <td className="pr-2 max-w-52 truncate">{c.merchant}</td>
                        <td className="pr-2 text-gray-400 max-w-32 truncate">{c.industry}</td>
                        <td className="pr-2 text-right tabular-nums">
                          {c.amount_krw !== null ? c.amount_krw.toLocaleString() : `$${Number(c.amount_foreign).toFixed(2)}`}
                        </td>
                        <td><button className="text-gray-400 hover:text-gray-800" onClick={() => toggleCardExcluded(c)}>{c.excluded ? '포함' : '제외'}</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </CardContent>
        </Card>
      )}

      {/* 4. 정산 */}
      {r && checks && checks.bankRows > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <CardTitle className="text-base">4. {month}월 정산 (통장 기준)</CardTitle>
              <div className="flex items-center gap-2 text-xs text-gray-600">
                해외 카드 환율
                <Input className="w-20 h-7 text-xs" value={fx} onChange={(e) => setFx(e.target.value.replace(/[^\d.]/g, ''))}
                  onBlur={() => loadPreview(fx)} />
                원/$
              </div>
            </div>
          </CardHeader>
          <CardContent className="grid lg:grid-cols-2 gap-6">
            <div>
              {lines.map((l) => (
                <div key={l.label} className={`flex justify-between py-1 text-sm ${l.strong ? 'font-semibold border-t mt-1 pt-2' : 'text-gray-700'}`}>
                  <span>{l.label}</span>
                  <span className={`tabular-nums ${l.value < 0 ? 'text-red-600' : ''}`}>{formatKRW(l.value)}</span>
                </div>
              ))}
              <div className="border-t mt-1 py-1">
                {reps.length > 0 ? reps.map((rep) => (
                  <div key={rep.id} className="flex justify-between py-1 text-sm font-bold">
                    <span>{rep.name} 정산액 ({rep.share_ratio}%)</span>
                    <span className="tabular-nums">{formatKRW(Math.floor(r.distributable_profit * rep.share_ratio / 100))}</span>
                  </div>
                )) : (
                  <div className="flex justify-between py-1 text-sm font-bold">
                    <span>대표 1인 정산액</span><span className="tabular-nums">{formatKRW(r.representative_share)}</span>
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-3">
              <div className="rounded-lg bg-gray-50 p-3 text-sm space-y-1">
                <div className="font-medium mb-1">현금</div>
                <div className="flex justify-between"><span>월초 잔액</span><span className="tabular-nums">{formatKRW(r.cash_opening)}</span></div>
                <div className="flex justify-between"><span>+ 입금</span><span className="tabular-nums">{formatKRW(r.cash_in)}</span></div>
                <div className="flex justify-between"><span>− 출금</span><span className="tabular-nums">{formatKRW(-r.cash_out)}</span></div>
                <div className="flex justify-between font-semibold border-t pt-1"><span>월말 잔액</span><span className="tabular-nums">{formatKRW(r.cash_closing)}</span></div>
              </div>
              <div className="text-sm">
                <div className="font-medium mb-1">비용에서 뺀 현금 이동</div>
                {nonPl.length === 0 ? <p className="text-xs text-gray-400">없음</p> : nonPl.map(([k, v]) => (
                  <div key={k} className="flex justify-between text-gray-700 py-0.5">
                    <span>{categoryOf(k).label} <span className="text-xs text-gray-400">{v.count}건</span></span>
                    <span className="tabular-nums">{v.in ? `+${v.in.toLocaleString()} ` : ''}{v.out ? `−${v.out.toLocaleString()}` : ''}</span>
                  </div>
                ))}
                <p className="text-xs text-gray-400 mt-1">급여·원천세·4대보험 이체는 급여 대장으로, 카드대금은 카드 승인내역으로 이미 비용에 들어가 있어 중복으로 빼지 않습니다.</p>
              </div>
            </div>
            {saved && Number(saved.distributable_profit) !== r.distributable_profit && (
              <div className="lg:col-span-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                저장 뒤에 내용이 바뀌었습니다. 위 금액이 최신이고, 대시보드에는 저장된 분배 가능 이익 {formatKRW(Number(saved.distributable_profit))}이 보입니다. 저장하면 같아집니다.
              </div>
            )}
            <div className="lg:col-span-2 flex items-center justify-between border-t pt-3">
              <span className="text-xs text-gray-500">
                {saved ? `저장됨 · ${saved.basis === 'bank' ? '통장 기준' : '수기 지출 기준'} · ${new Date(saved.calculated_at).toLocaleString('ko-KR')}` : '아직 저장 전'}
              </span>
              <Button onClick={save} disabled={saving}>{saving ? '저장 중...' : `${month}월 정산 저장`}</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
