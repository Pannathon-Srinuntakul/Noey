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

function extractJsonStatus(text: string): number | undefined {
  const m = /"status"\s*:\s*(\d{3})/.exec(text)
  return m ? Number(m[1]) : undefined
}

function extractJsonType(text: string): string | undefined {
  const nested = /"error"\s*:\s*\{[^}]*"type"\s*:\s*"([^"]+)"/.exec(text)
  if (nested?.[1]) return nested[1].toLowerCase()
  const top = /"type"\s*:\s*"([^"]+)"/.exec(text)
  return top?.[1]?.toLowerCase()
}

function extractUpstreamMessage(text: string): string | undefined {
  const nested = /"error"\s*:\s*\{[^}]*"message"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(text)
  if (nested?.[1]) return nested[1].replace(/\\n/g, ' ').trim()
  const flat = /"message"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(text)
  if (flat?.[1]) return flat[1].replace(/\\n/g, ' ').trim()
  const brace = text.indexOf('{')
  if (brace >= 0) {
    try {
      const payload = JSON.parse(text.slice(brace)) as Record<string, unknown>
      const err = payload.error
      if (typeof err === 'object' && err != null) {
        const msg = (err as Record<string, unknown>).message
        if (typeof msg === 'string' && msg.trim()) return msg.trim()
      }
      if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim()
    } catch {
      // ignore
    }
  }
  return undefined
}

function mapHttpStatus(status: number): string | undefined {
  if (status === 401) return 'การตั้งค่า AI API ไม่ถูกต้อง กรุณาติดต่อแอดมิน'
  if (status === 403) return 'ไม่มีสิทธิ์เรียก AI กรุณาติดต่อแอดมิน'
  if (status === 429) return 'AI ถูกจำกัดการเรียกชั่วคราว กรุณารอแล้วกดลองใหม่'
  if (status === 529) return 'AI รับงานเต็มชั่วคราว กรุณารอ 1–2 นาทีแล้วกดลองใหม่'
  if (status === 520) return 'เซิร์ฟเวอร์ AI (Anthropic) มีปัญหาชั่วคราว กรุณารอ 1–2 นาทีแล้วกดลองใหม่'
  if (status === 502 || status === 503 || status === 504) {
    return 'เซิร์ฟเวอร์ AI ไม่พร้อมชั่วคราว กรุณาลองใหม่ภายหลัง'
  }
  if (status >= 500) return 'เซิร์ฟเวอร์ AI มีปัญหา กรุณาลองใหม่ภายหลัง'
  if (status === 400) return 'คำขอ AI ไม่ถูกต้อง กรุณาลองใหม่หรือติดต่อแอดมิน'
  return undefined
}

function mapAnthropicMessage(raw: string): string | undefined {
  const lower = raw.toLowerCase()
  if (lower.includes('prompt is too long') || lower.includes('context length') || lower.includes('too many tokens')) {
    return 'ข้อมูลส่งให้ AI มากเกินไป (วิดีโอ/รูปยาวเกิน) ลองคลิปสั้นลงหรือลองใหม่'
  }
  if (lower.includes('credit balance') || lower.includes('billing') || lower.includes('payment')) {
    return 'เครดิต AI หมด กรุณาติดต่อแอดมิน'
  }
  if (lower.includes('overloaded')) {
    return 'AI รับงานเต็มชั่วคราว กรุณารอ 1–2 นาทีแล้วกดลองใหม่'
  }
  if (lower.includes('rate limit') || lower.includes('rate_limit')) {
    return 'AI ถูกจำกัดการเรียกชั่วคราว กรุณารอแล้วกดลองใหม่'
  }
  if (lower.includes('invalid api key') || lower.includes('authentication') || lower.includes('unauthorized')) {
    return 'การตั้งค่า AI API ไม่ถูกต้อง กรุณาติดต่อแอดมิน'
  }
  if (lower.includes('model not found') || lower.includes('does not exist')) {
    return 'โมเดล AI ที่ตั้งค่าไว้ใช้งานไม่ได้ กรุณาติดต่อแอดมิน'
  }
  if (lower.includes('content policy') || lower.includes('safety') || lower.includes('blocked')) {
    return 'เนื้อหาไม่ผ่านนโยบายของ AI กรุณาตรวจสอบวิดีโอแล้วลองใหม่'
  }
  return undefined
}

function isUpstreamLlmError(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    lower.includes('litellm.')
    || lower.includes('litellm.exceptions')
    || lower.includes('anthropicexception')
    || lower.includes('api.anthropic.com')
    || lower.includes('cloudflare')
    || lower.includes('ray_id')
  )
}

/** Hide raw Python/FastAPI reprs and upstream LLM SDK errors. */
function sanitizeLegacyError(message: string): string {
  const trimmed = message.trim()
  if (!trimmed) return statusFallback()

  const lower = trimmed.toLowerCase()

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
    return mapHttpStatus(status) ?? statusFallback(status)
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      return formatErrorDetail(JSON.parse(trimmed) as unknown)
    } catch {
      return statusFallback()
    }
  }

  if (lower.includes('token_limit_exceeded')) {
    return 'คุณใช้ token ครบโควตาแล้ว กรุณาติดต่อแอดมินเพื่ออัปเกรดแพลน'
  }

  const jsonStatus = extractJsonStatus(trimmed)
  if (jsonStatus != null) {
    const mapped = mapHttpStatus(jsonStatus)
    if (mapped) return mapped
  }

  const errType = extractJsonType(trimmed)
  if (errType === 'overloaded_error' || errType === 'overloaded') {
    return 'AI รับงานเต็มชั่วคราว กรุณารอ 1–2 นาทีแล้วกดลองใหม่'
  }
  if (errType === 'rate_limit_error' || errType === 'rate_limit') {
    return 'AI ถูกจำกัดการเรียกชั่วคราว กรุณารอแล้วกดลองใหม่'
  }
  if (errType === 'authentication_error' || errType === 'permission_error') {
    return 'การตั้งค่า AI API ไม่ถูกต้อง กรุณาติดต่อแอดมิน'
  }

  const upstream = extractUpstreamMessage(trimmed)
  if (upstream) {
    const mapped = mapAnthropicMessage(upstream)
    if (mapped) return mapped
    if (isUpstreamLlmError(trimmed)) {
      return 'เชื่อมต่อ AI ไม่สำเร็จ กรุณารอสักครู่แล้วกดลองใหม่'
    }
  }

  if (lower.includes('error 520') || lower.includes('error_520')) {
    return 'เซิร์ฟเวอร์ AI (Anthropic) มีปัญหาชั่วคราว กรุณารอ 1–2 นาทีแล้วกดลองใหม่'
  }
  if (lower.includes('error 502') || lower.includes('error 503') || lower.includes('error 504') || lower.includes('error 529')) {
    return 'เซิร์ฟเวอร์ AI ไม่พร้อมชั่วคราว กรุณาลองใหม่ภายหลัง'
  }
  if (lower.includes('apiconnectionerror') || lower.includes('connection error')) {
    return 'เชื่อมต่อ AI ไม่ได้ชั่วคราว กรุณารอ 1–2 นาทีแล้วกดลองใหม่'
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return 'AI ใช้เวลานานเกินไป กรุณาลองใหม่'
  }
  if (isUpstreamLlmError(trimmed)) {
    return 'เชื่อมต่อ AI ไม่สำเร็จ กรุณารอสักครู่แล้วกดลองใหม่'
  }
  if (
    trimmed.includes('{')
    && (isUpstreamLlmError(trimmed) || lower.includes('cloudflare_error') || lower.includes('ray_id') || trimmed.includes('"status":'))
  ) {
    return 'เชื่อมต่อ AI ไม่สำเร็จ กรุณารอสักครู่แล้วกดลองใหม่'
  }
  if (
    trimmed.length > 160
    && (lower.includes('exception') || lower.includes('traceback'))
  ) {
    return 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง'
  }

  return trimmed
}
