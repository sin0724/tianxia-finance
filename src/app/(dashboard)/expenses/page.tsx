'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { toast } from '@/lib/toast'
import { Copy, Plus, Pencil, Trash2, Check, RefreshCw } from 'lucide-react'
import { formatKRW } from '@/lib/calculations/settlement'
import { CurrencyInput } from '@/components/ui/currency-input'
import { useMonth } from '@/components/shared/month-context'
import { MonthNavigator } from '@/components/shared/month-navigator'
import type { ExpenseCategory } from '@/types/database'

const TYPE_LABEL: Record<string, string> = { fixed: '고정비', variable: '변동비', special: '특수비용' }
const TYPE_COLOR: Record<string, string> = {
  fixed: 'border-blue-200 bg-blue-50/40',
  variable: 'border-green-200 bg-green-50/40',
  special: 'border-yellow-200 bg-yellow-50/40',
}

type ExpenseItem = {
  id: string
  category_id: string | null
  item_name: string | null
  parent_type: string | null
  amount: number
  memo: string | null
  created_at: string
}

export default function ExpensesPage() {
  const supabase = createClient()
  const { year, month } = useMonth()

  const [items, setItems]     = useState<ExpenseItem[]>([])
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [memos, setMemos]     = useState<Record<string, string>>({})
  const [savingId, setSavingId] = useState<string | null>(null)

  // 항목 추가 다이얼로그
  const [addOpen, setAddOpen]           = useState(false)
  const [addType, setAddType]           = useState<'fixed' | 'variable' | 'special'>('fixed')
  const [addMode, setAddMode]           = useState<'template' | 'custom'>('template')
  const [categories, setCategories]     = useState<ExpenseCategory[]>([])
  const [selectedCatIds, setSelectedCatIds] = useState<Set<string>>(new Set())
  const [customName, setCustomName]     = useState('')
  const [adding, setAdding]             = useState(false)

  // 항목명 수정 다이얼로그
  const [editOpen, setEditOpen]   = useState(false)
  const [editItem, setEditItem]   = useState<ExpenseItem | null>(null)
  const [editName, setEditName]   = useState('')

  // 지난달 복사 다이얼로그
  const [copyOpen, setCopyOpen]           = useState(false)
  const [copyTypes, setCopyTypes]         = useState<Set<'fixed' | 'variable' | 'special'>>(new Set(['fixed']))
  const [copyWithAmount, setCopyWithAmount] = useState(true)
  const [copying, setCopying]             = useState(false)

  async function load() {
    const { data } = await supabase
      .from('monthly_expenses')
      .select('*')
      .eq('year', year)
      .eq('month', month)
      .order('created_at')
    const list = (data ?? []) as ExpenseItem[]
    setItems(list)
    setAmounts(Object.fromEntries(list.map(e => [e.id, e.amount > 0 ? String(e.amount) : ''])))
    setMemos(Object.fromEntries(list.map(e => [e.id, e.memo ?? ''])))
  }

  useEffect(() => { load() }, [year, month])

  // ── 개별 저장 ────────────────────────────────────────────
  async function saveSingle(item: ExpenseItem) {
    const amount = parseFloat(amounts[item.id] ?? '0') || 0
    setSavingId(item.id)
    await supabase.from('monthly_expenses')
      .update({ amount, memo: memos[item.id] || null })
      .eq('id', item.id)
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, amount } : i))
    setSavingId(null)
    toast.success('저장되었습니다.')
  }

  // ── 전체 저장 ────────────────────────────────────────────
  async function saveAll() {
    setSavingId('all')
    for (const item of items) {
      const amount = parseFloat(amounts[item.id] ?? '0') || 0
      await supabase.from('monthly_expenses')
        .update({ amount, memo: memos[item.id] || null })
        .eq('id', item.id)
    }
    setItems(prev => prev.map(i => ({ ...i, amount: parseFloat(amounts[i.id] ?? '0') || 0 })))
    setSavingId(null)
    toast.success('전체 저장되었습니다.')
  }

  // ── 항목 삭제 ────────────────────────────────────────────
  async function deleteItem(item: ExpenseItem) {
    await supabase.from('monthly_expenses').delete().eq('id', item.id)
    setItems(prev => prev.filter(i => i.id !== item.id))
    setAmounts(prev => { const n = { ...prev }; delete n[item.id]; return n })
    setMemos(prev => { const n = { ...prev }; delete n[item.id]; return n })
    toast.success('항목이 삭제되었습니다.')
  }

  // ── 항목 추가 다이얼로그 열기 ────────────────────────────
  function openAdd(type: 'fixed' | 'variable' | 'special') {
    setAddType(type)
    setAddMode('template')
    setSelectedCatIds(new Set())
    setCustomName('')
    setAddOpen(true)
    supabase
      .from('expense_categories')
      .select('*')
      .eq('active', true)
      .eq('parent_type', type)
      .order('created_at')
      .then(({ data }) => setCategories(data ?? []))
  }

  // ── 항목 추가 확정 ───────────────────────────────────────
  async function confirmAdd() {
    const existingCatIds = new Set(items.filter(i => i.category_id).map(i => i.category_id))
    const selectedCats = categories.filter(c => selectedCatIds.has(c.id) && !existingCatIds.has(c.id))

    type InsertRow = { year: number; month: number; category_id: string | null; item_name: string; parent_type: string; amount: number; memo: null }
    const toInsert: InsertRow[] = selectedCats.map(c => ({
      year, month,
      category_id: c.id,
      item_name: c.name,
      parent_type: c.parent_type,
      amount: 0,
      memo: null,
    }))

    if (addMode === 'custom' && customName.trim()) {
      toInsert.push({ year, month, category_id: null, item_name: customName.trim(), parent_type: addType, amount: 0, memo: null })
    }

    if (toInsert.length === 0) { toast.error('추가할 항목을 선택해주세요.'); return }

    setAdding(true)
    const { error } = await supabase.from('monthly_expenses').insert(toInsert)
    setAdding(false)
    if (error) { toast.error('추가 실패: ' + error.message); return }
    setAddOpen(false)
    toast.success(`${toInsert.length}개 항목이 추가되었습니다.`)
    load()
  }

  // ── 항목명 수정 다이얼로그 ───────────────────────────────
  function openEdit(item: ExpenseItem) {
    setEditItem(item)
    setEditName(item.item_name ?? '')
    setEditOpen(true)
  }

  async function saveEdit() {
    if (!editItem || !editName.trim()) { toast.error('항목명을 입력해주세요.'); return }
    await supabase.from('monthly_expenses')
      .update({ item_name: editName.trim() })
      .eq('id', editItem.id)
    setItems(prev => prev.map(i => i.id === editItem.id ? { ...i, item_name: editName.trim() } : i))
    setEditOpen(false)
    toast.success('항목명이 수정되었습니다.')
  }

  // ── 지난달 항목 복사 ─────────────────────────────────────
  function openCopy() {
    setCopyTypes(new Set(['fixed']))
    setCopyWithAmount(true)
    setCopyOpen(true)
  }

  async function confirmCopy() {
    if (copyTypes.size === 0) { toast.error('복사할 지출 종류를 선택해주세요.'); return }

    const ly = month === 1 ? year - 1 : year
    const lm = month === 1 ? 12 : month - 1

    setCopying(true)
    const { data: lastItems } = await supabase
      .from('monthly_expenses')
      .select('*')
      .eq('year', ly)
      .eq('month', lm)

    const existingCatIds = new Set(items.filter(i => i.category_id).map(i => i.category_id))
    const existingNames = new Set(items.filter(i => !i.category_id).map(i => `${i.parent_type}:${i.item_name}`))

    const toInsert = (lastItems ?? [])
      .filter(e => {
        if (!copyTypes.has((e.parent_type ?? 'fixed') as 'fixed' | 'variable' | 'special')) return false
        if (e.category_id) return !existingCatIds.has(e.category_id)
        return !existingNames.has(`${e.parent_type}:${e.item_name}`)
      })
      .map(e => ({
        year, month,
        category_id: e.category_id,
        item_name: e.item_name,
        parent_type: e.parent_type,
        amount: copyWithAmount ? e.amount : 0,
        memo: null,
      }))

    if (toInsert.length === 0) {
      setCopying(false)
      toast.info('복사할 항목이 없습니다. (이미 등록된 항목은 제외됩니다)')
      return
    }
    const { error } = await supabase.from('monthly_expenses').insert(toInsert)
    setCopying(false)
    if (error) { toast.error('복사 실패: ' + error.message); return }
    setCopyOpen(false)
    toast.success(`지난달 항목 ${toInsert.length}개가 복사되었습니다.`)
    load()
  }

  const grouped = items.reduce<Record<string, ExpenseItem[]>>((acc, item) => {
    const type = item.parent_type ?? 'fixed'
    if (!acc[type]) acc[type] = []
    acc[type].push(item)
    return acc
  }, {})

  const total = items.reduce((sum, i) => sum + (parseFloat(amounts[i.id] ?? '0') || 0), 0)

  // 추가 다이얼로그: 이미 이번 달에 등록된 카테고리 제외
  const existingCatIds = new Set(items.filter(i => i.category_id).map(i => i.category_id))
  const availableCats = categories.filter(c => !existingCatIds.has(c.id))

  return (
    <div className="space-y-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">월별 지출 입력</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <MonthNavigator />
          <Button variant="outline" size="sm" onClick={openCopy}>
            <Copy size={14} className="mr-1" />지난달 복사
          </Button>
        </div>
      </div>

      {/* 섹션별 지출 입력 */}
      {(['fixed', 'variable', 'special'] as const).map(type => {
        const sectionItems = grouped[type] ?? []
        const sectionTotal = sectionItems.reduce((s, i) => s + (parseFloat(amounts[i.id] ?? '0') || 0), 0)

        return (
          <Card key={type} className={`border ${TYPE_COLOR[type]}`}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-base">{TYPE_LABEL[type]}</CardTitle>
                  <span className="text-xs text-gray-500">{formatKRW(sectionTotal)}</span>
                </div>
                <Button size="sm" variant="ghost" className="text-gray-500 hover:text-gray-900 h-7 text-xs"
                  onClick={() => openAdd(type)}>
                  <Plus size={13} className="mr-1" />항목 추가
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {sectionItems.length === 0 && (
                <p className="text-xs text-gray-400 py-2">항목이 없습니다. "+ 항목 추가"를 눌러 추가하세요.</p>
              )}

              {sectionItems.map(item => {
                const savedAmt = item.amount
                const currentAmt = parseFloat(amounts[item.id] ?? '0') || 0
                const isSaved = savedAmt > 0 && currentAmt === savedAmt

                return (
                  <div key={item.id} className="flex flex-col sm:flex-row sm:items-center gap-2">
                    {/* 항목명 */}
                    <div className="flex items-center justify-between sm:justify-start gap-1">
                      <div className="flex-1 sm:w-36 sm:flex-none text-sm font-medium text-gray-800 truncate">
                        {item.item_name ?? '(항목명 없음)'}
                      </div>
                      <div className="flex sm:hidden gap-1">
                        <button onClick={() => openEdit(item)} className="text-gray-300 hover:text-gray-600 transition-colors" title="항목명 수정">
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => deleteItem(item)} className="text-gray-300 hover:text-red-500 transition-colors" title="이번 달 항목 삭제">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>

                    {/* 금액 + 메모 + 저장 */}
                    <div className="flex items-center gap-2 flex-1">
                      <CurrencyInput
                        className="w-28 sm:w-36 h-8 text-sm bg-white shrink-0"
                        placeholder="0"
                        value={amounts[item.id] ?? ''}
                        onChange={v => setAmounts(prev => ({ ...prev, [item.id]: v }))}
                        onKeyDown={e => { if (e.key === 'Enter') saveSingle(item) }}
                      />
                      <Input
                        className="flex-1 min-w-0 h-8 text-sm bg-white"
                        placeholder="메모 (선택)"
                        value={memos[item.id] ?? ''}
                        onChange={e => setMemos(prev => ({ ...prev, [item.id]: e.target.value }))}
                        onKeyDown={e => { if (e.key === 'Enter') saveSingle(item) }}
                      />
                      <Button
                        size="sm"
                        variant={isSaved ? 'outline' : 'default'}
                        className="h-8 w-14 text-xs shrink-0"
                        onClick={() => saveSingle(item)}
                        disabled={savingId === item.id}
                      >
                        {savingId === item.id
                          ? <RefreshCw size={12} className="animate-spin" />
                          : isSaved ? <><Check size={11} className="mr-0.5" />저장</> : '저장'}
                      </Button>
                    </div>

                    {/* 수정/삭제 - 데스크톱 */}
                    <div className="hidden sm:flex gap-1">
                      <button onClick={() => openEdit(item)} className="text-gray-300 hover:text-gray-600 transition-colors" title="항목명 수정">
                        <Pencil size={14} />
                      </button>
                      <button onClick={() => deleteItem(item)} className="text-gray-300 hover:text-red-500 transition-colors" title="이번 달 항목 삭제">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </CardContent>
          </Card>
        )
      })}

      {/* 하단 합계 + 전체 저장 */}
      <div className="flex items-center justify-between bg-white rounded-lg border p-4">
        <div className="text-sm text-gray-500">
          {year}년 {month}월 총 지출:{' '}
          <span className="font-bold text-gray-900 text-base">{formatKRW(total)}</span>
        </div>
        <Button onClick={saveAll} disabled={savingId === 'all'}>
          {savingId === 'all' ? '저장 중...' : '전체 저장'}
        </Button>
      </div>

      {/* 지난달 복사 다이얼로그 */}
      <Dialog open={copyOpen} onOpenChange={setCopyOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>지난달 항목 복사</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label>복사할 지출 종류</Label>
              <div className="space-y-1">
                {(['fixed', 'variable', 'special'] as const).map(type => (
                  <label key={type} className="flex items-center gap-2 cursor-pointer py-1 px-2 rounded hover:bg-gray-50">
                    <input
                      type="checkbox"
                      checked={copyTypes.has(type)}
                      onChange={e => {
                        const next = new Set(copyTypes)
                        e.target.checked ? next.add(type) : next.delete(type)
                        setCopyTypes(next)
                      }}
                    />
                    <span className="text-sm">{TYPE_LABEL[type]}</span>
                  </label>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-2 cursor-pointer py-1 px-2 rounded hover:bg-gray-50 border-t pt-3">
              <input
                type="checkbox"
                checked={copyWithAmount}
                onChange={e => setCopyWithAmount(e.target.checked)}
              />
              <span className="text-sm">금액도 함께 복사</span>
            </label>
            <p className="text-xs text-gray-400">이번 달에 이미 등록된 항목은 제외하고 복사합니다.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCopyOpen(false)}>취소</Button>
            <Button onClick={confirmCopy} disabled={copying}>{copying ? '복사 중...' : '복사'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 항목 추가 다이얼로그 */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{TYPE_LABEL[addType]} 항목 추가</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {/* 모드 토글 */}
            <div className="flex gap-2">
              {(['template', 'custom'] as const).map(mode => (
                <button
                  key={mode}
                  className={`flex-1 py-1.5 text-xs rounded-md border transition-colors ${
                    addMode === mode
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                  onClick={() => setAddMode(mode)}
                >
                  {mode === 'template' ? '기본 항목에서 선택' : '직접 입력'}
                </button>
              ))}
            </div>

            {addMode === 'template' && (
              <div className="space-y-1 max-h-52 overflow-y-auto">
                {availableCats.length === 0 ? (
                  <p className="text-xs text-gray-400 py-3 text-center">추가 가능한 기본 항목이 없습니다.</p>
                ) : availableCats.map(cat => (
                  <label key={cat.id} className="flex items-center gap-2 cursor-pointer py-1 px-2 rounded hover:bg-gray-50">
                    <input
                      type="checkbox"
                      checked={selectedCatIds.has(cat.id)}
                      onChange={e => {
                        const next = new Set(selectedCatIds)
                        e.target.checked ? next.add(cat.id) : next.delete(cat.id)
                        setSelectedCatIds(next)
                      }}
                    />
                    <span className="text-sm">{cat.name}</span>
                    {cat.is_recurring && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">반복</span>
                    )}
                  </label>
                ))}
              </div>
            )}

            {addMode === 'custom' && (
              <div className="space-y-1">
                <Label>항목명 *</Label>
                <Input
                  value={customName}
                  onChange={e => setCustomName(e.target.value)}
                  placeholder="항목명 입력"
                  onKeyDown={e => { if (e.key === 'Enter') confirmAdd() }}
                  autoFocus
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>취소</Button>
            <Button onClick={confirmAdd} disabled={adding}>추가</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 항목명 수정 다이얼로그 */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>항목명 수정</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label>항목명 *</Label>
              <Input
                value={editName}
                onChange={e => setEditName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveEdit() }}
                autoFocus
              />
            </div>
            <p className="text-xs text-gray-400">이번 달 표기만 변경되며 다른 월에는 영향이 없습니다.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>취소</Button>
            <Button onClick={saveEdit}>저장</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
