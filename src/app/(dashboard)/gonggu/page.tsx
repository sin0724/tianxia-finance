'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { toast } from 'sonner'
import { Plus, Pencil, Trash2, Link2, Link2Off, RefreshCw } from 'lucide-react'
import { formatKRW } from '@/lib/calculations/settlement'
import type { GongguSale } from '@/types/database'

type GongguCampaign = {
  id: string
  client_name: string
  campaign_name: string
  start_date: string | null
  end_date: string | null
}

const emptyForm = {
  campaign_id: '' as string,
  campaign_name: '',
  client_name: '',
  gross_sales: '',
  margin: '',
  memo: '',
}

export default function GongguPage() {
  const supabase = createClient()
  const now = new Date()
  const [year, setYear]   = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)

  const [items, setItems] = useState<GongguSale[]>([])
  const [cumGross, setCumGross]   = useState(0)
  const [cumMargin, setCumMargin] = useState(0)

  const [campaigns, setCampaigns] = useState<GongguCampaign[]>([])
  const [campaignsError, setCampaignsError] = useState<string | null>(null)

  // 추가/수정 다이얼로그
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editId, setEditId]         = useState<string | null>(null)
  const [mode, setMode]             = useState<'linked' | 'manual'>('linked')
  const [form, setForm]             = useState(emptyForm)
  const [saving, setSaving]         = useState(false)

  async function load() {
    const { data } = await supabase
      .from('gonggu_sales')
      .select('*')
      .eq('year', year)
      .eq('month', month)
      .order('created_at')
    setItems(data ?? [])

    const { data: all } = await supabase
      .from('gonggu_sales')
      .select('gross_sales, margin')
    setCumGross((all ?? []).reduce((s, r) => s + r.gross_sales, 0))
    setCumMargin((all ?? []).reduce((s, r) => s + r.margin, 0))
  }

  async function loadCampaigns() {
    try {
      const res = await fetch('/api/gonggu/campaigns')
      const json = await res.json()
      if (!res.ok) { setCampaignsError(json.error ?? '캠페인 목록 조회 실패'); return }
      setCampaigns(json.campaigns ?? [])
      setCampaignsError(null)
    } catch {
      setCampaignsError('캠페인 목록 조회 실패')
    }
  }

  useEffect(() => { load() }, [year, month])
  useEffect(() => { loadCampaigns() }, [])

  function openAdd() {
    setEditId(null)
    setMode(campaignsError ? 'manual' : 'linked')
    setForm(emptyForm)
    setDialogOpen(true)
  }

  function openEdit(item: GongguSale) {
    setEditId(item.id)
    setMode(item.campaign_id ? 'linked' : 'manual')
    setForm({
      campaign_id: item.campaign_id ?? '',
      campaign_name: item.campaign_name,
      client_name: item.client_name ?? '',
      gross_sales: item.gross_sales > 0 ? String(item.gross_sales) : '',
      margin: item.margin > 0 ? String(item.margin) : '',
      memo: item.memo ?? '',
    })
    setDialogOpen(true)
  }

  async function syncToAdmin(campaignId: string) {
    try {
      const res = await fetch('/api/gonggu/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId, year, month }),
      })
      if (!res.ok) {
        const json = await res.json()
        toast.warning(`관리 시스템 동기화 실패: ${json.error ?? '알 수 없는 오류'}`)
        return false
      }
      return true
    } catch {
      toast.warning('관리 시스템 동기화 실패')
      return false
    }
  }

  async function handleSave() {
    const grossSales = parseFloat(form.gross_sales) || 0
    const margin = parseFloat(form.margin) || 0

    let campaignId: string | null = null
    let campaignName = form.campaign_name.trim()
    let clientName = form.client_name.trim() || null

    if (mode === 'linked') {
      if (!form.campaign_id) { toast.error('캠페인을 선택해주세요.'); return }
      const c = campaigns.find((c) => c.id === form.campaign_id)
      if (!c) { toast.error('캠페인을 찾을 수 없습니다.'); return }
      campaignId = c.id
      campaignName = c.campaign_name
      clientName = c.client_name
    } else if (!campaignName) {
      toast.error('캠페인명을 입력해주세요.')
      return
    }

    setSaving(true)
    const row = {
      campaign_id: campaignId,
      campaign_name: campaignName,
      client_name: clientName,
      year, month,
      gross_sales: grossSales,
      margin,
      memo: form.memo.trim() || null,
    }

    // 수정 시 연동 캠페인이 바뀌면 이전 캠페인 동기화 데이터도 갱신 필요
    const prev = editId ? items.find((i) => i.id === editId) : null

    const { error } = editId
      ? await supabase.from('gonggu_sales').update(row).eq('id', editId)
      : await supabase.from('gonggu_sales').insert(row)

    if (error) {
      setSaving(false)
      toast.error(error.code === '23505'
        ? '이 캠페인은 해당 월에 이미 등록되어 있습니다.'
        : `저장 실패: ${error.message}`)
      return
    }

    let synced = true
    if (prev?.campaign_id && prev.campaign_id !== campaignId) synced = await syncToAdmin(prev.campaign_id) && synced
    if (campaignId) synced = await syncToAdmin(campaignId) && synced

    setSaving(false)
    setDialogOpen(false)
    toast.success(campaignId && synced
      ? '저장 후 관리 시스템에 취급액이 반영되었습니다.'
      : '저장되었습니다.')
    load()
  }

  async function handleDelete(item: GongguSale) {
    const { error } = await supabase.from('gonggu_sales').delete().eq('id', item.id)
    if (error) { toast.error(`삭제 실패: ${error.message}`); return }
    if (item.campaign_id) await syncToAdmin(item.campaign_id)
    toast.success('삭제되었습니다.')
    load()
  }

  const monthGross  = items.reduce((s, r) => s + r.gross_sales, 0)
  const monthMargin = items.reduce((s, r) => s + r.margin, 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">공구 사업부</h1>
          <p className="text-xs text-gray-400 mt-0.5">
            캠페인별 취급액·마진 관리 — 저장 시 취급액만 공구 캠페인 관리 시스템에 표시됩니다 (마진 비공개)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select className="border rounded-md px-3 py-2 text-sm" value={year}
            onChange={(e) => setYear(Number(e.target.value))}>
            {[2025, 2026, 2027].map((y) => <option key={y} value={y}>{y}년</option>)}
          </select>
          <select className="border rounded-md px-3 py-2 text-sm" value={month}
            onChange={(e) => setMonth(Number(e.target.value))}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m}월</option>)}
          </select>
          <Button onClick={openAdd}>
            <Plus size={14} className="mr-1" />
            실적 추가
          </Button>
        </div>
      </div>

      {campaignsError && (
        <div className="flex items-center justify-between gap-2 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-xs text-amber-800">
          <span>공구 캠페인 관리 시스템 연동 불가 — {campaignsError} 수기 입력은 가능하지만 관리 시스템에 반영되지 않습니다.</span>
          <button onClick={loadCampaigns} className="text-amber-600 hover:text-amber-800 shrink-0">
            <RefreshCw size={13} />
          </button>
        </div>
      )}

      {/* 요약 카드 */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="border-purple-200">
          <CardHeader className="pb-1"><CardTitle className="text-sm text-gray-500">{month}월 취급액</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-purple-700">{formatKRW(monthGross)}</div>
            <p className="text-xs text-gray-400 mt-1">캠페인 {items.length}건</p>
          </CardContent>
        </Card>
        <Card className="border-purple-200 bg-purple-50">
          <CardHeader className="pb-1"><CardTitle className="text-sm text-purple-700">{month}월 우리 마진</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-purple-900">{formatKRW(monthMargin)}</div>
            <p className="text-xs text-purple-500 mt-1">
              취급액 대비 {monthGross > 0 ? ((monthMargin / monthGross) * 100).toFixed(1) : '0'}% · 정산 시 영업이익에 합산
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm text-gray-500">누적 실적 (전체 기간)</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatKRW(cumGross)}</div>
            <p className="text-xs text-gray-400 mt-1">누적 마진 {formatKRW(cumMargin)}</p>
          </CardContent>
        </Card>
      </div>

      {/* 실적 목록 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{year}년 {month}월 캠페인 실적</CardTitle>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <div className="py-10 text-center text-gray-400 text-sm">
              등록된 실적이 없습니다. &ldquo;실적 추가&rdquo;로 캠페인 취급액과 마진을 입력해주세요.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>캠페인</TableHead>
                  <TableHead>클라이언트</TableHead>
                  <TableHead className="text-right">취급액</TableHead>
                  <TableHead className="text-right">우리 마진</TableHead>
                  <TableHead className="text-right">마진율</TableHead>
                  <TableHead>연동</TableHead>
                  <TableHead>메모</TableHead>
                  <TableHead className="w-20"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">{item.campaign_name}</TableCell>
                    <TableCell className="text-gray-500">{item.client_name ?? '-'}</TableCell>
                    <TableCell className="text-right">{formatKRW(item.gross_sales)}</TableCell>
                    <TableCell className="text-right font-medium text-purple-700">{formatKRW(item.margin)}</TableCell>
                    <TableCell className="text-right text-gray-500">
                      {item.gross_sales > 0 ? `${((item.margin / item.gross_sales) * 100).toFixed(1)}%` : '-'}
                    </TableCell>
                    <TableCell>
                      {item.campaign_id ? (
                        <Badge variant="secondary" className="text-xs gap-1 text-green-700 bg-green-50">
                          <Link2 size={11} /> 연동
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs gap-1 text-gray-500">
                          <Link2Off size={11} /> 수기
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-gray-400 text-xs max-w-[160px] truncate">{item.memo ?? ''}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 justify-end">
                        <button onClick={() => openEdit(item)} className="p-1.5 text-gray-400 hover:text-blue-600 rounded" title="수정">
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => handleDelete(item)} className="p-1.5 text-gray-400 hover:text-red-600 rounded" title="삭제">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-gray-50 font-bold">
                  <TableCell colSpan={2}>합계</TableCell>
                  <TableCell className="text-right">{formatKRW(monthGross)}</TableCell>
                  <TableCell className="text-right text-purple-700">{formatKRW(monthMargin)}</TableCell>
                  <TableCell className="text-right text-gray-500">
                    {monthGross > 0 ? `${((monthMargin / monthGross) * 100).toFixed(1)}%` : '-'}
                  </TableCell>
                  <TableCell colSpan={3}></TableCell>
                </TableRow>
              </TableBody>
            </Table>
          )}
          <p className="mt-3 pt-3 border-t text-xs text-gray-400">
            공구는 실행비 없이 RS수수료·공급가 마진이 곧 수익입니다. 마진은 VAT를 제외한 실수익 기준으로 입력해주세요.
            월별 정산 계산 시 이 달의 마진 합계가 영업이익에 자동 합산됩니다.
          </p>
        </CardContent>
      </Card>

      {/* 추가/수정 다이얼로그 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editId ? '실적 수정' : `${year}년 ${month}월 실적 추가`}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* 연동/수기 전환 */}
            <div className="flex gap-1 p-1 bg-gray-100 rounded-lg w-fit">
              <button
                onClick={() => setMode('linked')}
                disabled={!!campaignsError}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                  mode === 'linked' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'
                } ${campaignsError ? 'opacity-50' : ''}`}
              >
                캠페인 연동
              </button>
              <button
                onClick={() => setMode('manual')}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                  mode === 'manual' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'
                }`}
              >
                직접 입력
              </button>
            </div>

            {mode === 'linked' ? (
              <div className="space-y-1.5">
                <Label>공구 캠페인</Label>
                <select
                  className="w-full border rounded-md px-3 py-2 text-sm"
                  value={form.campaign_id}
                  onChange={(e) => setForm({ ...form, campaign_id: e.target.value })}
                >
                  <option value="">캠페인 선택</option>
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      [{c.client_name}] {c.campaign_name}
                      {c.start_date ? ` (${c.start_date.slice(0, 10)}~)` : ''}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-400">저장 시 취급액이 관리 시스템 캠페인에 표시됩니다. 마진은 전송되지 않습니다.</p>
              </div>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label>캠페인명</Label>
                  <Input
                    value={form.campaign_name}
                    onChange={(e) => setForm({ ...form, campaign_name: e.target.value })}
                    placeholder="예: OO 브랜드 6월 공구"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>클라이언트 (선택)</Label>
                  <Input
                    value={form.client_name}
                    onChange={(e) => setForm({ ...form, client_name: e.target.value })}
                  />
                </div>
              </>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>취급액 (원)</Label>
                <Input
                  type="number"
                  value={form.gross_sales}
                  onChange={(e) => setForm({ ...form, gross_sales: e.target.value })}
                  placeholder="전체 판매액"
                />
              </div>
              <div className="space-y-1.5">
                <Label>우리 마진 (원)</Label>
                <Input
                  type="number"
                  value={form.margin}
                  onChange={(e) => setForm({ ...form, margin: e.target.value })}
                  placeholder="RS수수료·마진"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>메모 (선택)</Label>
              <Input
                value={form.memo}
                onChange={(e) => setForm({ ...form, memo: e.target.value })}
                placeholder="예: RS 15% 정산 완료"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>취소</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? '저장 중...' : '저장'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
