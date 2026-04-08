'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { toast } from 'sonner'
import { formatKRW } from '@/lib/calculations/settlement'
import { RefreshCw, Trash2, AlertTriangle } from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { MonthlySettlement } from '@/types/database'

interface Row { label: string; value: number; indent?: boolean; highlight?: boolean; type?: 'deduct' | 'result' }

export default function MonthlyReportPage() {
  const supabase = createClient()
  const now = new Date()
  const [year, setYear]   = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [settlement, setSettlement] = useState<MonthlySettlement | null>(null)
  const [calculating, setCalculating] = useState(false)
  const [resetting, setResetting]     = useState(false)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [noItemsProjects, setNoItemsProjects] = useState<string[]>([])

  async function load() {
    const { data } = await supabase
      .from('monthly_settlements').select('*')
      .eq('year', year).eq('month', month).single()
    setSettlement(data)
  }

  async function loadWarnings() {
    const start = `${year}-${String(month).padStart(2, '0')}-01`
    const lastDay = new Date(year, month, 0).getDate()
    const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

    // 해당 월 입금 완료된 결제의 프로젝트 목록
    const { data: payments } = await supabase
      .from('payments')
      .select('project_id, projects(name)')
      .gte('payment_date', start)
      .lte('payment_date', end)
      .eq('matched', true)
      .not('memo', 'ilike', '%⚠ 잔금 처리 요망%')
      .not('memo', 'ilike', '%🔴 미입금%')

    const projectMap: Record<string, string> = {}
    for (const p of payments ?? []) {
      if (!p.project_id) continue
      const proj = p.projects as unknown as { name: string } | null
      projectMap[p.project_id] = proj?.name ?? p.project_id
    }
    const projectIds = Object.keys(projectMap)
    if (projectIds.length === 0) { setNoItemsProjects([]); return }

    // 구성 상품이 있는 프로젝트 확인
    const { data: items } = await supabase
      .from('project_items')
      .select('project_id')
      .in('project_id', projectIds)

    const hasItems = new Set((items ?? []).map((i) => i.project_id))
    const missing = projectIds.filter((id) => !hasItems.has(id)).map((id) => projectMap[id])
    setNoItemsProjects(missing)
  }

  useEffect(() => { load(); loadWarnings() }, [year, month])

  async function handleCalculate() {
    setCalculating(true)
    const res = await fetch('/api/calculate-settlement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year, month }),
    })
    const json = await res.json()
    if (!res.ok) { toast.error(json.error ?? '계산 실패'); setCalculating(false); return }
    toast.success('정산이 계산되었습니다.')
    setCalculating(false)
    load()
  }

  async function handleReset() {
    setResetting(true)
    const res = await fetch('/api/calculate-settlement', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year, month }),
    })
    const json = await res.json()
    if (!res.ok) { toast.error(json.error ?? '초기화 실패'); setResetting(false); return }
    toast.success('정산이 초기화되었습니다.')
    setResetting(false)
    setSettlement(null)
  }

  const rows: Row[] = settlement ? [
    { label: '총 매출 (VAT 포함)',          value: settlement.total_revenue },
    { label: '공급가액 (÷1.1)',              value: settlement.supply_value, indent: true },
    { label: '- 인센티브',                  value: -settlement.total_incentive, indent: true, type: 'deduct' },
    { label: '- 상품 실행비',               value: -settlement.total_product_cost, indent: true, type: 'deduct' },
    { label: '매출총이익',                  value: settlement.gross_profit, highlight: true, type: 'result' },
    { label: '- 고정비',                   value: -settlement.total_fixed_cost, indent: true, type: 'deduct' },
    { label: '- 변동비',                   value: -settlement.total_variable_cost, indent: true, type: 'deduct' },
    { label: '- 특수비용',                 value: -settlement.total_special_cost, indent: true, type: 'deduct' },
    { label: '- 직원 급여',                value: -settlement.total_payroll, indent: true, type: 'deduct' },
    { label: '영업이익',                   value: settlement.operating_profit, highlight: true, type: 'result' },
    { label: '- 법인세 적립 (10%)',         value: -settlement.corporate_tax_reserve, indent: true, type: 'deduct' },
    { label: '- 유보금 적립 (8%)',          value: -settlement.retained_earnings, indent: true, type: 'deduct' },
    { label: '분배 가능 이익',             value: settlement.distributable_profit, highlight: true, type: 'result' },
    { label: '대표자 1인당 정산액 (50%)',   value: settlement.representative_share, highlight: true },
  ] : []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">월별 정산 리포트</h1>
        <div className="flex items-center gap-2">
          <select className="border rounded-md px-3 py-2 text-sm" value={year}
            onChange={(e) => setYear(Number(e.target.value))}>
            {[2023, 2024, 2025, 2026].map((y) => <option key={y} value={y}>{y}년</option>)}
          </select>
          <select className="border rounded-md px-3 py-2 text-sm" value={month}
            onChange={(e) => setMonth(Number(e.target.value))}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m}월</option>)}
          </select>

          {settlement && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setResetConfirmOpen(true)}
              disabled={resetting}
              className="text-red-500 border-red-200 hover:bg-red-50"
            >
              <Trash2 size={14} className="mr-1" />
              {resetting ? '초기화 중...' : '정산 초기화'}
            </Button>
          )}

          <Button onClick={handleCalculate} disabled={calculating}>
            <RefreshCw size={14} className={`mr-1 ${calculating ? 'animate-spin' : ''}`} />
            {calculating ? '계산 중...' : settlement ? '재계산' : '정산 계산'}
          </Button>
        </div>
      </div>

      {/* 구성 상품 미입력 경고 */}
      {noItemsProjects.length > 0 && (
        <div className="flex items-start gap-2 bg-orange-50 border border-orange-200 rounded-md px-3 py-2.5">
          <AlertTriangle size={15} className="text-orange-500 mt-0.5 shrink-0" />
          <div className="text-xs text-orange-700 space-y-0.5">
            <p className="font-semibold">구성 상품 미입력 프로젝트가 있습니다 — 상품 실행비가 ₩0으로 계산됩니다.</p>
            <p>
              {noItemsProjects.map((name, i) => (
                <span key={i} className="inline-block bg-orange-100 text-orange-800 rounded px-1.5 py-0.5 mr-1 mb-0.5">{name}</span>
              ))}
            </p>
            <p className="text-orange-500">프로젝트 메뉴에서 구성 상품을 입력한 후 정산을 재계산해 주세요.</p>
          </div>
        </div>
      )}

      {/* 인센티브 안내 */}
      <div className="text-xs text-gray-400 bg-gray-50 border rounded-md px-3 py-2">
        인센티브는 <strong>결제 내역의 담당자(F열)</strong>와 직원명이 일치하는 계약건의 공급가액에만 적용됩니다.
        담당자가 없거나 직원 목록에 없는 건은 대표자 계약으로 처리됩니다.
      </div>

      {!settlement ? (
        <Card>
          <CardContent className="py-12 text-center text-gray-400">
            {year}년 {month}월 정산 데이터가 없습니다. "정산 계산" 버튼을 눌러주세요.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="text-xs text-gray-400">
            계산 시각: {new Date(settlement.calculated_at).toLocaleString('ko-KR')}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Card className="border-blue-200 bg-blue-50">
              <CardHeader className="pb-1">
                <CardTitle className="text-sm text-blue-700">대표자 1인당 정산액</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold text-blue-900">{formatKRW(settlement.representative_share)}</div>
              </CardContent>
            </Card>
            <Card className={settlement.operating_profit >= 0 ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}>
              <CardHeader className="pb-1">
                <CardTitle className="text-sm text-gray-600">영업이익</CardTitle>
              </CardHeader>
              <CardContent>
                <div className={`text-3xl font-bold ${settlement.operating_profit >= 0 ? 'text-green-900' : 'text-red-900'}`}>
                  {formatKRW(settlement.operating_profit)}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle>정산 상세</CardTitle></CardHeader>
            <CardContent>
              <div className="space-y-1">
                {rows.map((row, i) => (
                  <div
                    key={i}
                    className={`flex justify-between items-center py-2 ${
                      row.highlight ? 'border-t border-b font-bold bg-gray-50 px-2 rounded' : 'text-sm'
                    } ${row.indent ? 'pl-4 text-gray-500' : ''}`}
                  >
                    <span>{row.label}</span>
                    <span className={
                      row.value < 0 ? 'text-red-500' :
                      row.highlight ? 'text-blue-700' : 'text-gray-800'
                    }>
                      {row.value < 0 ? `- ${formatKRW(Math.abs(row.value))}` : formatKRW(row.value)}
                    </span>
                  </div>
                ))}
              </div>

              {settlement.total_incentive > 0 && (
                <div className="mt-4 pt-3 border-t text-xs text-gray-400">
                  * 인센티브 {formatKRW(settlement.total_incentive)} = 직원 담당 계약건의 공급가액 × 인센티브 요율 합산
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <AlertDialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>정산 초기화</AlertDialogTitle>
            <AlertDialogDescription>
              {year}년 {month}월 정산 데이터를 초기화하시겠습니까?<br />
              정산 결과만 삭제되며 결제·지출 데이터는 유지됩니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => { setResetConfirmOpen(false); handleReset() }}
            >
              초기화
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
