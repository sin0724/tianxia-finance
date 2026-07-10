'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { toast } from '@/lib/toast'
import { Pencil } from 'lucide-react'
import type { Representative } from '@/types/database'

export default function SettingsPage() {
  const supabase = createClient()
  const [settings, setSettings] = useState({ vat_rate: '10', corporate_tax_reserve: '10', retained_earnings_reserve: '8' })
  const [reps, setReps] = useState<Representative[]>([])
  const [repForm, setRepForm] = useState({ name: '', email: '', share_ratio: '50' })
  const [saving, setSaving] = useState(false)
  const [editingRepId, setEditingRepId] = useState<string | null>(null)
  const [editRepForm, setEditRepForm] = useState({ name: '', email: '', share_ratio: '' })

  async function load() {
    const { data } = await supabase.from('settings').select('*')
    const map: Record<string, string> = {}
    for (const s of data ?? []) map[s.key] = String(Number(s.value) * 100)
    setSettings({
      vat_rate: map.vat_rate ?? '10',
      corporate_tax_reserve: map.corporate_tax_reserve ?? '10',
      retained_earnings_reserve: map.retained_earnings_reserve ?? '8',
    })

    const { data: repData } = await supabase.from('representatives').select('*').order('created_at')
    setReps(repData ?? [])
  }

  useEffect(() => { load() }, [])

  async function saveSettings() {
    const vat = parseFloat(settings.vat_rate)
    const tax = parseFloat(settings.corporate_tax_reserve)
    const ret = parseFloat(settings.retained_earnings_reserve)
    if ([vat, tax, ret].some(isNaN)) { toast.error('숫자를 올바르게 입력해주세요.'); return }

    setSaving(true)
    const updates = [
      { key: 'vat_rate',                  value: vat / 100 },
      { key: 'corporate_tax_reserve',     value: tax / 100 },
      { key: 'retained_earnings_reserve', value: ret / 100 },
    ]
    for (const u of updates) {
      const { error } = await supabase
        .from('settings')
        .upsert({ key: u.key, value: u.value }, { onConflict: 'key' })
      if (error) { toast.error(`저장 실패: ${error.message}`); setSaving(false); return }
    }
    setSaving(false)
    toast.success('설정이 저장되었습니다. 월별 정산을 재계산하면 새 요율이 반영됩니다.')
  }

  async function saveRep() {
    if (!editingRepId) return
    const ratio = parseFloat(editRepForm.share_ratio)
    if (isNaN(ratio) || ratio <= 0 || ratio > 100) {
      toast.error('분배율은 1~100 사이 숫자여야 합니다.')
      return
    }
    const { error } = await supabase
      .from('representatives')
      .update({ name: editRepForm.name, email: editRepForm.email, share_ratio: ratio })
      .eq('id', editingRepId)
    if (error) { toast.error(error.message); return }
    setEditingRepId(null)
    toast.success('수정되었습니다. 정산을 재계산하면 새 분배율이 반영됩니다.')
    load()
  }

  async function addRep() {
    if (!repForm.name || !repForm.email) { toast.error('이름과 이메일은 필수입니다.'); return }
    const { error } = await supabase.from('representatives').insert({
      name: repForm.name, email: repForm.email, share_ratio: parseFloat(repForm.share_ratio) || 50,
    })
    if (error) { toast.error(error.message); return }
    setRepForm({ name: '', email: '', share_ratio: '50' })
    toast.success('대표자가 등록되었습니다.')
    load()
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold">설정</h1>

      <Card>
        <CardHeader><CardTitle>세율 / 적립율 설정</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label>부가세율 (%)</Label>
            <Input type="number" value={settings.vat_rate} onChange={(e) => setSettings({ ...settings, vat_rate: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>법인세 적립율 (%)</Label>
            <Input type="number" value={settings.corporate_tax_reserve} onChange={(e) => setSettings({ ...settings, corporate_tax_reserve: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>유보금 적립율 (%)</Label>
            <Input type="number" value={settings.retained_earnings_reserve} onChange={(e) => setSettings({ ...settings, retained_earnings_reserve: e.target.value })} />
          </div>
          <Button onClick={saveSettings} disabled={saving}>{saving ? '저장 중...' : '설정 저장'}</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Google Sheets 동기화</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm text-gray-600">
          <p>슬랙 결제 기록이 자동으로 쌓이는 Google 스프레드시트를 연동합니다.</p>
          <div className="rounded-md bg-gray-50 border p-3 space-y-1 text-xs font-mono">
            <div>GOOGLE_SHEETS_CREDENTIALS={"<"}서비스 계정 JSON{">"}</div>
            <div>GOOGLE_SHEETS_ID={"<"}스프레드시트 ID{">"}</div>
            <div>GOOGLE_SHEETS_SHEET_NAME=Sheet1 (기본값)</div>
            <div>CRON_SECRET={"<"}Cron 인증 시크릿{">"}</div>
          </div>
          <p className="text-xs text-gray-400">
            시트 컬럼: A=동기화 ID(자동 기록 — 수정 금지), B=날짜, C=상호명, D=대표자, E=전화번호, F=담당자, G=금액, H=특이사항, I=입금상태
          </p>
          <p className="text-xs text-gray-400">
            동기화 시 A열에 고유 ID가 자동 기록되어, 이후 상호명·금액을 수정해도 중복 집계되지 않습니다.
            (서비스 계정에 시트 <strong>편집</strong> 권한 필요)
          </p>
          <p className="text-xs text-gray-400">
            Cron 자동 동기화: <code className="bg-gray-100 px-1 rounded">POST /api/sync-sheets</code> (Authorization: Bearer CRON_SECRET)
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const res = await fetch('/api/sync-sheets', { method: 'POST' })
              const data = await res.json()
              if (!res.ok) toast.error(data.error)
              else toast.success(`동기화 완료: ${data.synced}건 추가${data.updated > 0 ? `, ${data.updated}건 갱신` : ''}`)
            }}
          >
            지금 동기화 실행
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>대표자 관리</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {reps.map((r) => (
            <div key={r.id} className="border rounded-md p-3">
              {editingRepId === r.id ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label>이름</Label>
                      <Input value={editRepForm.name} onChange={(e) => setEditRepForm({ ...editRepForm, name: e.target.value })} />
                    </div>
                    <div className="space-y-1">
                      <Label>이메일</Label>
                      <Input type="email" value={editRepForm.email} onChange={(e) => setEditRepForm({ ...editRepForm, email: e.target.value })} />
                    </div>
                  </div>
                  <div className="space-y-1 w-32">
                    <Label>분배율 (%)</Label>
                    <Input type="number" min="1" max="100" value={editRepForm.share_ratio}
                      onChange={(e) => setEditRepForm({ ...editRepForm, share_ratio: e.target.value })} />
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={saveRep}>저장</Button>
                    <Button size="sm" variant="outline" onClick={() => setEditingRepId(null)}>취소</Button>
                  </div>
                </div>
              ) : (
                <div className="flex justify-between items-center">
                  <div>
                    <div className="font-medium">{r.name}</div>
                    <div className="text-sm text-gray-500">{r.email} · 분배율 {r.share_ratio}%</div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => {
                    setEditingRepId(r.id)
                    setEditRepForm({ name: r.name, email: r.email, share_ratio: String(r.share_ratio) })
                  }}>
                    <Pencil size={14} />
                  </Button>
                </div>
              )}
            </div>
          ))}
          <div className="border-t pt-4 space-y-3">
            <p className="text-sm font-medium text-gray-700">대표자 추가</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="space-y-1"><Label>이름</Label><Input value={repForm.name} onChange={(e) => setRepForm({ ...repForm, name: e.target.value })} /></div>
              <div className="space-y-1"><Label>이메일</Label><Input type="email" value={repForm.email} onChange={(e) => setRepForm({ ...repForm, email: e.target.value })} /></div>
            </div>
            <div className="space-y-1 w-32"><Label>분배율 (%)</Label><Input type="number" value={repForm.share_ratio} onChange={(e) => setRepForm({ ...repForm, share_ratio: e.target.value })} /></div>
            <Button onClick={addRep}>대표자 추가</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
