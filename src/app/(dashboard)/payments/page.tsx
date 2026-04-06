'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from 'sonner'
import { Plus, Pencil, Trash2, Link2, CheckCircle, FolderOpen } from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { formatKRW } from '@/lib/calculations/settlement'
import { findSimilar } from '@/lib/utils/levenshtein'
import type { Payment, Project, Client } from '@/types/database'

type PaymentWithRelations = Payment & {
  projects: { name: string; clients: { name: string } | null } | null
}

// 정확한 상태 태그 문자열로만 판별 (일반 메모의 ⚠/🔴 오탐 방지)
const isPendingPayment = (p: { memo: string | null }) =>
  !!(p.memo?.includes('⚠ 잔금 처리 요망') || p.memo?.includes('🔴 미입금'))

export default function PaymentsPage() {
  const supabase = createClient()
  const now = new Date()
  const [tab, setTab] = useState<'confirmed' | 'pending'>('confirmed')
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [payments, setPayments] = useState<PaymentWithRelations[]>([])
  const [allPending, setAllPending] = useState<PaymentWithRelations[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)

  // 결제 추가/수정 다이얼로그
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Payment | null>(null)
  const [form, setForm] = useState({
    project_id: '', amount: '', payment_date: '',
    payment_type: '' as Payment['payment_type'], manager: '', memo: '',
  })

  // 프로젝트 연결 다이얼로그
  const [matchOpen, setMatchOpen] = useState(false)
  const [matchTarget, setMatchTarget] = useState<PaymentWithRelations | null>(null)
  const [matchProjectId, setMatchProjectId] = useState('')

  // 삭제 확인 AlertDialog
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  // 입금 확정 다이얼로그 (수금 관리)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmTarget, setConfirmTarget] = useState<PaymentWithRelations | null>(null)
  const [confirmAmount, setConfirmAmount] = useState('')
  const [confirmProjectId, setConfirmProjectId] = useState('')

  async function load() {
    setLoading(true)
    const start = `${year}-${String(month).padStart(2, '0')}-01`
    // toISOString() 타임존 오프셋 버그 방지 — 직접 날짜 문자열 구성
    const lastDay = new Date(year, month, 0).getDate()
    const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

    const { data, error } = await supabase
      .from('payments')
      .select('*, projects(name, clients(name))')
      .gte('payment_date', start)
      .lte('payment_date', end)
      .order('payment_date', { ascending: false })

    if (error) toast.error('데이터 로드 실패: ' + error.message)
    setPayments((data as unknown as PaymentWithRelations[]) ?? [])

    // 수금 관리: 월 필터 없이 전체 미수금 항목
    const { data: pendingData } = await supabase
      .from('payments')
      .select('*, projects(name, clients(name))')
      .or('memo.ilike.*⚠ 잔금 처리 요망*,memo.ilike.*🔴 미입금*')
      .order('payment_date', { ascending: false })
    setAllPending((pendingData as unknown as PaymentWithRelations[]) ?? [])

    const { data: proj } = await supabase
      .from('projects')
      .select('*')
      .in('status', ['ongoing', 'completed'])
      .order('name')
    setProjects(proj ?? [])

    const { data: clientData } = await supabase.from('clients').select('*').order('name')
    setClients(clientData ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [year, month])

  // ─── 결제 추가/수정 ────────────────────────────────────
  function openAdd() {
    setEditing(null)
    setForm({
      project_id: '', amount: '',
      payment_date: new Date().toISOString().split('T')[0],
      payment_type: null, manager: '', memo: '',
    })
    setDialogOpen(true)
  }

  function openEdit(p: Payment) {
    setEditing(p)
    setForm({
      project_id: p.project_id ?? '',
      amount: String(p.amount),
      payment_date: p.payment_date,
      payment_type: p.payment_type,
      manager: p.manager ?? '',
      memo: p.memo ?? '',
    })
    setDialogOpen(true)
  }

  async function handleSave() {
    const amount = parseFloat(form.amount)
    if (!form.payment_date || isNaN(amount)) {
      toast.error('날짜와 금액은 필수입니다.')
      return
    }
    const payload = {
      project_id: form.project_id || null,
      amount,
      payment_date: form.payment_date,
      payment_type: form.payment_type,
      manager: form.manager || null,
      memo: form.memo || null,
      source: 'manual' as const,
      matched: !!form.project_id,
    }
    if (editing) {
      const { error } = await supabase.from('payments').update(payload).eq('id', editing.id)
      if (error) { toast.error(error.message); return }
      toast.success('수정되었습니다.')
    } else {
      const { error } = await supabase.from('payments').insert(payload)
      if (error) { toast.error(error.message); return }
      toast.success('결제가 추가되었습니다.')
    }
    setDialogOpen(false)
    load()
  }

  // ─── 삭제 ────────────────────────────────────────────
  async function handleDelete(id: string) {
    const { error } = await supabase.from('payments').delete().eq('id', id)
    if (error) { toast.error('삭제 실패'); return }
    toast.success('삭제되었습니다.')
    load()
  }

  // ─── 프로젝트 연결 (미매칭 → 연결) ────────────────────
  function openMatch(p: PaymentWithRelations) {
    setMatchTarget(p)
    setMatchProjectId(p.project_id ?? '')
    setMatchOpen(true)
  }

  async function handleMatch() {
    if (!matchTarget) return
    const { error } = await supabase
      .from('payments')
      .update({
        project_id: matchProjectId || null,
        matched: !!matchProjectId,
      })
      .eq('id', matchTarget.id)
    if (error) { toast.error('연결 실패: ' + error.message); return }
    toast.success('프로젝트가 연결되었습니다.')
    setMatchOpen(false)
    setMatchTarget(null)
    load()
  }

  // ─── 입금 확정 (수금 관리 탭) ──────────────────────────
  function openConfirm(p: PaymentWithRelations) {
    setConfirmTarget(p)
    setConfirmAmount(String(p.amount))
    setConfirmProjectId(p.project_id ?? '')
    setConfirmOpen(true)
  }

  async function handleConfirm() {
    if (!confirmTarget) return
    const amount = parseFloat(confirmAmount)
    if (isNaN(amount) || amount <= 0) { toast.error('금액을 확인해주세요.'); return }

    // 메모에서 보류 태그 제거
    const cleanMemo = (confirmTarget.memo ?? '')
      .replace('⚠ 잔금 처리 요망', '')
      .replace('🔴 미입금', '')
      .replace(/^\s*\|\s*/, '')
      .replace(/\s*\|\s*$/, '')
      .trim() || null

    // 원본 레코드를 입금 확정 처리
    const { error } = await supabase
      .from('payments')
      .update({
        amount,
        memo: cleanMemo,
        project_id: confirmProjectId || null,
        matched: !!confirmProjectId,
      })
      .eq('id', confirmTarget.id)
    if (error) { toast.error('처리 실패: ' + error.message); return }

    // 부분 입금인 경우 — 차액을 새 수금 예정 레코드로 생성
    const originalAmount = confirmTarget.amount
    const remainder = originalAmount - amount
    if (remainder > 0.01) {
      // 원본 상태 태그 유지 (잔금 → 잔금, 미입금 → 미입금)
      const remainderTag = confirmTarget.memo?.includes('⚠') ? '⚠ 잔금 처리 요망' : '🔴 미입금'
      const remainderMemo = [remainderTag, cleanMemo].filter(Boolean).join(' | ') || remainderTag

      await supabase.from('payments').insert({
        project_id: confirmProjectId || null,
        amount: remainder,
        payment_date: confirmTarget.payment_date,
        payment_type: confirmTarget.payment_type,
        manager: confirmTarget.manager,
        memo: remainderMemo,
        source: confirmTarget.source,
        client_name_raw: confirmTarget.client_name_raw,
        matched: !!confirmProjectId,
      })
      toast.success(`입금 ${formatKRW(amount)} 확정. 잔여 ${formatKRW(remainder)}은 수금 관리에 남습니다.`)
    } else {
      toast.success('입금 확정 처리되었습니다. 입금액에 반영됩니다.')
    }

    setConfirmOpen(false)
    setConfirmTarget(null)
    load()
  }

  // ─── 유사 클라이언트 제안 ────────────────────────────
  const clientCandidates = clients.map((c) => ({ id: c.id, name: c.name }))

  async function applySuggestion(payment: PaymentWithRelations, clientId: string) {
    const { data: projs } = await supabase
      .from('projects')
      .select('id')
      .eq('client_id', clientId)
      .eq('status', 'ongoing')
      .order('created_at', { ascending: false })
      .limit(1)
    setMatchTarget(payment)
    setMatchProjectId(projs?.[0]?.id ?? '')
    setMatchOpen(true)
  }

  // ─── 분류 ─────────────────────────────────────────────
  const confirmedList = payments.filter((p) => !isPendingPayment(p))
  const pendingList = allPending // 수금 관리: 월 필터 없이 전체
  const confirmedTotal = confirmedList.reduce((s, p) => s + p.amount, 0)
  const pendingTotal = pendingList.reduce((s, p) => s + p.amount, 0)

  const yearOptions = [2023, 2024, 2025, 2026]
  const monthOptions = Array.from({ length: 12 }, (_, i) => i + 1)

  const MonthSelector = () => (
    <div className="flex items-center gap-2">
      <select className="border rounded-md px-3 py-2 text-sm" value={year} onChange={(e) => setYear(Number(e.target.value))}>
        {yearOptions.map((y) => <option key={y} value={y}>{y}년</option>)}
      </select>
      <select className="border rounded-md px-3 py-2 text-sm" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
        {monthOptions.map((m) => <option key={m} value={m}>{m}월</option>)}
      </select>
    </div>
  )

  return (
    <div className="space-y-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">결제 내역</h1>
        <Button onClick={openAdd}><Plus size={16} className="mr-1" />결제 추가</Button>
      </div>

      {/* 탭 + 월 선택 */}
      <div className="flex items-center justify-between border-b">
        <div className="flex gap-1">
          <button
            onClick={() => setTab('confirmed')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'confirmed' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            입금 내역
            <span className="ml-1.5 text-xs bg-gray-100 text-gray-600 rounded-full px-1.5 py-0.5">{confirmedList.length}</span>
          </button>
          <button
            onClick={() => setTab('pending')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'pending' ? 'border-orange-500 text-orange-600' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            수금 관리
            {pendingList.length > 0 && (
              <span className="ml-1.5 text-xs bg-orange-100 text-orange-600 rounded-full px-1.5 py-0.5">{pendingList.length}</span>
            )}
          </button>
        </div>
        {tab === 'confirmed' && <MonthSelector />}
        {tab === 'pending' && (
          <span className="text-xs text-gray-400 pb-1">전체 기간 미수금 표시</span>
        )}
      </div>

      {/* ══════════ 입금 내역 탭 ══════════ */}
      {tab === 'confirmed' && (
        <>
          <div className="flex items-center justify-end">
            <div className="text-sm text-gray-600">
              총 <strong className="text-gray-900">{formatKRW(confirmedTotal)}</strong> ({confirmedList.length}건)
            </div>
          </div>

          <div className="bg-white rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>결제일</TableHead>
                  <TableHead>클라이언트</TableHead>
                  <TableHead>프로젝트</TableHead>
                  <TableHead>유형</TableHead>
                  <TableHead>담당자</TableHead>
                  <TableHead className="text-right">금액</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-8 text-gray-400">불러오는 중...</TableCell></TableRow>
                ) : confirmedList.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-8 text-gray-400">입금 내역이 없습니다.</TableCell></TableRow>
                ) : confirmedList.map((p) => (
                  <TableRow key={p.id} className={!p.matched ? 'bg-blue-50/30' : ''}>
                    <TableCell>{p.payment_date}</TableCell>
                    <TableCell>
                      {p.projects?.clients?.name ?? (
                        p.client_name_raw
                          ? <span className="text-blue-500">{p.client_name_raw}</span>
                          : <span className="text-gray-300">-</span>
                      )}
                      {p.source === 'slack' && <Badge variant="outline" className="ml-1 text-xs text-gray-400">Slack</Badge>}
                    </TableCell>
                    <TableCell>
                      {p.projects?.name ?? (
                        <button onClick={() => openMatch(p)} className="text-blue-400 hover:text-blue-600 text-xs flex items-center gap-1">
                          <Link2 size={12} />연결 필요
                        </button>
                      )}
                    </TableCell>
                    <TableCell>{p.payment_type ?? '-'}</TableCell>
                    <TableCell>{p.manager ?? '-'}</TableCell>
                    <TableCell className="text-right font-medium">{formatKRW(p.amount)}</TableCell>
                    <TableCell>
                      <div className="flex gap-1 justify-end">
                        {!p.matched && (
                          <Button size="sm" variant="ghost" className="text-blue-400" onClick={() => openMatch(p)}>
                            <Link2 size={14} />
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => openEdit(p)}><Pencil size={14} /></Button>
                        <Button size="sm" variant="ghost" className="text-red-400 hover:text-red-600"
                          onClick={() => setDeleteTarget(p.id)}>
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {/* ══════════ 수금 관리 탭 ══════════ */}
      {tab === 'pending' && (
        <>
          <div className="flex items-center justify-end">
            <div className="text-sm text-gray-600">
              수금 예정 <strong className="text-orange-600">{formatKRW(pendingTotal)}</strong> ({pendingList.length}건)
            </div>
          </div>

          {pendingList.length === 0 ? (
            <div className="bg-white rounded-lg border text-center py-12 text-gray-400 text-sm">
              {year}년 {month}월 수금 관리 항목이 없습니다.
            </div>
          ) : (
            <div className="space-y-2">
              {pendingList.map((p) => {
                const isJanggeum = p.memo?.includes('⚠')
                const isMiipgeum = p.memo?.includes('🔴')
                const suggestions = findSimilar(p.client_name_raw ?? '', clientCandidates, 3, 0.35)

                return (
                  <div key={p.id} className={`bg-white rounded-lg border p-4 space-y-3 ${isJanggeum ? 'border-l-4 border-l-yellow-400' : 'border-l-4 border-l-red-400'}`}>
                    {/* 상단: 기본 정보 */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${isJanggeum ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'}`}>
                            {isJanggeum ? '잔금 처리 요망' : '미입금'}
                          </span>
                          <span className="text-sm font-semibold text-gray-800">{p.client_name_raw ?? '(상호명 없음)'}</span>
                          <span className="text-sm text-gray-400">{p.payment_date}</span>
                          {p.payment_type && <Badge variant="outline" className="text-xs">{p.payment_type}</Badge>}
                        </div>
                        <div className="flex items-center gap-3 text-sm">
                          <span className="text-gray-500">계약금액:</span>
                          <span className="font-bold text-lg text-gray-800">{formatKRW(p.amount)}</span>
                          {p.manager && <span className="text-gray-400 text-xs">담당: {p.manager}</span>}
                        </div>
                        {p.projects?.name && (
                          <div className="text-xs text-gray-400">프로젝트: {p.projects.name}</div>
                        )}
                        {/* 메모에서 태그 제거한 내용 표시 */}
                        {(() => {
                          const cleanNote = (p.memo ?? '')
                            .replace('⚠ 잔금 처리 요망', '')
                            .replace('🔴 미입금', '')
                            .replace(/^\s*\|\s*/, '')
                            .trim()
                          return cleanNote ? <div className="text-xs text-gray-500 italic">{cleanNote}</div> : null
                        })()}
                      </div>

                      {/* 액션 버튼 */}
                      <div className="flex gap-2 flex-shrink-0">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openMatch(p)}
                          title="프로젝트 연결"
                        >
                          <FolderOpen size={13} className="mr-1" />프로젝트 연결
                        </Button>
                        <Button
                          size="sm"
                          className="bg-green-600 hover:bg-green-700 text-white"
                          onClick={() => openConfirm(p)}
                        >
                          <CheckCircle size={13} className="mr-1" />입금 확정
                        </Button>
                        <Button size="sm" variant="ghost" className="text-red-400 hover:text-red-600"
                          onClick={() => setDeleteTarget(p.id)}>
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </div>

                    {/* 유사 클라이언트 제안 */}
                    {!p.matched && suggestions.length > 0 && (
                      <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-gray-100">
                        <span className="text-xs text-gray-400">유사 클라이언트:</span>
                        {suggestions.map((s) => (
                          <button
                            key={s.id}
                            onClick={() => applySuggestion(p, s.id)}
                            className="text-xs px-2 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-full transition-colors"
                          >
                            {s.name} <span className="opacity-50">{Math.round(s.score * 100)}%</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* ══════════ 결제 추가/수정 다이얼로그 ══════════ */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing ? '결제 수정' : '결제 추가'}</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1"><Label>결제일 *</Label>
              <Input type="date" value={form.payment_date} onChange={(e) => setForm({ ...form, payment_date: e.target.value })} />
            </div>
            <div className="space-y-1"><Label>금액 *</Label>
              <Input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>프로젝트 연결</Label>
              <select className="w-full border rounded-md px-3 py-2 text-sm" value={form.project_id}
                onChange={(e) => setForm({ ...form, project_id: e.target.value })}>
                <option value="">연결 안함</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label>결제 유형</Label>
              <select className="w-full border rounded-md px-3 py-2 text-sm" value={form.payment_type ?? ''}
                onChange={(e) => setForm({ ...form, payment_type: e.target.value as Payment['payment_type'] })}>
                <option value="">선택 안함</option>
                {['계약금', '중도금', '잔금', '기타'].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="space-y-1"><Label>담당자</Label>
              <Input value={form.manager} onChange={(e) => setForm({ ...form, manager: e.target.value })} />
            </div>
            <div className="space-y-1"><Label>메모</Label>
              <Input value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>취소</Button>
            <Button onClick={handleSave}>저장</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ══════════ 프로젝트 연결 다이얼로그 ══════════ */}
      <Dialog open={matchOpen} onOpenChange={(v) => { setMatchOpen(v); if (!v) setMatchTarget(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>프로젝트 연결</DialogTitle></DialogHeader>
          {matchTarget && (
            <div className="space-y-3 py-2">
              <div className="rounded-md bg-gray-50 p-3 text-sm space-y-1">
                <div className="text-gray-500">상호명: <span className="font-medium text-gray-800">{matchTarget.client_name_raw ?? '-'}</span></div>
                <div className="text-gray-500">금액: <span className="font-medium text-gray-800">{formatKRW(matchTarget.amount)}</span></div>
                <div className="text-gray-500">날짜: {matchTarget.payment_date}</div>
              </div>
              <div className="space-y-1">
                <Label>연결할 프로젝트</Label>
                <select
                  className="w-full border rounded-md px-3 py-2 text-sm"
                  value={matchProjectId}
                  onChange={(e) => setMatchProjectId(e.target.value)}
                >
                  <option value="">연결 안함</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setMatchOpen(false); setMatchTarget(null) }}>취소</Button>
            <Button onClick={handleMatch}>연결</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ══════════ 입금 확정 다이얼로그 ══════════ */}
      <Dialog open={confirmOpen} onOpenChange={(v) => { setConfirmOpen(v); if (!v) setConfirmTarget(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>입금 확정</DialogTitle></DialogHeader>
          {confirmTarget && (
            <div className="space-y-3 py-2">
              <div className="rounded-md bg-green-50 border border-green-200 p-3 text-sm">
                <p className="font-medium text-green-800">{confirmTarget.client_name_raw}</p>
                <p className="text-green-600 text-xs mt-0.5">입금 확정 시 입금 내역으로 이동되고 대시보드 입금액에 반영됩니다.</p>
              </div>
              <div className="space-y-1">
                <Label>실제 입금액 *</Label>
                <Input
                  type="number"
                  value={confirmAmount}
                  onChange={(e) => setConfirmAmount(e.target.value)}
                  autoFocus
                />
                <div className="text-xs text-gray-400 space-y-0.5">
                  <div>수금 예정금액: {formatKRW(confirmTarget.amount)}</div>
                  {(() => {
                    const amt = parseFloat(confirmAmount)
                    const rem = confirmTarget.amount - amt
                    if (!isNaN(amt) && rem > 0.01) {
                      return <div className="text-yellow-600">잔여 {formatKRW(rem)}은 수금 관리에 그대로 남습니다.</div>
                    }
                    return null
                  })()}
                </div>
              </div>
              <div className="space-y-1">
                <Label>프로젝트 연결 (선택)</Label>
                <select
                  className="w-full border rounded-md px-3 py-2 text-sm"
                  value={confirmProjectId}
                  onChange={(e) => setConfirmProjectId(e.target.value)}
                >
                  <option value="">연결 안함</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setConfirmOpen(false); setConfirmTarget(null) }}>취소</Button>
            <Button className="bg-green-600 hover:bg-green-700" onClick={handleConfirm}>
              <CheckCircle size={14} className="mr-1" />입금 확정
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => { if (!v) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>결제 내역 삭제</AlertDialogTitle>
            <AlertDialogDescription>이 결제 내역을 삭제하시겠습니까? 삭제 후 복구할 수 없습니다.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => { if (deleteTarget) { handleDelete(deleteTarget); setDeleteTarget(null) } }}
            >
              삭제
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
