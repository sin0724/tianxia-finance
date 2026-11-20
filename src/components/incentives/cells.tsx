'use client'

import { useRef, useState } from 'react'
import { CurrencyInput } from '@/components/ui/currency-input'
import { comma } from '@/lib/incentives/engine'
import { cn } from '@/lib/utils'

/** 인센티브 정산 화면 공용 — API 호출과 표 안에서 눌러 고치는 칸 */

export async function call<T = { ok: true }>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  })
  const json = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(json.error ?? `요청이 실패했습니다 (${res.status})`)
  return json as T
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 정산시트와 같은 줄 색 */
export const FILL_BG = { red: '#f4cccc', yellow: '#fff2cc', green: '#d9ead3' } as const
/** 손으로 입금액을 적어야 하는 D칸 */
export const INPUT_BG = '#ea9999'

export const won = (n: number | null | undefined) => (n === null || n === undefined ? '' : comma(n))

const cellButton = 'w-full min-h-7 rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-black/5 disabled:hover:bg-transparent disabled:cursor-default'

/** 금액 칸 — 비우면 null (allowBlank일 때). Enter · 포커스 이동으로 저장, Esc로 취소 */
export function MoneyCell({
  value, onSave, disabled, allowBlank = true, placeholder, className, label,
}: {
  value: number | null
  onSave: (next: number | null) => Promise<unknown>
  disabled?: boolean
  allowBlank?: boolean
  placeholder?: string
  className?: string
  label: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const cancelled = useRef(false)

  async function commit() {
    if (cancelled.current) { cancelled.current = false; setEditing(false); return }
    const raw = draft.trim()
    const next = raw === '' || raw === '-' ? null : Number(raw)
    setEditing(false)
    if (next === null && !allowBlank) return
    if (next !== null && !Number.isSafeInteger(next)) return
    if (next === value) return
    await onSave(next)
  }

  if (editing) {
    return (
      <CurrencyInput
        autoFocus
        aria-label={label}
        value={draft}
        onChange={setDraft}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur() }
        }}
        placeholder={placeholder ?? ''}
        className="h-7 bg-white text-sm"
      />
    )
  }
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={() => { setDraft(value === null ? '' : String(value)); setEditing(true) }}
      className={cn(cellButton, 'text-right tabular-nums', className)}
    >
      {value === null ? <span className="text-gray-300">{placeholder ?? ''}</span> : comma(value)}
    </button>
  )
}

/** 글 칸 — multiline이면 여러 줄 (비고) */
export function TextCell({
  value, onSave, disabled, multiline, placeholder, display, className, label,
}: {
  value: string
  onSave: (next: string) => Promise<unknown>
  disabled?: boolean
  multiline?: boolean
  placeholder?: string
  /** 고치지 않을 때 보여 줄 모양 (없으면 value) */
  display?: React.ReactNode
  className?: string
  label: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const cancelled = useRef(false)

  async function commit() {
    if (cancelled.current) { cancelled.current = false; setEditing(false); return }
    setEditing(false)
    if (draft === value) return
    await onSave(draft)
  }
  const keys = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); e.currentTarget.blur() }
    if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur() }
  }

  if (editing) {
    const common = {
      autoFocus: true,
      'aria-label': label,
      value: draft,
      onBlur: commit,
      onKeyDown: keys,
      placeholder,
      className: 'w-full rounded-md border border-blue-300 bg-white px-1.5 py-1 text-sm outline-none ring-2 ring-blue-100',
    }
    return multiline
      ? <textarea {...common} rows={Math.min(8, Math.max(2, Math.ceil(draft.length / 38)))} onChange={(e) => setDraft(e.target.value)} />
      : <input {...common} onChange={(e) => setDraft(e.target.value)} />
  }
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={() => { setDraft(value); setEditing(true) }}
      className={cn(cellButton, multiline && 'whitespace-pre-wrap break-words text-[13px] leading-5', className)}
    >
      {display ?? (value ? value : <span className="text-gray-300">{placeholder ?? ''}</span>)}
    </button>
  )
}

export function ConfirmButton({
  children, onConfirm, confirmText, className, disabled,
}: {
  children: React.ReactNode
  onConfirm: () => void
  confirmText: string
  className?: string
  disabled?: boolean
}) {
  const [asking, setAsking] = useState(false)
  if (asking) {
    return (
      <span className="inline-flex items-center gap-1 text-xs">
        <button type="button" className="rounded-md bg-red-500 px-1.5 py-0.5 font-semibold text-white" onClick={() => { setAsking(false); onConfirm() }}>
          {confirmText}
        </button>
        <button type="button" className="rounded-md px-1.5 py-0.5 text-gray-500 hover:bg-gray-100" onClick={() => setAsking(false)}>취소</button>
      </span>
    )
  }
  return (
    <button type="button" disabled={disabled} className={className} onClick={() => setAsking(true)}>
      {children}
    </button>
  )
}
