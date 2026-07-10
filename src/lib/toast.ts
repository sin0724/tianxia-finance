import { toast as base } from 'sonner'
import type { ExternalToast } from 'sonner'

/**
 * sonner 래퍼 — 성공은 짧게, 에러·경고는 읽을 시간을 준다.
 * 페이지에서는 'sonner' 대신 '@/lib/toast'에서 import 한다.
 */
export const toast = Object.assign(
  (message: string, options?: ExternalToast) => base(message, options),
  {
    success: (message: string, options?: ExternalToast) => base.success(message, options),
    info: (message: string, options?: ExternalToast) => base.info(message, options),
    warning: (message: string, options?: ExternalToast) =>
      base.warning(message, { duration: 5000, ...options }),
    error: (message: string, options?: ExternalToast) =>
      base.error(message, { duration: 6000, closeButton: true, ...options }),
    dismiss: base.dismiss,
  }
)
