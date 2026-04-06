'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { toast } from 'sonner'
import { formatKRW } from '@/lib/calculations/settlement'
import { Plus, Pencil, History, GripVertical } from 'lucide-react'
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Product, ProductCostHistory } from '@/types/database'

const DEFAULT_CATEGORIES = ['Dcard', 'PTT', 'Threads', 'PR', 'KOC', 'KOL', '인스타브랜딩', '기타']

function SortableItem({
  cat, editingCategory, onEdit, onSaveEdit, onCancelEdit, onEditChange, onRemove,
}: {
  cat: string
  editingCategory: { original: string; value: string } | null
  onEdit: (cat: string) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onEditChange: (v: string) => void
  onRemove: (cat: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: cat })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }

  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-2 px-3 py-2 rounded-md border text-sm bg-white">
      <span {...attributes} {...listeners} className="cursor-grab text-gray-300 hover:text-gray-500">
        <GripVertical size={14} />
      </span>
      {editingCategory?.original === cat ? (
        <>
          <Input
            className="h-7 text-sm flex-1"
            value={editingCategory.value}
            onChange={(e) => onEditChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSaveEdit() }}
            autoFocus
          />
          <button onClick={onSaveEdit} className="text-blue-500 hover:text-blue-700 text-xs font-medium">저장</button>
          <button onClick={onCancelEdit} className="text-gray-400 hover:text-gray-600 text-xs">취소</button>
        </>
      ) : (
        <>
          <span className="flex-1">{cat}</span>
          <button onClick={() => onEdit(cat)} className="text-gray-400 hover:text-gray-700 text-xs">수정</button>
          <button onClick={() => onRemove(cat)} className="text-red-400 hover:text-red-600 text-xs">삭제</button>
        </>
      )}
    </div>
  )
}

export default function ProductsPage() {
  const supabase = createClient()
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false)
  const [costHistory, setCostHistory] = useState<ProductCostHistory[]>([])
  const [editing, setEditing] = useState<Product | null>(null)
  const [form, setForm] = useState({ name: '', category: '', price_vat_incl: '', current_cost: '' })
  const [categories, setCategories] = useState<string[]>(DEFAULT_CATEGORIES)
  const [newCategory, setNewCategory] = useState('')
  const [editingCategory, setEditingCategory] = useState<{ original: string; value: string } | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (over && active.id !== over.id) {
      setCategories((prev) => arrayMove(prev, prev.indexOf(String(active.id)), prev.indexOf(String(over.id))))
    }
  }

  async function load() {
    const { data } = await supabase
      .from('products')
      .select('*')
      .eq('active', true)
      .order('created_at', { ascending: false })
    setProducts(data ?? [])
    setLoading(false)

    // 기존 상품에서 커스텀 카테고리 추출
    const existing = (data ?? []).map((p) => p.category).filter(Boolean) as string[]
    const merged = [...new Set([...DEFAULT_CATEGORIES, ...existing])]
    setCategories(merged)
  }

  useEffect(() => { load() }, [])

  function addCategory() {
    const trimmed = newCategory.trim()
    if (!trimmed) return
    if (categories.includes(trimmed)) { toast.error('이미 존재하는 상품명입니다.'); return }
    setCategories([...categories, trimmed])
    setNewCategory('')
    toast.success(`"${trimmed}" 추가됨`)
  }

  function removeCategory(cat: string) {
    setCategories(categories.filter((c) => c !== cat))
  }

  function saveEditCategory() {
    if (!editingCategory) return
    const trimmed = editingCategory.value.trim()
    if (!trimmed) return
    if (trimmed !== editingCategory.original && categories.includes(trimmed)) {
      toast.error('이미 존재하는 상품명입니다.')
      return
    }
    setCategories(categories.map((c) => c === editingCategory.original ? trimmed : c))
    setEditingCategory(null)
  }

  function openAdd() {
    setEditing(null)
    setForm({ name: '', category: '', price_vat_incl: '', current_cost: '' })
    setDialogOpen(true)
  }

  function openEdit(p: Product) {
    setEditing(p)
    setForm({
      name: p.category ?? p.name,
      category: p.category ?? '',
      price_vat_incl: String(p.price_vat_incl),
      current_cost: String(p.current_cost),
    })
    setDialogOpen(true)
  }

  async function openHistory(p: Product) {
    const { data } = await supabase
      .from('product_cost_history')
      .select('*')
      .eq('product_id', p.id)
      .order('effective_from', { ascending: false })
    setCostHistory(data ?? [])
    setHistoryOpen(true)
  }

  async function handleSave() {
    const price = parseFloat(form.price_vat_incl)
    const cost = parseFloat(form.current_cost)
    const productName = form.category  // 카테고리가 곧 상품명
    if (!productName || isNaN(price) || isNaN(cost)) {
      toast.error('상품명(카테고리)과 금액을 입력해주세요.')
      return
    }

    if (editing) {
      // 원가 변경 시 이력 기록
      if (cost !== editing.current_cost) {
        await supabase.from('product_cost_history').insert({
          product_id: editing.id,
          cost,
          effective_from: new Date().toISOString().split('T')[0],
          note: '수동 변경',
        })
      }
      const { error } = await supabase
        .from('products')
        .update({ name: productName, category: productName, price_vat_incl: price, current_cost: cost })
        .eq('id', editing.id)
      if (error) { toast.error('수정 실패'); return }
      toast.success('상품이 수정되었습니다.')
    } else {
      const { data, error } = await supabase
        .from('products')
        .insert({ name: productName, category: productName, price_vat_incl: price, current_cost: cost })
        .select()
        .single()
      if (error || !data) { toast.error('추가 실패'); return }
      // 최초 원가 이력 기록
      await supabase.from('product_cost_history').insert({
        product_id: data.id,
        cost,
        effective_from: new Date().toISOString().split('T')[0],
        note: '최초 등록',
      })
      toast.success('상품이 추가되었습니다.')
    }

    setDialogOpen(false)
    load()
  }

  async function handleDeactivate(id: string) {
    await supabase.from('products').update({ active: false }).eq('id', id)
    toast.success('상품이 비활성화되었습니다.')
    load()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">상품 관리</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setCategoryDialogOpen(true)}>상품명 관리</Button>
          <Button onClick={openAdd}><Plus size={16} className="mr-1" />상품 추가</Button>
        </div>
      </div>

      <div className="bg-white rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>상품명</TableHead>
              <TableHead className="text-right">단가(VAT포함)</TableHead>
              <TableHead className="text-right">현재 원가</TableHead>
              <TableHead className="text-right">마진율</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8 text-gray-400">불러오는 중...</TableCell></TableRow>
            ) : products.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8 text-gray-400">등록된 상품이 없습니다.</TableCell></TableRow>
            ) : products.map((p) => {
              const supplyPrice = p.price_vat_incl / 1.1
              const margin = supplyPrice > 0 ? ((supplyPrice - p.current_cost) / supplyPrice * 100).toFixed(1) : '0.0'
              return (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.category ?? p.name}</TableCell>
                  <TableCell className="text-right">{formatKRW(p.price_vat_incl)}</TableCell>
                  <TableCell className="text-right">{formatKRW(p.current_cost)}</TableCell>
                  <TableCell className="text-right">{margin}%</TableCell>
                  <TableCell>
                    <div className="flex gap-1 justify-end">
                      <Button size="sm" variant="ghost" onClick={() => openHistory(p)}><History size={14} /></Button>
                      <Button size="sm" variant="ghost" onClick={() => openEdit(p)}><Pencil size={14} /></Button>
                      <Button size="sm" variant="ghost" className="text-red-500" onClick={() => handleDeactivate(p.id)}>삭제</Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      {/* 추가/수정 다이얼로그 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? '상품 수정' : '상품 추가'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>상품명 *</Label>
              <select
                className="w-full border rounded-md px-3 py-2 text-sm"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value, name: e.target.value })}
              >
                <option value="">선택하세요</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label>단가(부가세 포함) *</Label>
              <Input type="number" value={form.price_vat_incl} onChange={(e) => setForm({ ...form, price_vat_incl: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>현재 원가 *</Label>
              <Input type="number" value={form.current_cost} onChange={(e) => setForm({ ...form, current_cost: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>취소</Button>
            <Button onClick={handleSave}>저장</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 원가 이력 다이얼로그 */}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>원가 변경 이력</DialogTitle></DialogHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>적용일</TableHead>
                <TableHead className="text-right">원가</TableHead>
                <TableHead>비고</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {costHistory.length === 0 ? (
                <TableRow><TableCell colSpan={3} className="text-center py-4 text-gray-400">이력 없음</TableCell></TableRow>
              ) : costHistory.map((h) => (
                <TableRow key={h.id}>
                  <TableCell>{h.effective_from}</TableCell>
                  <TableCell className="text-right">{formatKRW(h.cost)}</TableCell>
                  <TableCell>{h.note ?? '-'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DialogContent>
      </Dialog>

      {/* 상품명 관리 다이얼로그 */}
      <Dialog open={categoryDialogOpen} onOpenChange={setCategoryDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>상품명 관리</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="flex gap-2">
              <Input
                placeholder="새 상품명 입력"
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addCategory() }}
              />
              <Button onClick={addCategory}><Plus size={14} /></Button>
            </div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={categories} strategy={verticalListSortingStrategy}>
                <div className="space-y-1 max-h-64 overflow-y-auto">
                  {categories.map((cat) => (
                    <SortableItem
                      key={cat}
                      cat={cat}
                      editingCategory={editingCategory}
                      onEdit={(c) => setEditingCategory({ original: c, value: c })}
                      onSaveEdit={saveEditCategory}
                      onCancelEdit={() => setEditingCategory(null)}
                      onEditChange={(v) => setEditingCategory((prev) => prev ? { ...prev, value: v } : null)}
                      onRemove={removeCategory}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </div>
          <DialogFooter>
            <Button onClick={() => setCategoryDialogOpen(false)}>닫기</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
