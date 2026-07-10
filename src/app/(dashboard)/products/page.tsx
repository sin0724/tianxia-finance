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
import { toast } from '@/lib/toast'
import { CurrencyInput } from '@/components/ui/currency-input'
import { formatKRW } from '@/lib/calculations/settlement'
import { Plus, Pencil, History } from 'lucide-react'
import type { Product, ProductCostHistory } from '@/types/database'

const DEFAULT_CATEGORIES = ['Dcard', 'PTT', 'Threads', 'PR', 'KOC', 'KOL', '인스타브랜딩', '기타']

type ProductStat = { name: string; count: number; revenue: number; cost: number }
type BatchItem = {
  id: string
  item_name: string | null
  project_name: string
  project_status: string
  old_price: number
  old_cost: number
  new_price: number
  new_cost: number
  selected: boolean
}

export default function ProductsPage() {
  const supabase = createClient()
  const [products, setProducts] = useState<Product[]>([])
  const [productStats, setProductStats] = useState<ProductStat[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [costHistory, setCostHistory] = useState<ProductCostHistory[]>([])
  const [editing, setEditing] = useState<Product | null>(null)
  const [form, setForm] = useState({ name: '', price_vat_incl: '', current_cost: '' })
  const [categories, setCategories] = useState<string[]>(DEFAULT_CATEGORIES)
  const [batchDialog, setBatchDialog] = useState(false)
  const [batchItems, setBatchItems] = useState<BatchItem[]>([])

  async function load() {
    const { data } = await supabase
      .from('products')
      .select('*')
      .eq('active', true)
      .order('created_at', { ascending: false })
    setProducts(data ?? [])
    setLoading(false)

    const existing = (data ?? []).map((p) => p.category).filter(Boolean) as string[]
    const merged = [...new Set([...DEFAULT_CATEGORIES, ...existing])]
    setCategories(merged)

    // 상품별 판매 실적 집계
    const { data: itemData } = await supabase
      .from('project_items')
      .select('quantity, unit_price_snapshot, unit_cost_snapshot, products(name, category)')
    type RawItem = { quantity: number; unit_price_snapshot: number; unit_cost_snapshot: number; products: { name: string; category: string | null } | null }
    const statMap: Record<string, { count: number; revenue: number; cost: number }> = {}
    for (const item of (itemData as unknown as RawItem[]) ?? []) {
      const name = item.products?.category ?? item.products?.name ?? '직접 입력'
      if (!statMap[name]) statMap[name] = { count: 0, revenue: 0, cost: 0 }
      statMap[name].count += item.quantity
      statMap[name].revenue += item.unit_price_snapshot * item.quantity
      statMap[name].cost += item.unit_cost_snapshot * item.quantity
    }
    setProductStats(
      Object.entries(statMap)
        .map(([name, s]) => ({ name, ...s }))
        .sort((a, b) => b.revenue - a.revenue)
    )
  }

  useEffect(() => { load() }, [])

  function openAdd() {
    setEditing(null)
    setForm({ name: '', price_vat_incl: '', current_cost: '' })
    setDialogOpen(true)
  }

  function openEdit(p: Product) {
    setEditing(p)
    setForm({
      name: p.category ?? p.name,
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
    const productName = form.name.trim()
    if (!productName || isNaN(price) || isNaN(cost)) {
      toast.error('상품명과 금액을 모두 입력해주세요.')
      return
    }

    if (editing) {
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

      const priceChanged = price !== editing.price_vat_incl
      const costChanged = cost !== editing.current_cost
      if (priceChanged || costChanged) {
        const { data: affectedItems } = await supabase
          .from('project_items')
          .select('id, item_name, unit_price_snapshot, unit_cost_snapshot, project_id')
          .eq('product_id', editing.id)
        if (affectedItems && affectedItems.length > 0) {
          const projectIds = [...new Set(affectedItems.map((r) => r.project_id).filter(Boolean))] as string[]
          const { data: projectsData } = await supabase
            .from('projects')
            .select('id, name, status')
            .in('id', projectIds)
          const projectMap = Object.fromEntries((projectsData ?? []).map((p) => [p.id, p]))
          setBatchItems(affectedItems.map((r) => ({
            id: r.id,
            item_name: r.item_name,
            project_name: projectMap[r.project_id ?? '']?.name ?? '-',
            project_status: projectMap[r.project_id ?? '']?.status ?? '-',
            old_price: r.unit_price_snapshot,
            old_cost: r.unit_cost_snapshot,
            new_price: price,
            new_cost: cost,
            selected: true,
          })))
          setDialogOpen(false)
          setBatchDialog(true)
          load()
          return
        }
      }
    } else {
      const { data, error } = await supabase
        .from('products')
        .insert({ name: productName, category: productName, price_vat_incl: price, current_cost: cost })
        .select()
        .single()
      if (error || !data) { toast.error('추가 실패'); return }
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

  async function handleBatchUpdate() {
    const targets = batchItems.filter((b) => b.selected)
    if (targets.length === 0) { setBatchDialog(false); return }
    for (const t of targets) {
      await supabase.from('project_items').update({
        unit_price_snapshot: t.new_price,
        unit_cost_snapshot: t.new_cost,
      }).eq('id', t.id)
    }
    toast.success(`${targets.length}개 항목의 단가가 업데이트되었습니다.`)
    setBatchDialog(false)
    load()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">상품 관리</h1>
        <Button onClick={openAdd}><Plus size={16} className="mr-1" />상품 추가</Button>
      </div>

      {/* 모바일 카드 뷰 */}
      <div className="md:hidden space-y-2">
        {loading ? (
          <div className="bg-white rounded-lg border text-center py-8 text-gray-400 text-sm">불러오는 중...</div>
        ) : products.length === 0 ? (
          <div className="bg-white rounded-lg border text-center py-8 text-gray-400 text-sm">등록된 상품이 없습니다.</div>
        ) : products.map((p) => {
          const supplyPrice = p.price_vat_incl / 1.1
          const margin = supplyPrice > 0 ? ((supplyPrice - p.current_cost) / supplyPrice * 100).toFixed(1) : '0.0'
          return (
            <div key={p.id} className="bg-white rounded-lg border p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-gray-900">{p.category ?? p.name}</div>
                  <div className="grid grid-cols-3 gap-2 mt-2 text-sm">
                    <div>
                      <div className="text-xs text-gray-400">단가(VAT)</div>
                      <div className="font-medium">{formatKRW(p.price_vat_incl)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-400">원가</div>
                      <div className="font-medium">{formatKRW(p.current_cost)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-400">마진율</div>
                      <div className="font-medium">{margin}%</div>
                    </div>
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button size="sm" variant="ghost" onClick={() => openHistory(p)}><History size={14} /></Button>
                  <Button size="sm" variant="ghost" onClick={() => openEdit(p)}><Pencil size={14} /></Button>
                  <Button size="sm" variant="ghost" className="text-red-500" onClick={() => handleDeactivate(p.id)}>삭제</Button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* 데스크톱 테이블 */}
      <div className="hidden md:block bg-white rounded-lg border overflow-x-auto">
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

      {/* 상품별 판매 실적 */}
      {productStats.length > 0 && (
        <div className="bg-white rounded-lg border overflow-hidden">
          <div className="px-4 py-3 border-b">
            <h2 className="text-sm font-semibold text-gray-700">상품별 판매 실적</h2>
            <p className="text-xs text-gray-400 mt-0.5">프로젝트 구성 상품 기준 전체 누적</p>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>상품명</TableHead>
                <TableHead className="text-right">판매 수량</TableHead>
                <TableHead className="text-right">총 판매액</TableHead>
                <TableHead className="text-right">총 실행비</TableHead>
                <TableHead className="text-right">마진</TableHead>
                <TableHead className="text-right">마진율</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {productStats.map((s) => {
                const margin = s.revenue - s.cost
                const marginRate = s.revenue > 0 ? (margin / s.revenue) * 100 : 0
                return (
                  <TableRow key={s.name}>
                    <TableCell className="font-medium">{s.name}</TableCell>
                    <TableCell className="text-right">{s.count.toLocaleString()}</TableCell>
                    <TableCell className="text-right">{formatKRW(s.revenue)}</TableCell>
                    <TableCell className="text-right text-orange-600">{formatKRW(s.cost)}</TableCell>
                    <TableCell className="text-right text-green-600">{formatKRW(margin)}</TableCell>
                    <TableCell className={`text-right font-semibold ${marginRate >= 40 ? 'text-green-600' : marginRate >= 20 ? 'text-yellow-600' : 'text-red-500'}`}>
                      {marginRate.toFixed(1)}%
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 추가/수정 다이얼로그 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? '상품 수정' : '새 상품 등록'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>상품명 *</Label>
              <Input
                list="product-name-list"
                placeholder="상품명을 입력하거나 목록에서 선택"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                autoFocus
              />
              <datalist id="product-name-list">
                {categories.map((c) => <option key={c} value={c} />)}
              </datalist>
              <p className="text-xs text-gray-400">새 이름을 직접 입력하거나 기존 상품명을 선택할 수 있습니다</p>
            </div>
            <div className="space-y-1">
              <Label>단가(부가세 포함) *</Label>
              <CurrencyInput
                placeholder="0"
                value={form.price_vat_incl}
                onChange={(v) => setForm({ ...form, price_vat_incl: v })}
              />
            </div>
            <div className="space-y-1">
              <Label>현재 원가 *</Label>
              <CurrencyInput
                placeholder="0"
                value={form.current_cost}
                onChange={(v) => setForm({ ...form, current_cost: v })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>취소</Button>
            <Button onClick={handleSave}>{editing ? '수정' : '등록'}</Button>
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

      {/* 기존 프로젝트 단가 일괄 업데이트 다이얼로그 */}
      <Dialog open={batchDialog} onOpenChange={setBatchDialog}>
        <DialogContent className="max-w-2xl max-h-[80dvh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>기존 프로젝트 단가 업데이트</DialogTitle>
            <p className="text-sm text-gray-500 mt-1">
              이 상품이 적용된 프로젝트 항목입니다. 업데이트할 항목을 선택하세요.
            </p>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto">
            <div className="flex items-center gap-2 px-1 py-2 border-b">
              <input
                type="checkbox"
                checked={batchItems.every((b) => b.selected)}
                onChange={(e) => setBatchItems((prev) => prev.map((b) => ({ ...b, selected: e.target.checked })))}
                className="h-4 w-4"
              />
              <span className="text-xs font-medium text-gray-500">전체 선택</span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>프로젝트</TableHead>
                  <TableHead>항목명</TableHead>
                  <TableHead className="text-right">현재 판매가</TableHead>
                  <TableHead className="text-right">새 판매가</TableHead>
                  <TableHead className="text-right">현재 원가</TableHead>
                  <TableHead className="text-right">새 원가</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batchItems.map((b) => (
                  <TableRow key={b.id} className={b.selected ? '' : 'opacity-40'}>
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={b.selected}
                        onChange={(e) => setBatchItems((prev) => prev.map((x) => x.id === b.id ? { ...x, selected: e.target.checked } : x))}
                        className="h-4 w-4"
                      />
                    </TableCell>
                    <TableCell>
                      <div className="font-medium text-sm">{b.project_name}</div>
                      <div className="text-xs text-gray-400">{b.project_status === 'ongoing' ? '진행중' : b.project_status === 'completed' ? '완료' : '취소'}</div>
                    </TableCell>
                    <TableCell className="text-sm">{b.item_name ?? '-'}</TableCell>
                    <TableCell className="text-right text-sm text-gray-400">{formatKRW(b.old_price)}</TableCell>
                    <TableCell className="text-right text-sm font-medium text-blue-600">{formatKRW(b.new_price)}</TableCell>
                    <TableCell className="text-right text-sm text-gray-400">{formatKRW(b.old_cost)}</TableCell>
                    <TableCell className="text-right text-sm font-medium text-orange-600">{formatKRW(b.new_cost)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <DialogFooter className="border-t pt-3">
            <span className="text-xs text-gray-400 mr-auto">{batchItems.filter((b) => b.selected).length}개 선택됨</span>
            <Button variant="outline" onClick={() => setBatchDialog(false)}>건너뛰기</Button>
            <Button onClick={handleBatchUpdate}>선택 항목 업데이트</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
