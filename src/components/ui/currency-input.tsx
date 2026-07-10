'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'

interface CurrencyInputProps extends Omit<React.ComponentProps<'input'>, 'value' | 'onChange' | 'type'> {
  /** 숫자 문자열 (예: "1500000", "-30000"). 빈 문자열 허용 */
  value: string
  /** 파싱된 숫자 문자열을 돌려준다 (콤마 없이) */
  onChange: (value: string) => void
}

/**
 * 천 단위 콤마가 표시되는 금액 입력.
 * 내부 값은 콤마 없는 숫자 문자열로 유지되어 기존 parseFloat 로직과 호환된다.
 */
export function CurrencyInput({ value, onChange, className, ...props }: CurrencyInputProps) {
  const display = React.useMemo(() => {
    if (value === '' || value === '-') return value
    const n = Number(value)
    if (isNaN(n)) return value
    return n.toLocaleString('ko-KR')
  }, [value])

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    // 콤마·공백 제거, 숫자와 선행 마이너스만 허용
    const raw = e.target.value.replace(/[,\s]/g, '')
    if (raw === '' || raw === '-') { onChange(raw); return }
    if (!/^-?\d*$/.test(raw)) return
    onChange(raw)
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      data-slot="input"
      value={display}
      onChange={handleChange}
      placeholder={props.placeholder ?? '0'}
      className={cn(
        'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none',
        'text-right tabular-nums',
        'placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 md:text-sm',
        className
      )}
      {...props}
    />
  )
}
