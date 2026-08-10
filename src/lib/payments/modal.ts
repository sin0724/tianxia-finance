/**
 * `/결제` 모달 정의 — 슬랙 워크플로우 폼과 같은 항목을 받는다.
 *   날짜 · 상호명 · 담당자(선택) · 금액(부가세 포함) · 입금상태 · 특이사항
 */

import type { SlackBlock } from '@/lib/slack'
import type { PaymentStatus } from '@/lib/google-sheets'

export const PAYMENT_MODAL_CALLBACK = 'payment_submit'

/** 모달 블록 ID — 제출값을 꺼낼 때도 같은 상수를 쓴다 */
export const FIELD = {
  date: 'date',
  client: 'client',
  manager: 'manager',
  amount: 'amount',
  status: 'status',
  memo: 'memo',
} as const

/** 모든 입력 요소가 공유하는 action_id */
export const ACTION = 'value'

const STATUS_OPTIONS: PaymentStatus[] = ['입금완료', '잔금처리요망', '미입금', '추가계약']

const plain = (text: string) => ({ type: 'plain_text', text, emoji: true })

const statusOption = (s: PaymentStatus) => ({ text: plain(s), value: s })

/**
 * 담당자 목록이 비어 있으면 static_select 를 만들 수 없으므로 자유 입력으로 대체한다.
 * (직원이 한 명도 등록되지 않은 초기 상태에서도 결제를 못 넣는 일은 없어야 한다)
 */
function managerBlock(managers: string[]): SlackBlock {
  if (managers.length === 0) {
    return {
      type: 'input',
      block_id: FIELD.manager,
      label: plain('담당자'),
      element: {
        type: 'plain_text_input',
        action_id: ACTION,
        placeholder: plain('예) 김팀장'),
      },
    }
  }

  return {
    type: 'input',
    block_id: FIELD.manager,
    label: plain('담당자'),
    element: {
      type: 'static_select',
      action_id: ACTION,
      placeholder: plain('선택'),
      options: managers.map((m) => ({ text: plain(m), value: m })),
    },
  }
}

export function buildPaymentModal(params: {
  today: string
  managers: string[]
  /** 제출 처리 후 결과를 올릴 채널 — 커맨드를 친 곳 */
  channelId: string
  userId: string
}): Record<string, unknown> {
  const { today, managers, channelId, userId } = params

  const blocks: SlackBlock[] = [
    {
      type: 'input',
      block_id: FIELD.date,
      label: plain('날짜'),
      element: { type: 'datepicker', action_id: ACTION, initial_date: today },
    },
    {
      type: 'input',
      block_id: FIELD.client,
      label: plain('상호명'),
      element: {
        type: 'plain_text_input',
        action_id: ACTION,
        placeholder: plain('예) ABC마케팅'),
      },
    },
    managerBlock(managers),
    {
      type: 'input',
      block_id: FIELD.amount,
      label: plain('금액 (부가세 포함)'),
      element: {
        type: 'number_input',
        action_id: ACTION,
        is_decimal_allowed: false,
        min_value: '1',
        placeholder: plain('예) 1500000'),
      },
    },
    {
      type: 'input',
      block_id: FIELD.status,
      label: plain('입금상태'),
      element: {
        type: 'static_select',
        action_id: ACTION,
        initial_option: statusOption('입금완료'),
        options: STATUS_OPTIONS.map(statusOption),
      },
    },
    {
      type: 'input',
      block_id: FIELD.memo,
      optional: true,
      label: plain('특이사항'),
      element: {
        type: 'plain_text_input',
        action_id: ACTION,
        multiline: true,
        placeholder: plain('예) 계약금'),
      },
    },
  ]

  return {
    type: 'modal',
    callback_id: PAYMENT_MODAL_CALLBACK,
    title: plain('결제 등록'),
    submit: plain('등록'),
    close: plain('취소'),
    private_metadata: JSON.stringify({ channelId, userId }),
    blocks,
  }
}

/** 제출된 모달에서 값 꺼내기 */
export function readSubmission(values: Record<string, Record<string, {
  value?: string | null
  selected_date?: string | null
  selected_option?: { value?: string } | null
}>>) {
  const get = (field: string) => values?.[field]?.[ACTION] ?? {}

  const managerField = get(FIELD.manager)

  return {
    date: get(FIELD.date).selected_date ?? '',
    clientName: (get(FIELD.client).value ?? '').trim(),
    // 직원이 없을 땐 자유 입력이라 value 로 들어온다
    manager: (managerField.selected_option?.value ?? managerField.value ?? '').trim(),
    amountRaw: (get(FIELD.amount).value ?? '').trim(),
    status: (get(FIELD.status).selected_option?.value ?? '입금완료') as PaymentStatus,
    memo: (get(FIELD.memo).value ?? '').trim(),
  }
}
