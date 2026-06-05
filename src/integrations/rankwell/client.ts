/**
 * Outbound client for Rankwell's tenant-authed API. Used by the
 * Telegram callback handlers to approve / reject / implement / dismiss
 * actions and recommendations that operator surfaced via askfritz.
 *
 * Auth: X-API-Key header against the value stored in RANKWELL_API_KEY.
 * Base URL: RANKWELL_API_URL (e.g. https://api.rankwell.stayfritz.com).
 *
 * Both env vars must be set for any function here to do anything; calls
 * silently no-op when either is missing so a half-configured deploy
 * doesn't crash on the first Telegram button press.
 */

import { logger } from '../../lib/logger.js'

const REQUEST_TIMEOUT_MS = 12_000

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }

function configured(): boolean {
  return Boolean(process.env.RANKWELL_API_URL && process.env.RANKWELL_API_KEY)
}

async function post<T = unknown>(
  path: string,
  body?: Record<string, unknown>,
): Promise<Result<T>> {
  if (!configured()) {
    return { ok: false, error: 'rankwell api not configured' }
  }
  const baseUrl = process.env.RANKWELL_API_URL as string
  const apiKey = process.env.RANKWELL_API_KEY as string
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await res.text()
    if (!res.ok) {
      let detail: string | undefined
      try {
        detail = (JSON.parse(text) as { error?: string }).error
      } catch {
        detail = text.slice(0, 200)
      }
      logger.warn(
        { path, status: res.status, detail },
        'rankwell:api-non-ok',
      )
      return { ok: false, error: detail ?? `${res.status} ${res.statusText}` }
    }
    if (!text) return { ok: true, data: {} as T }
    try {
      return { ok: true, data: JSON.parse(text) as T }
    } catch {
      return { ok: true, data: {} as T }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn({ path, err: message }, 'rankwell:api-throw')
    return { ok: false, error: message }
  }
}

/* ---------------- Hypotheses (actions) ---------------- */

export async function approveAction(actionId: string): Promise<Result<unknown>> {
  return post(`/v1/hypotheses/${encodeURIComponent(actionId)}/approve`)
}

export async function rejectAction(actionId: string): Promise<Result<unknown>> {
  return post(`/v1/hypotheses/${encodeURIComponent(actionId)}/reject`)
}

/* ---------------- Recommendations ---------------- */

export async function implementRecommendation(
  recommendationId: string,
): Promise<Result<{ enqueued?: number; capped?: boolean }>> {
  return post<{ enqueued?: number; capped?: boolean }>(
    `/v1/recommendations/${encodeURIComponent(recommendationId)}/implement`,
  )
}

export async function dismissRecommendation(
  recommendationId: string,
): Promise<Result<unknown>> {
  return post(`/v1/recommendations/${encodeURIComponent(recommendationId)}/dismiss`)
}

export function isRankwellConfigured(): boolean {
  return configured()
}
