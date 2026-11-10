import type { Env, InvokePayload, Job } from '../src/types'
import { signWebhookTs } from '../src/sign'

export const SECRET = 'whsec_testsecret'
export const NOW = Date.parse('2026-11-10T12:00:00.000Z')

export class FakeKV {
  m = new Map<string, string>()
  async get(k: string) { return this.m.get(k) ?? null }
  async put(k: string, v: string) { this.m.set(k, v) }
  async delete(k: string) { this.m.delete(k) }
}

export function makeEnv(over: Partial<Env> = {}) {
  const sent: { job: Job; delaySeconds?: number }[] = []
  const env: Env = {
    STATE: new FakeKV(),
    JOBS: { send: async (job, o) => { sent.push({ job, delaySeconds: o?.delaySeconds }) } },
    ACE_XA_BINDING_SECRET: SECRET,
    MAUSBOT_BOT_API_KEY: 'k_secret',
    CF_ACCESS_CLIENT_ID: 'cid.access',
    CF_ACCESS_CLIENT_SECRET: 'csecret',
    MAUSBOT_BASE_URL: 'https://bot.example.test',
    MAUSBOT_BOT_ID: 'bot1',
    ...over,
  }
  return { env, sent, kv: env.STATE as unknown as FakeKV }
}

export function payload(over: Partial<InvokePayload> = {}): InvokePayload {
  return {
    type: 'agent.invoke',
    runId: 'xrun_1',
    traceId: 't1',
    channel: { id: 'ch1', slug: 'general' },
    thread: { parentId: 'msg_root' },
    message: { id: 'msg_1', text: 'hello bot', author: { name: 'Dong' } },
    callbackUrl: 'https://ace.example.test/api/external-agents/runs/xrun_1/result',
    expiresAt: new Date(NOW + 30 * 60_000).toISOString(),
    ...over,
  }
}

export async function signedRequest(body: unknown, opts: { ts?: string; secret?: string; eventId?: string; sig?: string } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  const ts = opts.ts ?? String(Math.floor(NOW / 1000))
  const sig = opts.sig ?? await signWebhookTs(raw, opts.secret ?? SECRET, ts)
  const id = opts.eventId ?? (typeof body === 'object' && body && 'runId' in body ? String((body as { runId: string }).runId) : 'evt')
  return new Request('https://adapter.test/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Event-Id': id, 'X-Webhook-Timestamp': ts, 'X-Webhook-Signature': sig },
    body: raw,
  })
}

/** Scripted fake fetch: each call consumes the next response; records calls. */
export function fakeFetch(script: (Response | Error | ((url: string, init: RequestInit) => Response))[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const f = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    const next = script.shift()
    if (!next) throw new Error('fake fetch exhausted')
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next(String(url), init) : next
  }) as typeof fetch
  return { f, calls }
}

export const J = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
