/** Parse FastAPI / worker error payloads into user-facing Thai messages. */

export function formatErrorDetail(detail: unknown, status?: number): string {
  if (detail == null || detail === '') {
    return statusFallback(status)
  }
  if (typeof detail === 'string') {
    return sanitizeLegacyError(detail)
  }
  if (Array.isArray(detail)) {
    const msgs = detail
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x != null)
      .map((x) => x.msg)
      .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
    if (msgs.length > 0) return msgs.join('; ')
    return statusFallback(status)
  }
  if (typeof detail === 'object') {
    const d = detail as Record<string, unknown>
    if (typeof d.message === 'string' && d.message.trim()) {
      return d.message.trim()
    }
    if (d.error === 'token_limit_exceeded') {
      const used = d.used
      const limit = d.limit
      if (typeof used === 'number' && typeof limit === 'number') {
        return `คุณใช้ token ครบโควตาแล้ว (${used.toLocaleString()}/${limit.toLocaleString()} tokens) กรุณาติดต่อแอดมินเพื่ออัปเกรดแพลน`
      }
      return 'คุณใช้ token ครบโควตาแล้ว กรุณาติดต่อแอดมินเพื่ออัปเกรดแพลน'
    }
    if (typeof d.error === 'string' && d.error.trim()) {
      return d.error.replaceAll('_', ' ')
    }
  }
  return statusFallback(status)
}

export async function readApiError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as Record<string, unknown>
    return formatErrorDetail(body.detail ?? body.message ?? body, response.status)
  } catch {
    return statusFallback(response.status)
  }
}

export function formatUserError(error: unknown): string {
  if (error instanceof Error) {
    return sanitizeLegacyError(error.message)
  }
  if (typeof error === 'string') {
    return sanitizeLegacyError(error)
  }
  return 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง'
}

function statusFallback(status?: number): string {
  if (status === 429) return 'คุณใช้งานเกินโควตาแล้ว กรุณาติดต่อแอดมิน'
  if (status === 403) return 'คุณไม่มีสิทธิ์เข้าถึง'
  if (status === 401) return 'กรุณาเข้าสู่ระบบใหม่'
  if (status === 404) return 'ไม่พบข้อมูลที่ต้องการ'
  if (status != null && status >= 500) return 'เซิร์ฟเวอร์มีปัญหา กรุณาลองใหม่ภายหลัง'
  return 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง'
}

/** Hide raw Python/FastAPI reprs like `429: {'error': ...}`. */
function sanitizeLegacyError(message: string): string {
  const trimmed = message.trim()
  if (!trimmed) return statusFallback()

  const statusMatch = /^(\d{3}):\s*\{/.exec(trimmed)
  if (statusMatch) {
    const status = Number(statusMatch[1])
    if (trimmed.includes('token_limit_exceeded')) {
      const usedMatch = /'used':\s*(\d+)/.exec(trimmed)
      const limitMatch = /'limit':\s*(\d+)/.exec(trimmed)
      const msgMatch = /'message':\s*'([^']+)'/.exec(trimmed)
      if (msgMatch?.[1]) return msgMatch[1]
      if (usedMatch && limitMatch) {
        const used = Number(usedMatch[1])
        const limit = Number(limitMatch[1])
        return `คุณใช้ token ครบโควตาแล้ว (${used.toLocaleString()}/${limit.toLocaleString()} tokens) กรุณาติดต่อแอดมินเพื่ออัปเกรดแพลน`
      }
      return statusFallback(status)
    }
    return statusFallback(status)
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      return formatErrorDetail(JSON.parse(trimmed) as unknown)
    } catch {
      return statusFallback()
    }
  }

  return trimmed
}
