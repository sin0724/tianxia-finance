'use client'

import { useEffect, useState, useMemo } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CurrencyInput } from '@/components/ui/currency-input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/lib/toast'
import { Plus, Pencil, Trash2, Link2, CheckCircle, FolderOpen, EyeOff, Search, ArrowUp, ArrowDown } from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { formatKRW } from '@/lib/calculations/settlement'
import { findSimilar } from '@/lib/utils/levenshtein'
import { useMonth } from '@/components/shared/month-context'
import { MonthNavigator } from '@/components/shared/month-navigator'
import type { Payment, Project, Client, PaymentStatus } from '@/types/database'

type PaymentWithRelations = Payment & {
  projects: { name: string; status: string; clients: { name: string } | null } | null
}

const PENDING_LABEL: Record<Exclude<PaymentStatus, 'confirmed'>, string> = {
  balance_due: '잔금 처리 요망',
  unpaid: '미입금',
}

// ─── 결제 추가/수정 폼 (react-hook-form + zod) ─────────────
const paymentFormSchema = z.object({
  payment_date: z.string().min(1, '결제일을 입력해주세요.'),
  amount: z.string()
    .min(1, '금액을 입력해주세요.')
    .refine((v) => v !== '-' && !isNaN(Number(v)) && Number(v) !== 0, '올바른 금액을 입력해주세요.'),
  client_name: z.string(),
  project_id: z.string(),
  payment_type: z.string(),
  manager: z.string(),
  memo: z.string(),
})
type PaymentFormValues = z.infer<typeof paymentFormSchema>

const emptyPaymentForm: PaymentFormValues = {
  payment_date: '', amount: '', client_name: '',
  project_id: '', payment_type: '', manager: '', memo: '',
}

type SortKey = 'payment_date' | 'client' | 'amount'

export default function PaymentsPage() {
  const supabase = createClient()
  const { year, month } = useMonth()
  const [tab, setTab] = useState<'confirmed' | 'pending'>('confirmed')
  const [payments, setPayments] = useState<PaymentWithRelations[]>([])
  const [allPending, setAllPending] = useState<PaymentWithRelations[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)

  // 검색·정렬
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('payment_date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // 결제 추가/수정 다이얼로그
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Payment | null>(null)
  const {
    register, handleSubmit, control, reset,
    formState: { errors, isSubmitting },
  } = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentFormSchema),
    defaultValues: emptyPaymentForm,
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
  const [confirmDate, setConfirmDate] = useState('')
  const [confirmProjectId, setConfirmProjectId] = useState('')

  // 수금 예정 추가/수정 다이얼로그 (공용 폼)
  const [pendingOpen, setPendingOpen] = useState(false)
  const [pendingEditing, setPendingEditing] = useState<PaymentWithRelations | null>(null)
  const [pendingForm, setPendingForm] = useState({
    client_name_raw: '',
    amount: '',
    payment_date: '',
    payment_type: '' as string,
    status: 'unpaid' as 'unpaid' | 'balance_due',
    manager: '',
    project_id: '',
    memo: '',
  })

  async function load() {
    setLoading(true)
    const start = `${year}-${String(month).padStart(2, '0')}-01`
    // toISOString() 타임존 오프셋 버그 방지 — 직접 날짜 문자열 구성
    const lastDay = new Date(year, month, 0).getDate()
    const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

    const [paymentsRes, pendingRes, projRes, clientRes] = await Promise.all([
      supabase
        .from('payments')
        .select('*, projects(name, status, clients(name))')
        .eq('status', 'confirmed')
        .gte('payment_date', start)
        .lte('payment_date', end)
        .order('payment_date', { ascending: false }),
      supabase
        .from('payments')
        .select('*, projects(name, status, clients(name))')
        .in('status', ['balance_due', 'unpaid'])
        .order('payment_date', { ascending: false }),
      supabase
        .from('projects')
        .select('*')
        .in('status', ['ongoing', 'completed'])
        .order('name'),
      supabase.from('clients').select('*').order('name'),
    ])

    if (paymentsRes.error) toast.error('데이터 로드 실패: ' + paymentsRes.error.message)
    setPayments((paymentsRes.data as unknown as PaymentWithRelations[]) ?? [])
    setAllPending(
      ((pendingRes.data as unknown as PaymentWithRelations[]) ?? [])
        .filter((p) => p.projects?.status !== 'cancelled')
    )
    setProjects(projRes.data ?? [])
    setClients(clientRes.data ?? [])
    setLoading(false)
    // 사이드바 미연결 배지 즉시 갱신
    window.dispatchEvent(new Event('refresh-badges'))
  }

  useEffect(() => { load() }, [year, month])  // eslint-disable-line react-hooks/exhaustive-deps

  // ─── 결제 추가/수정 ────────────────────────────────────
  function openAdd() {
    setEditing(null)
    reset({ ...emptyPaymentForm, payment_date: new Date().toISOString().split('T')[0] })
    setDialogOpen(true)
  }

  function openEdit(p: Payment) {
    setEditing(p)
    reset({
      project_id: p.project_id ?? '',
      client_name: p.client_name_raw ?? '',
      amount: String(p.amount),
      payment_date: p.payment_date,
      payment_type: p.payment_type ?? '',
      manager: p.manager ?? '',
      memo: p.memo ?? '',
    })
    setDialogOpen(true)
  }

  async function onSubmitPayment(values: PaymentFormValues) {
    const amount = Number(values.amount)

    if (editing) {
      const { error } = await supabase.from('payments').update({
        project_id: values.project_id || null,
        amount,
        payment_date: values.payment_date,
        payment_type: (values.payment_type || null) as Payment['payment_type'],
        manager: values.manager || null,
        memo: values.memo || null,
        matched: !!values.project_id,
        client_name_raw: values.client_name.trim() || null,
      }).eq('id', editing.id)
      if (error) { toast.error(error.message); return }
      toast.success('수정되었습니다.')
    } else {
      // 클라이언트·프로젝트 자동 생성 포함 — DB 함수로 원자적으로 처리
      const { data, error } = await supabase.rpc('add_payment_with_auto_project', {
        p_amount: amount,
        p_payment_date: values.payment_date,
        p_payment_type: values.payment_type || null,
        p_manager: values.manager || null,
        p_memo: values.memo || null,
        p_client_name: values.client_name || null,
        p_project_id: values.project_id || null,
        p_status: 'confirmed',
      })
      if (error) { toast.error(error.message); return }
      const result = data as { project_id: string | null; created_project: boolean } | null
      if (result?.created_project) toast.success('결제가 추가되었습니다. (프로젝트 자동 생성)')
      else if (result?.project_id) toast.success('결제가 추가되었습니다.')
      else toast.success('결제가 추가되었습니다. (프로젝트 연결 필요)')
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

  // ─── 집계 제외 토글 ──────────────────────────────────
  async function handleToggleExclude(p: PaymentWithRelations) {
    const { error } = await supabase.from('payments').update({ excluded: !p.excluded }).eq('id', p.id)
    if (error) { toast.error(error.message); return }
    toast.success(p.excluded ? '집계에 다시 포함됩니다.' : '집계에서 제외됩니다.')
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

  // ─── 입금 확정 (수금 관리 탭) — DB 함수로 원자 처리 ────
  function openConfirm(p: PaymentWithRelations) {
    setConfirmTarget(p)
    setConfirmAmount(String(p.amount))
    setConfirmDate(new Date().toISOString().split('T')[0])
    setConfirmProjectId(p.project_id ?? '')
    setConfirmOpen(true)
  }

  async function handleConfirm() {
    if (!confirmTarget) return
    const amount = parseFloat(confirmAmount)
    if (isNaN(amount) || amount <= 0) { toast.error('금액을 확인해주세요.'); return }

    const { data, error } = await supabase.rpc('confirm_pending_payment', {
      p_payment_id: confirmTarget.id,
      p_amount: amount,
      p_payment_date: confirmDate || new Date().toISOString().split('T')[0],
      p_project_id: confirmProjectId || null,
    })
    if (error) { toast.error('처리 실패: ' + error.message); return }

    const remainder = (data as { remainder?: number } | null)?.remainder ?? 0
    if (remainder > 0.01) {
      toast.success(`입금 ${formatKRW(amount)} 확정. 잔여 ${formatKRW(remainder)}은 수금 관리에 남습니다.`)
    } else {
      toast.success('입금 확정 처리되었습니다. 입금액에 반영됩니다.')
    }

    setConfirmOpen(false)
    setConfirmTarget(null)
    load()
  }

  // ─── 수금 예정 추가/수정 ──────────────────────────────
  function openAddPending() {
    setPendingEditing(null)
    setPendingForm({
      client_name_raw: '', amount: '',
      payment_date: new Date().toISOString().split('T')[0],
      payment_type: '', status: 'unpaid', manager: '', project_id: '', memo: '',
    })
    setPendingOpen(true)
  }

  function openEditPending(p: PaymentWithRelations) {
    setPendingEditing(p)
    setPendingForm({
      client_name_raw: p.client_name_raw ?? '',
      amount: String(p.amount),
      payment_date: p.payment_date,
      payment_type: p.payment_type ?? '',
      status: p.status === 'balance_due' ? 'balance_due' : 'unpaid',
      manager: p.manager ?? '',
      project_id: p.project_id ?? '',
      memo: p.memo ?? '',
    })
    setPendingOpen(true)
  }

  async function handleSavePending() {
    const amount = parseFloat(pendingForm.amount)
    if (!pendingForm.client_name_raw.trim() || !pendingForm.payment_date || isNaN(amount)) {
      toast.error('상호명, 날짜, 금액은 필수입니다.')
      return
    }
    const payload = {
      client_name_raw: pendingForm.client_name_raw.trim(),
      amount,
      payment_date: pendingForm.payment_date,
      payment_type: (pendingForm.payment_type || null) as Payment['payment_type'],
      manager: pendingForm.manager || null,
      project_id: pendingForm.project_id || null,
      memo: pendingForm.memo.trim() || null,
      matched: !!pendingForm.project_id,
      status: pendingForm.status,
    }
    if (pendingEditing) {
      const { error } = await supabase.from('payments').update(payload).eq('id', pendingEditing.id)
      if (error) { toast.error(error.message); return }
      toast.success('수정되었습니다.')
    } else {
      const { error } = await supabase.from('payments').insert({ ...payload, source: 'manual' as const })
      if (error) { toast.error(error.message); return }
      toast.success('수금 예정건이 추가되었습니다.')
    }
    setPendingOpen(false)
    setPendingEditing(null)
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

  // ─── 검색·정렬·분류 ───────────────────────────────────
  const isRefundPayment = (p: { amount: number }) => p.amount < 0

  const matchesSearch = (p: PaymentWithRelations, q: string) =>
    !q || [p.client_name_raw, p.projects?.clients?.name, p.projects?.name, p.manager, p.memo]
      .some((s) => s?.toLowerCase().includes(q))

  const q = search.trim().toLowerCase()

  const confirmedList = useMemo(() => {
    const filtered = payments.filter((p) => matchesSearch(p, q))
    const dir = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      if (sortKey === 'amount') return (a.amount - b.amount) * dir
      if (sortKey === 'client') {
        const an = a.projects?.clients?.name ?? a.client_name_raw ?? ''
        const bn = b.projects?.clients?.name ?? b.client_name_raw ?? ''
        return an.localeCompare(bn, 'ko') * dir
      }
      return a.payment_date.localeCompare(b.payment_date) * dir
    })
  }, [payments, q, sortKey, sortDir])

  const pendingList = allPending.filter((p) => matchesSearch(p, q))

  const activeConfirmed = confirmedList.filter((p) => !p.excluded)
  const excludedList = confirmedList.filter((p) => p.excluded)
  const confirmedTotal = activeConfirmed.reduce((s, p) => s + p.amount, 0)
  const excludedTotal = excludedList.reduce((s, p) => s + p.amount, 0)
  const pendingTotal = pendingList.reduce((s, p) => s + p.amount, 0)
  const refundList = activeConfirmed.filter(isRefundPayment)
  const refundTotal = refundList.reduce((s, p) => s + p.amount, 0)

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir(key === 'client' ? 'asc' : 'desc') }
  }

  function renderSortHead(label: string, k: SortKey, className?: string) {
    return (
      <TableHead className={className}>
        <button
          onClick={() => toggleSort(k)}
          className={`inline-flex items-center gap-1 hover:text-gray-900 ${sortKey === k ? 'text-gray-900 font-semibold' : ''}`}
        >
          {label}
          {sortKey === k && (sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
        </button>
      </TableHead>
    )
  }

  return (
    <div className="space-y-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h1 className="text-2xl font-bold">결제 내역</h1>
        <Button onClick={openAdd}><Plus size={16} className="mr-1" />결제 추가</Button>
      </div>

      {/* 탭 + 월 선택 */}
      <div className="flex items-center justify-between border-b flex-wrap gap-2">
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
            {allPending.length > 0 && (
              <span className="ml-1.5 text-xs bg-orange-100 text-orange-600 rounded-full px-1.5 py-0.5">{allPending.length}</span>
            )}
          </button>
        </div>
        {tab === 'confirmed' && <div className="pb-1"><MonthNavigator /></div>}
        {tab === 'pending' && (
          <span className="text-xs text-gray-400 pb-1">전체 기간 미수금 표시</span>
        )}
      </div>

      {/* 검색 */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48 max-w-sm">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            className="pl-8"
            placeholder="상호명·프로젝트·담당자·메모 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {search && (
          <button onClick={() => setSearch('')} className="text-xs text-gray-400 hover:text-gray-600">
            초기화
          </button>
        )}
      </div>

      {/* ══════════ 입금 내역 탭 ══════════ */}
      {tab === 'confirmed' && (
        <>
          <div className="flex items-center justify-end gap-4 flex-wrap">
            {excludedList.length > 0 && (
              <div className="text-xs text-gray-400">
                집계 제외 {excludedList.length}건 (<span className="line-through">{formatKRW(excludedTotal)}</span>)
              </div>
            )}
            {refundList.length > 0 && (
              <div className="text-xs text-red-500">
                환불 {refundList.length}건 ({formatKRW(refundTotal)})
              </div>
            )}
            <div className="text-sm text-gray-600">
              순 입금 <strong className="text-gray-900">{formatKRW(confirmedTotal)}</strong> ({activeConfirmed.length}건)
            </div>
          </div>

          {/* 모바일 카드 뷰 */}
          <div className="md:hidden space-y-2">
            {loading ? (
              <div className="bg-white rounded-lg border text-center py-8 text-gray-400 text-sm">불러오는 중...</div>
            ) : confirmedList.length === 0 ? (
              <div className="bg-white rounded-lg border text-center py-8 text-gray-400 text-sm">
                {search ? '검색 결과가 없습니다.' : '입금 내역이 없습니다.'}
              </div>
            ) : confirmedList.map((p) => (
              <div key={p.id} className={`bg-white rounded-lg border p-4 ${isRefundPayment(p) ? 'border-l-4 border-l-red-400 bg-red-50/30' : !p.matched ? 'border-l-4 border-l-blue-300' : ''} ${p.excluded ? 'opacity-50' : ''}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`font-bold ${p.excluded ? 'text-gray-400 line-through' : isRefundPayment(p) ? 'text-red-600' : 'text-gray-900'}`}>{formatKRW(p.amount)}</span>
                      {isRefundPayment(p) && <Badge variant="destructive" className="text-xs">환불</Badge>}
                      <span className="text-xs text-gray-400">{p.payment_date}</span>
                      {p.source === 'slack' && <Badge variant="outline" className="text-xs text-gray-400">Slack</Badge>}
                    </div>
                    <div className="text-sm text-gray-700 mt-0.5">
                      {p.projects?.clients?.name ?? (p.client_name_raw ? <span className="text-blue-500">{p.client_name_raw}</span> : <span className="text-gray-300">-</span>)}
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-xs text-gray-500 flex-wrap">
                      {p.projects?.name ? (
                        <span>{p.projects.name}</span>
                      ) : (
                        <button onClick={() => openMatch(p)} className="text-blue-400 flex items-center gap-0.5">
                          <Link2 size={11} />연결 필요
                        </button>
                      )}
                      {p.payment_type && <span>{p.payment_type}</span>}
                      {p.manager && <span>담당: {p.manager}</span>}
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {!p.matched && (
                      <Button size="sm" variant="ghost" className="text-blue-400" onClick={() => openMatch(p)}>
                        <Link2 size={14} />
                      </Button>
                    )}
                    <Button
                      size="sm" variant="ghost"
                      className={p.excluded ? 'text-orange-400' : 'text-gray-300 hover:text-orange-400'}
                      title={p.excluded ? '집계 제외 중 — 클릭하여 포함' : '집계에서 제외'}
                      onClick={() => handleToggleExclude(p)}
                    >
                      <EyeOff size={14} />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => openEdit(p)}><Pencil size={14} /></Button>
                    <Button size="sm" variant="ghost" className="text-red-400" onClick={() => setDeleteTarget(p.id)}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* 데스크톱 테이블 */}
          <div className="hidden md:block bg-white rounded-lg border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {renderSortHead('결제일', 'payment_date')}
                  {renderSortHead('클라이언트', 'client')}
                  <TableHead>프로젝트</TableHead>
                  <TableHead>유형</TableHead>
                  <TableHead>담당자</TableHead>
                  {renderSortHead('금액', 'amount', 'text-right')}
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-8 text-gray-400">불러오는 중...</TableCell></TableRow>
                ) : confirmedList.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-8 text-gray-400">
                    {search ? '검색 결과가 없습니다.' : '입금 내역이 없습니다.'}
                  </TableCell></TableRow>
                ) : confirmedList.map((p) => (
                  <TableRow key={p.id} className={`${isRefundPayment(p) ? 'bg-red-50/40' : !p.matched ? 'bg-blue-50/30' : ''}${p.excluded ? ' opacity-50' : ''}`}>
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
                    <TableCell>
                      {isRefundPayment(p)
                        ? <Badge variant="destructive" className="text-xs">환불</Badge>
                        : (p.payment_type ?? '-')
                      }
                    </TableCell>
                    <TableCell>{p.manager ?? '-'}</TableCell>
                    <TableCell className="text-right font-medium">
                      {p.excluded
                        ? <span className="line-through text-gray-400">{formatKRW(p.amount)}</span>
                        : <span className={isRefundPayment(p) ? 'text-red-600' : ''}>{formatKRW(p.amount)}</span>
                      }
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1 justify-end">
                        {!p.matched && (
                          <Button size="sm" variant="ghost" className="text-blue-400" onClick={() => openMatch(p)}>
                            <Link2 size={14} />
                          </Button>
                        )}
                        <Button
                          size="sm" variant="ghost"
                          className={p.excluded ? 'text-orange-400 hover:text-orange-600' : 'text-gray-300 hover:text-orange-400'}
                          title={p.excluded ? '집계 제외 중 — 클릭하여 포함' : '집계에서 제외'}
                          onClick={() => handleToggleExclude(p)}
                        >
                          <EyeOff size={14} />
                        </Button>
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
          <div className="flex items-center justify-between">
            <div className="text-sm text-gray-600">
              수금 예정 <strong className="text-orange-600">{formatKRW(pendingTotal)}</strong> ({pendingList.length}건)
            </div>
            <Button size="sm" onClick={openAddPending}>
              <Plus size={14} className="mr-1" />수금 예정 추가
            </Button>
          </div>

          {pendingList.length === 0 ? (
            <div className="bg-white rounded-lg border text-center py-12 text-gray-400 text-sm">
              {search ? '검색 결과가 없습니다.' : '수금 관리 항목이 없습니다.'}
            </div>
          ) : (
            <div className="space-y-2">
              {pendingList.map((p) => {
                const isJanggeum = p.status === 'balance_due'
                const suggestions = findSimilar(p.client_name_raw ?? '', clientCandidates, 3, 0.35)

                return (
                  <div key={p.id} className={`bg-white rounded-lg border p-4 space-y-3 ${isJanggeum ? 'border-l-4 border-l-yellow-400' : 'border-l-4 border-l-red-400'}`}>
                    {/* 상단: 기본 정보 */}
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${isJanggeum ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'}`}>
                            {PENDING_LABEL[p.status as 'balance_due' | 'unpaid']}
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
                        {p.memo && <div className="text-xs text-gray-500 italic">{p.memo}</div>}
                      </div>

                      {/* 액션 버튼 */}
                      <div className="flex flex-wrap gap-2 shrink-0 mt-2 sm:mt-0 sm:flex-nowrap">
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
                        <Button size="sm" variant="ghost" onClick={() => openEditPending(p)}>
                          <Pencil size={14} />
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
        <DialogContent className="w-[calc(100%-1rem)] max-w-md max-h-[90dvh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editing ? '결제 수정' : '결제 추가'}</DialogTitle></DialogHeader>
          <form onSubmit={handleSubmit(onSubmitPayment)} className="space-y-3 py-2">
            <div className="space-y-1">
              <Label>결제일 *</Label>
              <Input type="date" {...register('payment_date')} aria-invalid={!!errors.payment_date} />
              {errors.payment_date && <p className="text-xs text-red-500">{errors.payment_date.message}</p>}
            </div>
            <div className="space-y-1">
              <Label>금액 *</Label>
              <Controller
                name="amount"
                control={control}
                render={({ field }) => (
                  <CurrencyInput value={field.value} onChange={field.onChange} aria-invalid={!!errors.amount} />
                )}
              />
              {errors.amount && <p className="text-xs text-red-500">{errors.amount.message}</p>}
            </div>
            <div className="space-y-1">
              <Label>상호명</Label>
              <Input placeholder="입력 시 클라이언트·프로젝트 자동 생성" {...register('client_name')} />
            </div>
            <div className="space-y-1">
              <Label>프로젝트 연결</Label>
              <select className="w-full border rounded-md px-3 py-2 text-sm" {...register('project_id')}>
                <option value="">연결 안함 (상호명 입력 시 자동 연결)</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label>결제 유형</Label>
              <select className="w-full border rounded-md px-3 py-2 text-sm" {...register('payment_type')}>
                <option value="">선택 안함</option>
                {['계약금', '중도금', '잔금', '기타'].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label>담당자</Label>
              <Input {...register('manager')} />
            </div>
            <div className="space-y-1">
              <Label>메모</Label>
              <Input {...register('memo')} />
            </div>
            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>취소</Button>
              <Button type="submit" disabled={isSubmitting}>{isSubmitting ? '저장 중...' : '저장'}</Button>
            </DialogFooter>
          </form>
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
      <Dialog open={confirmOpen} onOpenChange={(v) => { setConfirmOpen(v); if (!v) { setConfirmTarget(null); setConfirmDate('') } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>입금 확정</DialogTitle></DialogHeader>
          {confirmTarget && (
            <div className="space-y-3 py-2">
              <div className="rounded-md bg-green-50 border border-green-200 p-3 text-sm">
                <p className="font-medium text-green-800">{confirmTarget.client_name_raw}</p>
                <p className="text-green-600 text-xs mt-0.5">입금 확정 시 입금 내역으로 이동되고 대시보드 입금액에 반영됩니다.</p>
              </div>
              <div className="space-y-1">
                <Label>실제 입금일 *</Label>
                <Input
                  type="date"
                  value={confirmDate}
                  onChange={(e) => setConfirmDate(e.target.value)}
                />
                <div className="text-xs text-gray-400">해당 월의 인센티브·정산 기준이 됩니다.</div>
              </div>
              <div className="space-y-1">
                <Label>실제 입금액 *</Label>
                <CurrencyInput
                  value={confirmAmount}
                  onChange={setConfirmAmount}
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

      {/* ══════════ 수금 예정 추가/수정 다이얼로그 ══════════ */}
      <Dialog open={pendingOpen} onOpenChange={(v) => { setPendingOpen(v); if (!v) setPendingEditing(null) }}>
        <DialogContent className="w-[calc(100%-1rem)] max-w-md max-h-[90dvh] overflow-y-auto">
          <DialogHeader><DialogTitle>{pendingEditing ? '수금 예정 수정' : '수금 예정 추가'}</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label>상호명 *</Label>
              <Input
                placeholder="클라이언트명 입력"
                value={pendingForm.client_name_raw}
                onChange={(e) => setPendingForm({ ...pendingForm, client_name_raw: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>금액 *</Label>
              <CurrencyInput
                value={pendingForm.amount}
                onChange={(v) => setPendingForm({ ...pendingForm, amount: v })}
              />
            </div>
            <div className="space-y-1">
              <Label>예정일 *</Label>
              <Input
                type="date"
                value={pendingForm.payment_date}
                onChange={(e) => setPendingForm({ ...pendingForm, payment_date: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>수금 상태</Label>
              <select
                className="w-full border rounded-md px-3 py-2 text-sm"
                value={pendingForm.status}
                onChange={(e) => setPendingForm({ ...pendingForm, status: e.target.value as 'unpaid' | 'balance_due' })}
              >
                <option value="unpaid">🔴 미입금</option>
                <option value="balance_due">⚠ 잔금 처리 요망</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label>결제 유형</Label>
              <select
                className="w-full border rounded-md px-3 py-2 text-sm"
                value={pendingForm.payment_type}
                onChange={(e) => setPendingForm({ ...pendingForm, payment_type: e.target.value })}
              >
                <option value="">선택 안함</option>
                {['계약금', '중도금', '잔금', '기타'].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label>담당자</Label>
              <Input
                value={pendingForm.manager}
                onChange={(e) => setPendingForm({ ...pendingForm, manager: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>프로젝트 연결 (선택)</Label>
              <select
                className="w-full border rounded-md px-3 py-2 text-sm"
                value={pendingForm.project_id}
                onChange={(e) => setPendingForm({ ...pendingForm, project_id: e.target.value })}
              >
                <option value="">연결 안함</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label>메모</Label>
              <Input
                placeholder="특이사항, 계약 내용 등"
                value={pendingForm.memo}
                onChange={(e) => setPendingForm({ ...pendingForm, memo: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setPendingOpen(false); setPendingEditing(null) }}>취소</Button>
            <Button onClick={handleSavePending}>{pendingEditing ? '저장' : '추가'}</Button>
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
