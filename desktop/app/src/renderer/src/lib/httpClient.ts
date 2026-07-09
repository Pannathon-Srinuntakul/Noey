/** HTTP client for backend API calls — routed through the Electron main process
 * so packaged/desktop origins are not blocked by server CORS. */

export interface ApiFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  formFields?: Record<string, string>
  formFiles?: { field: string; path: string; filename?: string }[]
}

export interface ApiFetchResponse {
  ok: boolean
  status: number
  text(): string
  json<T = unknown>(): T
}

export async function apiFetch(url: string, init: ApiFetchInit = {}): Promise<ApiFetchResponse> {
  const result = await window.noey.api.fetch({
    url,
    method: init.method,
    headers: init.headers,
    jsonBody: init.body,
    formFields: init.formFields,
    formFiles: init.formFiles
  })
  return {
    ok: result.ok,
    status: result.status,
    text: () => result.bodyText,
    json: <T = unknown>() => {
      if (!result.bodyText) return undefined as T
      return JSON.parse(result.bodyText) as T
    }
  }
}
