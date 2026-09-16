/**
 * `/결제` 모달 정의 — 슬랙 워크플로우 폼과 같은 항목을 받는다.
 *   날짜 · 상호명 · 담당자(선택) · 금액(부가세 포함) · 입금상태 · 특이사항
 */

import type { SlackBlock } from '@/lib/slack'
import type { PaymentStatus } from '@/lib/google-sheets'
import type { RevertStatus, RevertedPayment } from './revert'
import { formatKRW } from './register'

export const PAYMENT_MODAL_CALLBACK = 'payment_submit'

/** 모달 블록 ID — 제출값을 꺼낼 때도 같은 상수를 쓴다 */
export const FIELD = {
  date: 'date',
  client: 'client',
  representative: 'representative',
  phone: 'phone',
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
    // 시트 컬럼 순서(B 날짜 · C 상호명 · D 대표자 · E 전화번호 · F 담당자 · G 금액)를 그대로 따른다
    {
      type: 'input',
      block_id: FIELD.representative,
      optional: true,
      label: plain('대표자'),
      element: {
        type: 'plain_text_input',
        action_id: ACTION,
        placeholder: plain('예) 홍길동'),
      },
    },
    {
      type: 'input',
      block_id: FIELD.phone,
      optional: true,
      label: plain('전화번호'),
      element: {
        type: 'plain_text_input',
        action_id: ACTION,
        placeholder: plain('예) 010-1234-5678'),
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

// ─────────────────────────────────────────────────────────────
// 입금 확정 되돌리기 — 등록 안내 메시지의 버튼 또는 `/결제 취소`
// ─────────────────────────────────────────────────────────────

export const PAYMENT_REVERT_CALLBACK = 'payment_revert'
/** 등록 완료 메시지에 붙는 버튼의 action_id — block_actions 분기 기준 */
export const PAYMENT_REVERT_BUTTON = 'payment_revert_open'

export const REVERT_FIELD = {
  target: 'revert_target',
  status: 'revert_status',
} as const

const REVERT_OPTIONS: { value: RevertStatus; label: string }[] = [
  { value: 'unpaid', label: '🔴 미입금' },
  { value: 'balance_due', label: '⚠️ 잔금 처리 요망' },
]

const revertOption = (o: { value: RevertStatus; label: string }) => ({ text: plain(o.label), value: o.value })

const shortDate = (iso: string) => iso.slice(5).replace('-', '/') // 2026-09-16 → 09/16

/** static_select 옵션 텍스트는 75자 제한 */
function paymentOptionText(p: RevertedPayment): string {
  const base = `${shortDate(p.paymentDate)} ${p.clientName} ${formatKRW(p.amount)}`
  const withManager = p.manager ? `${base} · ${p.manager}` : base
  return withManager.length > 75 ? `${withManager.slice(0, 72)}…` : withManager
}

/** 등록 완료 메시지 아래에 붙는 "되돌리기" 버튼 블록 */
export function revertButtonBlock(paymentId: string): SlackBlock {
  return {
    type: 'actions',
    elements: [{
      type: 'button',
      action_id: PAYMENT_REVERT_BUTTON,
      text: plain('↩️ 입금 상태 되돌리기'),
      value: paymentId,
    }],
  }
}

/**
 * 되돌리기 모달.
 *   - target 이 있으면 (버튼에서 열림) 그 건의 내용을 보여주고 상태만 고른다
 *   - 없으면 (`/결제 취소`) 최근 확정 건 목록에서 고른다
 * 메시지 정보(channel·ts)는 제출 후 원본 안내 메시지를 갱신하는 데 쓴다.
 */
export function buildRevertModal(params: {
  target?: RevertedPayment
  candidates?: RevertedPayment[]
  channelId: string
  userId: string
  messageTs?: string
  messageText?: string
}): Record<string, unknown> {
  const { target, candidates = [], channelId, userId, messageTs, messageText } = params

  // private_metadata 는 3000자 제한 — 등록 메시지 본문은 넉넉히 잘라 넣는다
  const metadata = JSON.stringify({
    channelId, userId, messageTs, paymentId: target?.id,
    messageText: messageText?.slice(0, 1500),
  })

  if (!target && candidates.length === 0) {
    return {
      type: 'modal',
      callback_id: PAYMENT_REVERT_CALLBACK,
      title: plain('입금 되돌리기'),
      close: plain('닫기'),
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: '되돌릴 수 있는 입금완료 건이 없습니다.' },
      }],
    }
  }

  const pickBlock: SlackBlock = target
    ? {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `*${target.clientName}* — *${formatKRW(target.amount)}*`,
            `날짜 ${target.paymentDate}${target.manager ? ` · 담당 ${target.manager}` : ''}`,
            target.projectName ? `프로젝트: ${target.projectName}` : '',
          ].filter(Boolean).join('\n'),
        },
      }
    : (() => {
        const options = candidates.slice(0, 100).map((p) => ({ text: plain(paymentOptionText(p)), value: p.id }))
        return {
          type: 'input',
          block_id: REVERT_FIELD.target,
          label: plain('되돌릴 결제 (최근 등록순)'),
          element: {
            type: 'static_select',
            action_id: ACTION,
            placeholder: plain('선택'),
            options,
          },
        }
      })()

  return {
    type: 'modal',
    callback_id: PAYMENT_REVERT_CALLBACK,
    title: plain('입금 되돌리기'),
    submit: plain('되돌리기'),
    close: plain('취소'),
    private_metadata: metadata,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '입금완료로 잘못 등록된 건을 수금 예정으로 되돌립니다.\n시트 입금상태 · 결제 내역 · 프로젝트 입금액에 함께 반영됩니다.',
        },
      },
      { type: 'divider' },
      pickBlock,
      {
        type: 'input',
        block_id: REVERT_FIELD.status,
        label: plain('바꿀 상태'),
        element: {
          type: 'static_select',
          action_id: ACTION,
          initial_option: revertOption(REVERT_OPTIONS[0]),
          options: REVERT_OPTIONS.map(revertOption),
        },
      },
    ],
  }
}

export function readRevertSubmission(values: Record<string, Record<string, {
  selected_option?: { value?: string } | null
}>>) {
  const get = (field: string) => values?.[field]?.[ACTION] ?? {}
  return {
    paymentId: get(REVERT_FIELD.target).selected_option?.value ?? '',
    status: get(REVERT_FIELD.status).selected_option?.value ?? 'unpaid',
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
    representative: (get(FIELD.representative).value ?? '').trim(),
    phone: (get(FIELD.phone).value ?? '').trim(),
    // 직원이 없을 땐 자유 입력이라 value 로 들어온다
    manager: (managerField.selected_option?.value ?? managerField.value ?? '').trim(),
    amountRaw: (get(FIELD.amount).value ?? '').trim(),
    status: (get(FIELD.status).selected_option?.value ?? '입금완료') as PaymentStatus,
    memo: (get(FIELD.memo).value ?? '').trim(),
  }
}
