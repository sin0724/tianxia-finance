/**
 * `/연차` 모달 — 신청과 취소.
 * 텍스트 커맨드(`/연차 12/25`)도 그대로 동작하며, 둘 다 applyForLeave() 를 거친다.
 */

import type { SlackBlock } from '@/lib/slack'
import type { LeaveType } from './calc'
import { formatRange } from './calc'
import { LEAVE_TYPE_LABEL } from './policy'
import type { LeaveBalance } from './balance'

export const LEAVE_MODAL_CALLBACK = 'leave_submit'
export const LEAVE_CANCEL_CALLBACK = 'leave_cancel'

export const LEAVE_FIELD = {
  type: 'leave_type',
  start: 'start_date',
  end: 'end_date',
  reason: 'reason',
  target: 'target',
} as const

export const ACTION = 'value'

const plain = (text: string) => ({ type: 'plain_text', text, emoji: true })

/** 신청 가능한 휴가 종류 — 반차는 오전/오후를 따로 고른다 */
const TYPE_OPTIONS: LeaveType[] = ['annual', 'half_am', 'half_pm', 'sick', 'unpaid', 'special']
/** 아르바이트는 연차가 없으므로 차감되지 않는 휴가만 고를 수 있다 */
const PART_TIME_TYPE_OPTIONS: LeaveType[] = ['unpaid', 'sick', 'special']

const typeOption = (t: LeaveType) => ({ text: plain(LEAVE_TYPE_LABEL[t]), value: t })

/** 잔여 연차를 모달 맨 위에 보여준다 — 신청 전에 확인하려 커맨드를 두 번 치지 않게 */
function balanceHeader(balance: LeaveBalance): SlackBlock[] {
  if (!balance.eligible) {
    return [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '아르바이트는 연차가 발생하지 않습니다. 무급휴가·병가·특별휴가만 신청할 수 있습니다.' },
      },
      { type: 'divider' },
    ]
  }
  if (!balance.period) {
    return [{
      type: 'section',
      text: { type: 'mrkdwn', text: '⚠️ *입사일이 등록되어 있지 않습니다.* 관리자에게 문의해주세요.' },
    }]
  }

  const lines = [
    `*남은 연차 ${balance.remaining}일* — 발생 ${balance.total}일 · 사용 ${balance.used}일` +
      (balance.pending > 0 ? ` · 승인대기 ${balance.pending}일` : ''),
  ]
  if (balance.nextAccrualAt) lines.push(`다음 연차 발생: ${balance.nextAccrualAt} (그달 개근 시 +1일)`)
  if (balance.expiresAt && balance.remaining > 0) lines.push(`미사용 연차는 ${balance.expiresAt}에 소멸됩니다.`)

  return [
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    { type: 'divider' },
  ]
}

export function buildLeaveModal(params: {
  balance: LeaveBalance
  today: string
  channelId: string
  userId: string
}): Record<string, unknown> {
  const { balance, today, channelId, userId } = params
  const typeOptions = balance.eligible ? TYPE_OPTIONS : PART_TIME_TYPE_OPTIONS

  return {
    type: 'modal',
    callback_id: LEAVE_MODAL_CALLBACK,
    title: plain('연차 신청'),
    submit: plain('신청'),
    close: plain('닫기'),
    private_metadata: JSON.stringify({ channelId, userId }),
    blocks: [
      ...balanceHeader(balance),
      {
        type: 'input',
        block_id: LEAVE_FIELD.type,
        label: plain('휴가 종류'),
        element: {
          type: 'static_select',
          action_id: ACTION,
          initial_option: typeOption(typeOptions[0]),
          options: typeOptions.map(typeOption),
        },
      },
      {
        type: 'input',
        block_id: LEAVE_FIELD.start,
        label: plain('시작일'),
        element: { type: 'datepicker', action_id: ACTION, initial_date: today },
      },
      {
        type: 'input',
        block_id: LEAVE_FIELD.end,
        optional: true,
        label: plain('종료일'),
        hint: plain('하루만 쉬거나 반차면 비워두세요. 주말·공휴일은 자동으로 빠집니다.'),
        element: { type: 'datepicker', action_id: ACTION },
      },
      {
        type: 'input',
        block_id: LEAVE_FIELD.reason,
        optional: true,
        label: plain('사유'),
        element: {
          type: 'plain_text_input',
          action_id: ACTION,
          placeholder: plain('예) 가족여행'),
        },
      },
    ],
  }
}

export type CancellableRequest = {
  id: string
  leave_type: string
  start_date: string
  end_date: string
  days: number
  status: string
}

/** 취소할 신청을 고르는 모달. 취소할 게 없으면 안내만 띄운다. */
export function buildLeaveCancelModal(params: {
  requests: CancellableRequest[]
  channelId: string
  userId: string
}): Record<string, unknown> {
  const { requests, channelId, userId } = params

  if (requests.length === 0) {
    return {
      type: 'modal',
      callback_id: LEAVE_CANCEL_CALLBACK,
      title: plain('연차 취소'),
      close: plain('닫기'),
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: '취소할 수 있는 휴가가 없습니다.\n\n_이미 지난 승인 건은 관리자에게 요청해주세요._' },
      }],
    }
  }

  const options = requests.slice(0, 100).map((r) => ({
    text: plain(
      `${formatRange(r.start_date, r.end_date)} ${LEAVE_TYPE_LABEL[r.leave_type] ?? ''} ${r.days}일` +
      ` (${r.status === 'approved' ? '승인됨' : '대기중'})`,
    ),
    value: r.id,
  }))

  return {
    type: 'modal',
    callback_id: LEAVE_CANCEL_CALLBACK,
    title: plain('연차 취소'),
    submit: plain('취소하기'),
    close: plain('닫기'),
    private_metadata: JSON.stringify({ channelId, userId }),
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '취소할 휴가를 선택해주세요. 승인된 건을 취소하면 캘린더에서도 함께 지워집니다.' },
      },
      {
        type: 'input',
        block_id: LEAVE_FIELD.target,
        label: plain('취소할 휴가'),
        element: {
          type: 'static_select',
          action_id: ACTION,
          initial_option: options[0],
          options,
        },
      },
    ],
  }
}

type SubmissionValues = Record<string, Record<string, {
  value?: string | null
  selected_date?: string | null
  selected_option?: { value?: string } | null
}>>

export function readLeaveSubmission(values: SubmissionValues) {
  const get = (field: string) => values?.[field]?.[ACTION] ?? {}

  const start = get(LEAVE_FIELD.start).selected_date ?? ''
  const end = get(LEAVE_FIELD.end).selected_date ?? ''

  return {
    leaveType: (get(LEAVE_FIELD.type).selected_option?.value ?? 'annual') as LeaveType,
    start,
    // 종료일을 비우면 하루짜리
    end: end || start,
    reason: (get(LEAVE_FIELD.reason).value ?? '').trim(),
  }
}

export function readCancelSubmission(values: SubmissionValues): string {
  return values?.[LEAVE_FIELD.target]?.[ACTION]?.selected_option?.value ?? ''
}
