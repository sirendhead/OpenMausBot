import type { Env, InvokePayload, Job } from './types'
import { verifyInbound } from './sign'
import { processJob, realDeps } from './job'

const MAX_BODY = 64 * 1024
const REPLAY_TTL_SEC = 600

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function handleRequest(req: Request, env: Env, now: number = Date.now()): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' })
  const raw = await req.text()
  if (raw.length > MAX_BODY) return json(413, { error: 'body_too_large' })

  const v = await verifyInbound(raw, req.headers.get('X-Webhook-Signature'), req.headers.get('X-Webhook-Timestamp'), env.ACE_XA_BINDING_SECRET, now)
  if (v !== 'ok') return json(401, { error: 'unauthorized', code: v })

  let p: Partial<Omit<InvokePayload, 'type'>> & { type?: string }
  try { p = JSON.parse(raw) } catch { return json(400, { error: 'invalid_json' }) }

  if (p.type === 'agent.ping') return json(200, { ok: true, pong: true })
  if (p.type !== 'agent.invoke') return json(400, { error: 'unsupported_type' })

  const eventId = req.headers.get('X-Webhook-Event-Id') || p.runId || ''
  if (!eventId || !p.runId || !p.callbackUrl || !p.expiresAt || !p.message || typeof p.message.text !== 'string') return json(400, { error: 'invalid_payload' })
  if (!Number.isFinite(Date.parse(p.expiresAt))) return json(400, { error: 'invalid_payload' })

  let cb: URL
  try { cb = new URL(p.callbackUrl) } catch { return json(400, { error: 'invalid_callback' }) }
  if (cb.protocol !== 'https:') return json(400, { error: 'invalid_callback' })
  if (env.ACE_CALLBACK_ORIGIN && cb.origin !== new URL(env.ACE_CALLBACK_ORIGIN).origin) return json(400, { error: 'callback_origin_not_allowed' })

  // Replay guard. KV is eventually consistent; ACE sends each event once, so this is best-effort.
  const seenKey = `evt:${eventId}`
  if (await env.STATE.get(seenKey)) return json(409, { error: 'replay' })
  await env.STATE.put(seenKey, '1', { expirationTtl: REPLAY_TTL_SEC })

  const parent = p.thread?.parentId || p.message.id
  const author = (p.message.author?.name || 'user').slice(0, 80)
  const job: Job = {
    phase: 'send',
    runId: p.runId,
    callbackUrl: p.callbackUrl,
    expiresAt: p.expiresAt,
    mapKey: `thr:${p.channel?.id ?? ''}:${parent}`,
    message: `${author}: ${p.message.text}`,
    attempt: 0,
  }
  try {
    await env.JOBS.send(job)
  } catch {
    await env.STATE.delete(seenKey)
    return json(503, { error: 'enqueue_failed' })
  }
  return json(202, { ok: true, accepted: true })
}

interface QueueMsg { body: Job; ack(): void; retry(o?: { delaySeconds?: number }): void }

export async function handleQueue(batch: { messages: QueueMsg[] }, env: Env): Promise<void> {
  for (const m of batch.messages) {
    try {
      const step = await processJob(m.body, env, realDeps)
      if (step) await env.JOBS.send(step.next, { delaySeconds: step.delaySeconds })
      m.ack()
    } catch {
      m.retry({ delaySeconds: 30 })
    }
  }
}

export default {
  fetch: (req: Request, env: Env) => handleRequest(req, env),
  queue: handleQueue,
}
