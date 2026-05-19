'use client'

import React, { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { toast } from 'sonner'
import { formatKRW } from '@/lib/calculations/settlement'
import { Plus, Pencil, Trash2, ChevronDown, ChevronRight, Check, X, Ban } from 'lucide-react'
import type { Project, Client, Product, ProjectItem } from '@/types/database'

type ProjectWithRelations = Project & {
  clients: { name: string } | null
  paid_amount: number
  pending_amount: number
  item_count: number
  total_list_price: number  // 구성 상품 정가 합계
  total_cost: number        // 구성 상품 실행비 합계
}

type ItemForm = {
  item_name: string
  product_id: string
  quantity: string
  unit_price_snapshot: string
  unit_cost_snapshot: string
}

const STATUS_LABEL: Record<Project['status'], string> = {
  ongoing: '진행중',
  completed: '완료',
  cancelled: '취소',
}

const STATUS_VARIANT: Record<Project['status'], 'default' | 'secondary' | 'destructive'> = {
  ongoing: 'default',
  completed: 'secondary',
  cancelled: 'destructive',
}

export default function ProjectsPage() {
  const supabase = createClient()
  const now = new Date()
  const [projects, setProjects] = useState<ProjectWithRelations[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [itemsDialogOpen, setItemsDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Project | null>(null)
  const [selectedProject, setSelectedProject] = useState<ProjectWithRelations | null>(null)
  const [projectItems, setProjectItems] = useState<(ProjectItem & { item_name: string | null; products: { name: string; category: string | null } | null })[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // 필터
  const [filterYear, setFilterYear]   = useState<number | null>(null)
  const [filterMonth, setFilterMonth] = useState<number | null>(null)
  const [filterStatus, setFilterStatus] = useState<Project['status'] | 'all'>('all')
  const [searchQuery, setSearchQuery] = useState('')

  const [form, setForm] = useState({
    client_id: '', name: '', total_amount: '', contract_date: '',
    status: 'ongoing' as Project['status'], memo: '',
  })
  const [items, setItems] = useState<ItemForm[]>([{ item_name: '', product_id: '', quantity: '1', unit_price_snapshot: '', unit_cost_snapshot: '' }])

  async function load() {
    const { data: projectData } = await supabase
      .from('projects')
      .select('*, clients(name)')
      .order('created_at', { ascending: false })

    // 각 프로젝트의 결제 합계 계산 (입금완료 vs 수금 예정 분리)
    const { data: paymentData } = await supabase
      .from('payments')
      .select('project_id, amount, memo')
      .not('project_id', 'is', null)

    const paidMap: Record<string, number> = {}
    const pendingMap: Record<string, number> = {}
    for (const p of paymentData ?? []) {
      if (!p.project_id) continue
      const isPending = !!(p.memo?.includes('⚠ 잔금 처리 요망') || p.memo?.includes('🔴 미입금'))
      if (isPending) {
        pendingMap[p.project_id] = (pendingMap[p.project_id] ?? 0) + p.amount
      } else {
        paidMap[p.project_id] = (paidMap[p.project_id] ?? 0) + p.amount
      }
    }

    // 프로젝트별 구성 상품 수 + 정가/실행비 합계
    const { data: itemData } = await supabase
      .from('project_items')
      .select('project_id, quantity, unit_price_snapshot, unit_cost_snapshot')
    const itemCountMap: Record<string, number> = {}
    const listPriceMap: Record<string, number> = {}
    const costMap: Record<string, number> = {}
    for (const item of itemData ?? []) {
      if (!item.project_id) continue
      itemCountMap[item.project_id] = (itemCountMap[item.project_id] ?? 0) + 1
      listPriceMap[item.project_id] = (listPriceMap[item.project_id] ?? 0) + item.unit_price_snapshot * item.quantity
      costMap[item.project_id] = (costMap[item.project_id] ?? 0) + item.unit_cost_snapshot * item.quantity
    }

    const merged = (projectData as unknown as (Project & { clients: { name: string } | null })[])?.map((p) => ({
      ...p,
      paid_amount: paidMap[p.id] ?? 0,
      pending_amount: pendingMap[p.id] ?? 0,
      item_count: itemCountMap[p.id] ?? 0,
      total_list_price: listPriceMap[p.id] ?? 0,
      total_cost: costMap[p.id] ?? 0,
    })) ?? []

    setProjects(merged)
    setLoading(false)

    const { data: clientData } = await supabase.from('clients').select('*').order('name')
    setClients(clientData ?? [])

    const { data: productData } = await supabase.from('products').select('*').eq('active', true).order('name')
    setProducts(productData ?? [])
  }

  useEffect(() => { load() }, [])

  function openAdd() {
    setEditing(null)
    setForm({ client_id: '', name: '', total_amount: '', contract_date: new Date().toISOString().split('T')[0], status: 'ongoing', memo: '' })
    setItems([{ item_name: '', product_id: '', quantity: '1', unit_price_snapshot: '', unit_cost_snapshot: '' }])
    setDialogOpen(true)
  }

  function openEdit(p: ProjectWithRelations) {
    setEditing(p)
    setForm({
      client_id: p.client_id ?? '', name: p.name, total_amount: String(p.total_amount),
      contract_date: p.contract_date ?? '', status: p.status, memo: p.memo ?? '',
    })
    setItems([])
    setDialogOpen(true)
  }

  async function openItems(p: ProjectWithRelations) {
    setSelectedProject(p)
    const { data } = await supabase
      .from('project_items')
      .select('*, products(name, category)')
      .eq('project_id', p.id)
      .order('created_at')
    setProjectItems((data as unknown as (ProjectItem & { item_name: string | null; products: { name: string; category: string | null } | null })[]) ?? [])
    setItemsDialogOpen(true)
  }

  function onProductChange(index: number, productId: string) {
    const product = products.find((p) => p.id === productId)
    setItems((prev) => prev.map((item, i) =>
      i === index ? {
        ...item,
        product_id: productId,
        item_name: item.item_name || (product ? (product.category ?? product.name) : ''),
        unit_price_snapshot: product ? String(product.price_vat_incl) : item.unit_price_snapshot,
        unit_cost_snapshot: product ? String(product.current_cost) : item.unit_cost_snapshot,
      } : item
    ))
  }

  function addItemRow() {
    setItems((prev) => [...prev, { item_name: '', product_id: '', quantity: '1', unit_price_snapshot: '', unit_cost_snapshot: '' }])
  }

  function removeItemRow(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index))
  }

  async function handleSave() {
    const amount = parseFloat(form.total_amount)
    if (!form.name || isNaN(amount)) {
      toast.error('프로젝트명과 계약금액은 필수입니다.')
      return
    }

    const payload = {
      client_id: form.client_id || null,
      name: form.name,
      total_amount: amount,
      contract_date: form.contract_date || null,
      status: form.status,
      memo: form.memo || null,
    }

    if (editing) {
      const { error } = await supabase.from('projects').update(payload).eq('id', editing.id)
      if (error) { toast.error('수정 실패: ' + error.message); return }
      toast.success('프로젝트가 수정되었습니다.')
    } else {
      const { data, error } = await supabase.from('projects').insert(payload).select().single()
      if (error || !data) { toast.error('추가 실패'); return }

      // 구성 상품 저장
      const validItems = items.filter((it) => it.item_name.trim() && it.quantity)
      if (validItems.length > 0) {
        await supabase.from('project_items').insert(
          validItems.map((it) => ({
            project_id: (data as Project).id,
            product_id: it.product_id || null,
            item_name: it.item_name.trim() || null,
            quantity: parseInt(it.quantity),
            unit_price_snapshot: parseFloat(it.unit_price_snapshot) || 0,
            unit_cost_snapshot: parseFloat(it.unit_cost_snapshot) || 0,
          }))
        )
      }
      toast.success('프로젝트가 추가되었습니다.')
    }

    setDialogOpen(false)
    load()
  }

  async function handleCancel(id: string) {
    await supabase.from('projects').update({ status: 'cancelled' }).eq('id', id)
    toast.success('프로젝트가 취소 처리되었습니다.')
    load()
  }

  async function handleDelete(id: string) {
    await supabase.from('project_items').delete().eq('project_id', id)
    await supabase.from('payments').update({ project_id: null, matched: false }).eq('project_id', id)
    const { error } = await supabase.from('projects').delete().eq('id', id)
    if (error) { toast.error('삭제 실패: ' + error.message); return }
    toast.success('프로젝트가 삭제되었습니다.')
    setDeleteTarget(null)
    load()
  }

  async function handleAddItem(projectId: string, item: ItemForm) {
    if (!item.item_name.trim()) { toast.error('항목명을 입력하세요.'); return }
    const { error } = await supabase.from('project_items').insert({
      project_id: projectId,
      product_id: item.product_id || null,
      item_name: item.item_name.trim(),
      quantity: parseInt(item.quantity) || 1,
      unit_price_snapshot: parseFloat(item.unit_price_snapshot) || 0,
      unit_cost_snapshot: parseFloat(item.unit_cost_snapshot) || 0,
    })
    if (error) { toast.error('추가 실패: ' + error.message); return }
    toast.success('상품이 추가되었습니다.')
    if (selectedProject) openItems(selectedProject)
  }

  async function handleDeleteItem(itemId: string) {
    await supabase.from('project_items').delete().eq('id', itemId)
    toast.success('삭제되었습니다.')
    setEditingItemId(null)
    if (selectedProject) openItems(selectedProject)
  }

  function startEditItem(item: typeof projectItems[number]) {
    setEditingItemId(item.id)
    setEditingItemForm({
      item_name: item.item_name ?? item.products?.category ?? item.products?.name ?? '',
      product_id: item.product_id ?? '',
      quantity: String(item.quantity),
      unit_price_snapshot: String(item.unit_price_snapshot),
      unit_cost_snapshot: String(item.unit_cost_snapshot),
    })
  }

  async function handleUpdateItem(itemId: string) {
    if (!editingItemForm.item_name.trim()) { toast.error('항목명을 입력하세요.'); return }
    const { error } = await supabase.from('project_items').update({
      item_name: editingItemForm.item_name.trim(),
      product_id: editingItemForm.product_id || null,
      quantity: parseInt(editingItemForm.quantity) || 1,
      unit_price_snapshot: parseFloat(editingItemForm.unit_price_snapshot) || 0,
      unit_cost_snapshot: parseFloat(editingItemForm.unit_cost_snapshot) || 0,
    }).eq('id', itemId)
    if (error) { toast.error('수정 실패: ' + error.message); return }
    toast.success('수정되었습니다.')
    setEditingItemId(null)
    if (selectedProject) openItems(selectedProject)
  }

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [newItem, setNewItem] = useState<ItemForm>({ item_name: '', product_id: '', quantity: '1', unit_price_snapshot: '', unit_cost_snapshot: '' })
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  const [editingItemForm, setEditingItemForm] = useState<ItemForm>({ item_name: '', product_id: '', quantity: '1', unit_price_snapshot: '', unit_cost_snapshot: '' })

  // 필터 적용
  const filteredProjects = projects.filter((p) => {
    if (filterStatus !== 'all' && p.status !== filterStatus) return false
    if (filterYear && filterMonth) {
      const prefix = `${filterYear}-${String(filterMonth).padStart(2, '0')}`
      if (!p.contract_date?.startsWith(prefix)) return false
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      const matchName = p.name.toLowerCase().includes(q)
      const matchClient = p.clients?.name?.toLowerCase().includes(q)
      if (!matchName && !matchClient) return false
    }
    return true
  })

  const filterLabel = filterYear && filterMonth
    ? `${filterYear}년 ${filterMonth}월 계약`
    : '전체'

  return (
    <div className="space-y-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">프로젝트 관리</h1>
        <Button onClick={openAdd}><Plus size={16} className="mr-1" />프로젝트 추가</Button>
      </div>

      {/* 필터 바 */}
      <div className="flex items-center gap-2 flex-wrap">
        <Input
          className="w-48 h-8 text-sm"
          placeholder="프로젝트명 / 클라이언트 검색"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <select className="border rounded-md px-2 py-1.5 text-sm" value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value as Project['status'] | 'all')}>
          <option value="all">전체 상태</option>
          <option value="ongoing">진행중</option>
          <option value="completed">완료</option>
          <option value="cancelled">취소</option>
        </select>

        <select className="border rounded-md px-2 py-1.5 text-sm"
          value={filterYear ?? ''}
          onChange={(e) => { setFilterYear(e.target.value ? Number(e.target.value) : null); setFilterMonth(null) }}>
          <option value="">연도 전체</option>
          {[2023, 2024, 2025, 2026].map((y) => <option key={y} value={y}>{y}년</option>)}
        </select>

        {filterYear && (
          <select className="border rounded-md px-2 py-1.5 text-sm"
            value={filterMonth ?? ''}
            onChange={(e) => setFilterMonth(e.target.value ? Number(e.target.value) : null)}>
            <option value="">월 전체</option>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>{m}월</option>
            ))}
          </select>
        )}

        {(filterStatus !== 'all' || filterYear || searchQuery) && (
          <button
            onClick={() => { setFilterStatus('all'); setFilterYear(null); setFilterMonth(null); setSearchQuery('') }}
            className="text-xs text-blue-500 hover:underline"
          >
            필터 초기화
          </button>
        )}

        <span className="text-xs text-gray-400 ml-auto">
          {filterLabel} · {filteredProjects.length}건
        </span>
      </div>

      <div className="bg-white rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8"></TableHead>
              <TableHead>프로젝트명</TableHead>
              <TableHead>클라이언트</TableHead>
              <TableHead>계약일</TableHead>
              <TableHead>상태</TableHead>
              <TableHead className="text-right">계약금액</TableHead>
              <TableHead className="text-right">입금완료</TableHead>
              <TableHead className="text-right">수금 예정</TableHead>
              <TableHead className="text-center">구성 상품</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={10} className="text-center py-8 text-gray-400">불러오는 중...</TableCell></TableRow>
            ) : filteredProjects.length === 0 ? (
              <TableRow><TableCell colSpan={10} className="text-center py-8 text-gray-400">
                {projects.length === 0 ? '등록된 프로젝트가 없습니다.' : '조건에 맞는 프로젝트가 없습니다.'}
              </TableCell></TableRow>
            ) : filteredProjects.map((p) => {
              const progress = p.total_amount > 0 ? Math.min(100, Math.round(p.paid_amount / p.total_amount * 100)) : 0
              const discountAmt = p.total_list_price > 0 ? p.total_list_price - p.total_amount : 0
              const discountRate = p.total_list_price > 0 ? (discountAmt / p.total_list_price) * 100 : 0
              const hasDiscount = p.total_list_price > 0 && Math.abs(discountAmt) > 0.5
              return (
                <TableRow key={p.id} className={p.item_count === 0 ? 'bg-orange-50/30' : ''}>
                  <TableCell>
                    <button
                      onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
                      className="text-gray-400 hover:text-gray-700"
                    >
                      {expandedId === p.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                  </TableCell>
                  <TableCell className="font-medium">
                    <div>{p.name}</div>
                    {expandedId === p.id && (
                      <div className="mt-2 text-xs text-gray-500 space-y-1">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                            <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${progress}%` }} />
                          </div>
                          <span className="shrink-0">{progress}% 입금</span>
                        </div>
                        {p.memo && <div className="text-gray-400">{p.memo}</div>}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{p.clients?.name ?? <span className="text-gray-400">-</span>}</TableCell>
                  <TableCell>{p.contract_date ?? '-'}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div>{formatKRW(p.total_amount)}</div>
                    {hasDiscount && (
                      <div className="text-xs text-blue-500 mt-0.5">
                        할인 {discountRate.toFixed(1)}%
                      </div>
                    )}
                    {p.total_cost > 0 && (
                      <div className="text-xs text-orange-500 mt-0.5">
                        실행비 {formatKRW(p.total_cost)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    <span className={p.paid_amount > 0 ? 'text-green-600' : 'text-gray-300'}>
                      {p.paid_amount > 0 ? formatKRW(p.paid_amount) : '-'}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    {p.pending_amount > 0
                      ? <span className="text-yellow-600">{formatKRW(p.pending_amount)}</span>
                      : <span className="text-gray-300">-</span>}
                  </TableCell>
                  {/* 구성 상품 — 입력 여부를 한눈에 */}
                  <TableCell className="text-center">
                    {p.item_count > 0 ? (
                      <button
                        onClick={() => openItems(p)}
                        className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors"
                      >
                        {p.item_count}개 입력됨
                      </button>
                    ) : (
                      <button
                        onClick={() => openItems(p)}
                        className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-600 hover:bg-orange-200 transition-colors"
                      >
                        미입력
                      </button>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1 justify-end">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(p)}><Pencil size={14} /></Button>
                      {p.status !== 'cancelled' && (
                        <Button size="sm" variant="ghost" className="text-orange-400 hover:text-orange-600" title="취소 처리" onClick={() => handleCancel(p.id)}>
                          <Ban size={14} />
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" className="text-red-400 hover:text-red-600" title="영구 삭제" onClick={() => setDeleteTarget(p.id)}>
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      {/* 프로젝트 추가/수정 다이얼로그 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="w-[calc(100%-1rem)] max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? '프로젝트 수정' : '프로젝트 추가'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1 col-span-2">
                <Label>프로젝트명 *</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="예: 삼성전자 브랜드 캠페인" />
              </div>
              <div className="space-y-1">
                <Label>클라이언트</Label>
                <select
                  className="w-full border rounded-md px-3 py-2 text-sm"
                  value={form.client_id}
                  onChange={(e) => setForm({ ...form, client_id: e.target.value })}
                >
                  <option value="">선택 안함</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label>상태</Label>
                <select
                  className="w-full border rounded-md px-3 py-2 text-sm"
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as Project['status'] })}
                >
                  <option value="ongoing">진행중</option>
                  <option value="completed">완료</option>
                  <option value="cancelled">취소</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label>계약금액 (VAT포함) *</Label>
                <Input type="number" value={form.total_amount} onChange={(e) => setForm({ ...form, total_amount: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label>계약일</Label>
                <Input type="date" value={form.contract_date} onChange={(e) => setForm({ ...form, contract_date: e.target.value })} />
              </div>
              <div className="space-y-1 col-span-2">
                <Label>메모</Label>
                <Input value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
              </div>
            </div>

            {!editing && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>구성 상품</Label>
                  <Button type="button" size="sm" variant="outline" onClick={addItemRow}><Plus size={12} className="mr-1" />행 추가</Button>
                </div>
                {items.map((item, idx) => (
                  <div key={idx} className="space-y-1.5 p-2 border rounded-md bg-gray-50">
                    <div className="flex gap-2 items-center">
                      <Input
                        className="flex-1 text-sm"
                        placeholder="항목명 *"
                        value={item.item_name}
                        onChange={(e) => setItems((prev) => prev.map((it, i) => i === idx ? { ...it, item_name: e.target.value } : it))}
                      />
                      <select
                        className="flex-1 border rounded-md px-2 py-1.5 text-sm bg-white"
                        value={item.product_id}
                        onChange={(e) => onProductChange(idx, e.target.value)}
                      >
                        <option value="">상품 연결 (선택사항)</option>
                        {products.map((p) => <option key={p.id} value={p.id}>{p.category ?? p.name}</option>)}
                      </select>
                      <button onClick={() => removeItemRow(idx)} className="text-red-400 hover:text-red-600 shrink-0">
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <div className="flex gap-2 items-center">
                      <Input
                        type="number"
                        className="w-20 text-sm"
                        placeholder="수량"
                        value={item.quantity}
                        onChange={(e) => setItems((prev) => prev.map((it, i) => i === idx ? { ...it, quantity: e.target.value } : it))}
                      />
                      <Input
                        type="number"
                        className="flex-1 text-sm"
                        placeholder="판매가 (VAT포함)"
                        value={item.unit_price_snapshot}
                        onChange={(e) => setItems((prev) => prev.map((it, i) => i === idx ? { ...it, unit_price_snapshot: e.target.value } : it))}
                      />
                      <Input
                        type="number"
                        className="flex-1 text-sm"
                        placeholder="실행비 (원가)"
                        value={item.unit_cost_snapshot}
                        onChange={(e) => setItems((prev) => prev.map((it, i) => i === idx ? { ...it, unit_cost_snapshot: e.target.value } : it))}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>취소</Button>
            <Button onClick={handleSave}>저장</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 구성 상품 다이얼로그 */}
      <Dialog open={itemsDialogOpen} onOpenChange={(open) => { setItemsDialogOpen(open); if (!open) setEditingItemId(null) }}>
        <DialogContent className="max-w-5xl sm:max-w-5xl w-full max-h-[85vh] flex flex-col overflow-hidden p-0">
          <DialogHeader className="px-6 pt-6 pb-3 shrink-0">
            <DialogTitle>{selectedProject?.name} — 구성 상품</DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 pb-2">
            {/* 헤더 행 */}
            <div className="flex items-center gap-3 py-2 border-b text-xs font-medium text-gray-500 sticky top-0 bg-white z-10">
              <div className="flex-1 min-w-0">항목명</div>
              <div className="w-36 shrink-0">상품 연결</div>
              <div className="w-12 shrink-0 text-right">수량</div>
              <div className="w-36 shrink-0 text-right">판매가 (VAT포함)</div>
              <div className="w-36 shrink-0 text-right">실행비 (원가)</div>
              <div className="w-16 shrink-0"></div>
            </div>

            {/* 항목 목록 */}
            {projectItems.length === 0 ? (
              <div className="py-8 text-center text-sm text-gray-400">등록된 항목 없음</div>
            ) : projectItems.map((item) => {
              const isEditing = editingItemId === item.id
              return (
                <React.Fragment key={item.id}>
                  {/* 읽기 행 */}
                  <div className={`flex items-center gap-3 py-2.5 border-b text-sm group ${isEditing ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                    <div className="flex-1 min-w-0 font-medium truncate">
                      {item.item_name ?? item.products?.category ?? item.products?.name ?? '-'}
                    </div>
                    <div className="w-36 shrink-0 text-gray-400 truncate text-xs">
                      {item.product_id ? (item.products?.category ?? item.products?.name) : <span className="text-gray-300">직접 입력</span>}
                    </div>
                    <div className="w-12 shrink-0 text-right">{item.quantity}</div>
                    <div className="w-36 shrink-0 text-right">{formatKRW(item.unit_price_snapshot)}</div>
                    <div className="w-36 shrink-0 text-right text-orange-600">{formatKRW(item.unit_cost_snapshot)}</div>
                    <div className="w-16 shrink-0 flex gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                        onClick={() => isEditing ? setEditingItemId(null) : startEditItem(item)}>
                        {isEditing ? <X size={13} /> : <Pencil size={13} />}
                      </Button>
                      <Button size="sm" variant="ghost" className="text-red-400 h-7 w-7 p-0"
                        onClick={() => handleDeleteItem(item.id)}>
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  </div>

                  {/* 편집 행 */}
                  {isEditing && (
                    <div className="flex items-end gap-3 py-2 px-2 bg-blue-50 border-b">
                      <div className="flex-1 space-y-1 min-w-0">
                        <Label className="text-xs text-gray-500">항목명 *</Label>
                        <Input className="text-sm h-8" value={editingItemForm.item_name}
                          onChange={(e) => setEditingItemForm({ ...editingItemForm, item_name: e.target.value })} />
                      </div>
                      <div className="w-36 shrink-0 space-y-1">
                        <Label className="text-xs text-gray-500">상품 연결</Label>
                        <select className="w-full border rounded-md px-2 h-8 text-sm bg-white"
                          value={editingItemForm.product_id}
                          onChange={(e) => {
                            const product = products.find((p) => p.id === e.target.value)
                            setEditingItemForm({
                              ...editingItemForm,
                              product_id: e.target.value,
                              unit_price_snapshot: product ? String(product.price_vat_incl) : editingItemForm.unit_price_snapshot,
                              unit_cost_snapshot: product ? String(product.current_cost) : editingItemForm.unit_cost_snapshot,
                            })
                          }}>
                          <option value="">직접 입력</option>
                          {products.map((p) => <option key={p.id} value={p.id}>{p.category ?? p.name}</option>)}
                        </select>
                      </div>
                      <div className="w-12 shrink-0 space-y-1">
                        <Label className="text-xs text-gray-500">수량</Label>
                        <Input type="number" className="text-sm h-8 text-right" value={editingItemForm.quantity}
                          onChange={(e) => setEditingItemForm({ ...editingItemForm, quantity: e.target.value })} />
                      </div>
                      <div className="w-36 shrink-0 space-y-1">
                        <Label className="text-xs text-gray-500">판매가 (VAT포함)</Label>
                        <Input type="number" className="text-sm h-8 text-right" value={editingItemForm.unit_price_snapshot}
                          onChange={(e) => setEditingItemForm({ ...editingItemForm, unit_price_snapshot: e.target.value })} />
                      </div>
                      <div className="w-36 shrink-0 space-y-1">
                        <Label className="text-xs text-gray-500">실행비 (원가)</Label>
                        <Input type="number" className="text-sm h-8 text-right" value={editingItemForm.unit_cost_snapshot}
                          onChange={(e) => setEditingItemForm({ ...editingItemForm, unit_cost_snapshot: e.target.value })} />
                      </div>
                      <div className="w-16 shrink-0 flex gap-1 pb-0.5">
                        <Button size="sm" className="h-8 px-2" onClick={() => handleUpdateItem(item.id)}>
                          <Check size={13} className="mr-1" />저장
                        </Button>
                        <Button size="sm" variant="outline" className="h-8 px-2" onClick={() => setEditingItemId(null)}>
                          취소
                        </Button>
                      </div>
                    </div>
                  )}
                </React.Fragment>
              )
            })}

            {/* 추가 행 */}
            <div className="flex items-end gap-3 mt-2 p-3 bg-gray-50 rounded-lg border">
              <div className="flex-1 space-y-1 min-w-0">
                <Label className="text-xs font-medium text-gray-600">항목명 *</Label>
                <Input className="h-9" placeholder="예: 인스타그램 피드 광고, KOL 홍보"
                  value={newItem.item_name}
                  onChange={(e) => setNewItem({ ...newItem, item_name: e.target.value })} />
              </div>
              <div className="w-36 shrink-0 space-y-1">
                <Label className="text-xs font-medium text-gray-600">상품 연결 (선택사항)</Label>
                <select className="w-full border rounded-md px-2 h-9 text-sm bg-white"
                  value={newItem.product_id}
                  onChange={(e) => {
                    const product = products.find((p) => p.id === e.target.value)
                    setNewItem({
                      ...newItem,
                      product_id: e.target.value,
                      item_name: newItem.item_name || (product ? (product.category ?? product.name) : ''),
                      unit_price_snapshot: product ? String(product.price_vat_incl) : newItem.unit_price_snapshot,
                      unit_cost_snapshot: product ? String(product.current_cost) : newItem.unit_cost_snapshot,
                    })
                  }}>
                  <option value="">직접 입력</option>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.category ?? p.name}</option>)}
                </select>
              </div>
              <div className="w-12 shrink-0 space-y-1">
                <Label className="text-xs font-medium text-gray-600">수량</Label>
                <Input type="number" className="h-9 text-right" value={newItem.quantity}
                  onChange={(e) => setNewItem({ ...newItem, quantity: e.target.value })} />
              </div>
              <div className="w-36 shrink-0 space-y-1">
                <Label className="text-xs font-medium text-gray-600">판매가 (VAT포함)</Label>
                <Input type="number" className="h-9 text-right" placeholder="0" value={newItem.unit_price_snapshot}
                  onChange={(e) => setNewItem({ ...newItem, unit_price_snapshot: e.target.value })} />
              </div>
              <div className="w-36 shrink-0 space-y-1">
                <Label className="text-xs font-medium text-gray-600">실행비 (원가)</Label>
                <Input type="number" className="h-9 text-right" placeholder="0" value={newItem.unit_cost_snapshot}
                  onChange={(e) => setNewItem({ ...newItem, unit_cost_snapshot: e.target.value })} />
              </div>
              <div className="w-16 shrink-0 pb-0.5">
                <Button className="h-9 w-full" onClick={() => {
                  if (!selectedProject) return
                  handleAddItem(selectedProject.id, newItem)
                  setNewItem({ item_name: '', product_id: '', quantity: '1', unit_price_snapshot: '', unit_cost_snapshot: '' })
                }}>
                  <Plus size={14} className="mr-1" />추가
                </Button>
              </div>
            </div>
          </div>

          {/* 요약 패널 */}
          {selectedProject && projectItems.length > 0 && (() => {
            const totalListPrice = projectItems.reduce((s, it) => s + it.unit_price_snapshot * it.quantity, 0)
            const totalCost = projectItems.reduce((s, it) => s + it.unit_cost_snapshot * it.quantity, 0)
            const contractAmount = selectedProject.total_amount
            const discountAmount = totalListPrice - contractAmount
            const discountRate = totalListPrice > 0 ? (discountAmount / totalListPrice) * 100 : 0
            const hasDiscount = Math.abs(discountAmount) > 0.5
            return (
              <div className="px-6 py-3 border-t bg-gray-50 shrink-0 text-sm space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-gray-500">구성 상품 합계 (정가)</span>
                  <span className="font-medium">{formatKRW(totalListPrice)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">실제 계약금액</span>
                  <span className="font-medium">{formatKRW(contractAmount)}</span>
                </div>
                {hasDiscount && (
                  <div className="flex justify-between text-blue-600">
                    <span>
                      {discountAmount > 0 ? '할인' : '추가 청구'}
                      <span className="ml-1 text-xs opacity-75">
                        ({discountAmount > 0 ? '-' : '+'}{Math.abs(discountRate).toFixed(1)}%)
                      </span>
                    </span>
                    <span className="font-semibold">{discountAmount > 0 ? '-' : '+'}{formatKRW(Math.abs(discountAmount))}</span>
                  </div>
                )}
                <div className="flex justify-between border-t pt-1.5">
                  <span className="text-gray-500">총 실행비 (원가 합계)</span>
                  <span className="font-medium text-orange-600">{formatKRW(totalCost)}</span>
                </div>
              </div>
            )
          })()}

          <DialogFooter className="px-6 py-4 border-t shrink-0">
            <Button onClick={() => { setItemsDialogOpen(false); setEditingItemId(null) }}>닫기</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => { if (!v) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>프로젝트 영구 삭제</AlertDialogTitle>
            <AlertDialogDescription>
              이 프로젝트를 완전히 삭제하시겠습니까?<br />
              연결된 구성 상품이 함께 삭제되고, 연결된 결제는 미매칭 상태로 변경됩니다.<br />
              이 작업은 되돌릴 수 없습니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => { if (deleteTarget) handleDelete(deleteTarget) }}
            >
              삭제
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
