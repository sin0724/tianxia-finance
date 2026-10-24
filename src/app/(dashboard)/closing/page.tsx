'use client'

/**
 * 월 마감 — 통장·카드 내역을 올리면 분류·결제 매칭·정산까지 이어진다.
 *
 *   1. 통장 거래내역 CSV / 카드 승인내역 XLS 업로드 (겹쳐 올려도 중복 저장 안 됨)
 *   2. 점검: 월말까지 들어왔는지, 잔액 연속, 미분류, 결제와 연결 안 된 매출 입금, 급여 확정 여부
 *   3. 거래 분류 확인·수정 — "앞으로도 이렇게"를 고르면 다음 업로드부터 자동 적용
 *   4. 정산 미리보기 → 저장 (월별 정산 리포트·대시보드에 반영)
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/toast'
import { formatKRW } from '@/lib/calculations/settlement'
import { MonthNavigator } from '@/components/shared/month-navigator'
import { useMonth } from '@/components/shared/month-context'
import { CATEGORIES, categoryOf, type CategoryKey } from '@/lib/ledger/categories'
import type { SettleResult } from '@/lib/ledger/settle'
import type { ClosingChecks } from '@/lib/ledger/server'
import type { BankTransaction, CardTransaction } from '@/types/database'
import { AlertTriangle, CheckCircle2, RefreshCw, Upload } from 'lucide-react'

type Filter = 'review' | 'all' | 'non_pl'

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
  const [saved, setSaved] = useState<{ basis: string; calculated_at: string } | null>(null)
  const [fx, setFx] = useState('')
  const [filter, setFilter] = useState<Filter>('review')
  const [uploading, setUploading] = useState<'bank' | 'card' | null>(null)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [remember, setRemember] = useState(true)

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
    const [{ data: bank }, { data: card }, { data: st }] = await Promise.all([
      supabase.from('bank_transactions').select('*').gte('tx_date', start).lte('tx_date', end).order('seq'),
      supabase.from('card_transactions').select('*').gte('approved_date', start).lte('approved_date', end).order('approved_at'),
      supabase.from('monthly_settlements').select('basis, calculated_at').eq('year', year).eq('month', month).maybeSingle(),
    ])
    setTxs(bank ?? [])
    setCards(card ?? [])
    setSaved(st ?? null)
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
      // 같은 거래처의 자동 분류 거래(이 달)도 함께 바꾼다 — 손으로 고친 건은 그대로 둔다
      await supabase.from('bank_transactions').update({ category, classified_by: 'user_rule' })
        .eq('counterparty', tx.counterparty).eq('classified_by', 'rule')
        .gte('tx_date', start).lte('tx_date', end)
        .gt(direction === 'in' ? 'deposit' : 'withdrawal', 0)
    }
    await load()
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

  const unmatchedIds = useMemo(() => new Set((checks?.unmatchedRevenue ?? []).map((r) => r.id)), [checks])
  const shown = txs.filter((t) => {
    const cls = categoryOf(t.category).cls
    if (filter === 'all') return true
    if (filter === 'non_pl') return cls === 'non_pl'
    return !t.cancelled && (cls === 'unclassified' || unmatchedIds.has(t.id) || t.category === 'other_expense')
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
            ['bank', '통장 거래내역', '하나은행 거래내역 CSV', '.csv'],
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
              {checks.unmatchedRevenue.length > 0 && <span className="text-gray-500"> — 아래 표에서 결제 등록하거나 매출이 아니면 분류를 바꿔 주세요</span>}
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
                  <th className="text-left">결제</th>
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
                            <Button size="sm" variant="outline" className="h-6 text-xs px-2" onClick={() => registerPayment(t)}>결제 등록</Button>
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
              <div className="flex justify-between py-2 text-sm font-bold border-t mt-1">
                <span>대표 1인 정산액</span><span className="tabular-nums">{formatKRW(r.representative_share)}</span>
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
