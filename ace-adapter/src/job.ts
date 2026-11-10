import type { Env, Job, Step } from './types'
import { postMessage, getThread, type BotReply } from './mausbot'
import { signWebhookTs } from './sign'

export const DEADLINE_MARGIN_MS = 10_000
export const MAX_ATTEMPTS = 300
export const THREAD_MAP_TTL_SEC = 30 * 24 * 3600
const POLL_BACKOFF = [5, 10, 20, 30]
const BUSY_BACKOFF = [10, 15, 30]
const OFFLINE_BACKOFF = [15, 30, 60]
const CALLBACK_BACKOFF = [5, 15, 30]

export interface Deps {
  now: () => number
  fetch: typeof fetch
}
export const realDeps: Deps = { now: () => Date.now(), fetch: (...a) => fetch(...a) }

type Work = Exclude<Job, { phase: 'callback' }>
type CallbackJob = Extract<Job, { phase: 'callback' }>

const pick = (arr: number[], n: number) => arr[Math.min(n, arr.length - 1)]

const TIMEOUT_TEXT = 'MausBot did not finish before the ACE deadline. Check the conversation in MausBot; the reply will not be posted here.'

function finish(job: Job, status: 'completed' | 'failed', text: string): Step {
  const t = status === 'failed' ? text.slice(0, 500) : text
  return { next: { phase: 'callback', runId: job.runId, callbackUrl: job.callbackUrl, expiresAt: job.expiresAt, result: { status, text: t }, attempt: 0 }, delaySeconds: 0 }
}

/** Seconds to wait before the next try, clamped to the deadline; null when no time is left. */
function clampDelay(job: Job, want: number, d: Deps): number | null {
  const left = (Date.parse(job.expiresAt) - DEADLINE_MARGIN_MS - d.now()) / 1000
  if (left <= 1) return null
  return Math.max(1, Math.min(want, Math.floor(left)))
}

function approvalText(env: Env, thread: string): string {
  const tpl = env.MAUSBOT_THREAD_URL_TEMPLATE
  const where = tpl ? tpl.replace('{thread}', encodeURIComponent(thread)) : `thread ${thread}`
  return `Waiting for approval in MausBot: ${where}. Approval happens in the MausBot app, not in ACE; the reply will not be posted here.`
}

function errorText(status: number): string {
  if (status === 401 || status === 403) return `MausBot refused the adapter's credentials, or the Bot API is off for this bot (HTTP ${status}).`
  if (status === 502) return 'MausBot could not answer this message (HTTP 502).'
  if (status === 0) return 'Could not reach MausBot.'
  if (status === 400 || status === 413 || status === 415) return `MausBot rejected the request (HTTP ${status}).`
  return `MausBot returned an unexpected error (HTTP ${status}).`
}

/** Turn a Bot API answer into the next step. `retry` is what gets re-queued on 409/429. */
function handleReply(env: Env, job: Work, r: BotReply, retry: Work, d: Deps): Step {
  switch (r.kind) {
    case 'reply': return finish(job, 'completed', r.reply || '(empty reply)')
    case 'needs_approval': return finish(job, 'completed', approvalText(env, r.thread))
    case 'working': {
      const delay = clampDelay(job, pick(POLL_BACKOFF, job.attempt), d)
      if (delay === null) return finish(job, 'failed', TIMEOUT_TEXT)
      return { next: { phase: 'poll', runId: job.runId, callbackUrl: job.callbackUrl, expiresAt: job.expiresAt, mapKey: job.mapKey, thread: r.thread, attempt: job.attempt + 1 }, delaySeconds: delay }
    }
    case 'error': {
      if (r.cause === 'access') return finish(job, 'failed', 'Access to the MausBot host was refused by Cloudflare Access (check the service token).')
      if (r.cause === 'offline') {
        const delay = clampDelay(job, pick(OFFLINE_BACKOFF, job.attempt), d)
        if (delay === null) return finish(job, 'failed', 'The MausBot host is offline (tunnel unreachable) and did not come back before the ACE deadline.')
        return { next: { ...retry, attempt: job.attempt + 1 }, delaySeconds: delay }
      }
      if (r.status === 409 || r.status === 429) {
        const delay = clampDelay(job, Math.max(r.retryAfterSec ?? 0, pick(BUSY_BACKOFF, job.attempt)), d)
        if (delay === null) return finish(job, 'failed', r.status === 429 ? 'MausBot rate limit (10 calls per minute per key) did not clear before the ACE deadline.' : 'MausBot stayed busy until the ACE deadline.')
        return { next: { ...retry, attempt: job.attempt + 1 }, delaySeconds: delay }
      }
      return finish(job, 'failed', errorText(r.status))
    }
  }
}

/** Signed callback (contract C). Returns the HTTP status, or 0 on network failure. */
export async function postCallback(job: CallbackJob, env: Env, d: Deps): Promise<number> {
  const body = JSON.stringify(job.result)
  const ts = String(Math.floor(d.now() / 1000))
  try {
    const res = await d.fetch(job.callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Timestamp': ts,
        'X-Webhook-Signature': await signWebhookTs(body, env.ACE_XA_BINDING_SECRET, ts),
      },
      body,
      redirect: 'manual',
    })
    try { void res.body?.cancel() } catch { /* ignore */ }
    return res.status
  } catch {
    return 0
  }
}

/**
 * One step of a run. Returns the next job to enqueue (with delay) or null when finished.
 * Upstream conditions never throw; the final outcome always leaves as a signed callback.
 */
export async function processJob(job: Job, env: Env, d: Deps = realDeps): Promise<Step> {
  if (job.attempt > MAX_ATTEMPTS) return null

  if (job.phase === 'callback') {
    const status = await postCallback(job, env, d)
    // 2xx (incl. duplicate) is done; 4xx except 429 is final (401/404/409/410 will not improve by retrying).
    if ((status >= 200 && status < 300) || (status >= 400 && status < 500 && status !== 429)) return null
    if (d.now() >= Date.parse(job.expiresAt) + 60_000) return null // ACE closed the run
    return { next: { ...job, attempt: job.attempt + 1 }, delaySeconds: pick(CALLBACK_BACKOFF, job.attempt) }
  }

  if (d.now() >= Date.parse(job.expiresAt) - DEADLINE_MARGIN_MS) return finish(job, 'failed', TIMEOUT_TEXT)

  if (job.phase === 'send') {
    const mapped = await env.STATE.get(job.mapKey)
    const wait = Math.min(120, Math.max(1, Number(env.MAUSBOT_WAIT_SEC) || 25))
    let r = await postMessage(env, job.message, mapped ?? undefined, wait, d.fetch)
    if (r.kind === 'error' && r.status === 404 && mapped) {
      // Mapped thread is gone (or not API-opened): start a fresh one.
      await env.STATE.delete(job.mapKey)
      r = await postMessage(env, job.message, undefined, wait, d.fetch)
    }
    if (r.kind !== 'error' && r.thread) await env.STATE.put(job.mapKey, r.thread, { expirationTtl: THREAD_MAP_TTL_SEC })
    // A network failure on POST (status 0) is ambiguous: it is NOT resent, to avoid duplicate messages.
    return handleReply(env, job, r, job, d)
  }

  // poll
  const r = await getThread(env, job.thread, d.fetch)
  if (r.kind === 'error' && r.status === 404) return finish(job, 'failed', 'The MausBot conversation disappeared while waiting for the reply.')
  if (r.kind === 'error' && !r.cause && (r.status === 0 || r.status === 500 || r.status === 503 || r.status === 504)) {
    const delay = clampDelay(job, pick(POLL_BACKOFF, job.attempt), d)
    if (delay === null) return finish(job, 'failed', TIMEOUT_TEXT)
    return { next: { ...job, attempt: job.attempt + 1 }, delaySeconds: delay }
  }
  return handleReply(env, job, r, job, d)
}
