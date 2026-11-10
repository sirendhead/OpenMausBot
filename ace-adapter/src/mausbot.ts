import type { Env } from './types'

export type BotReply =
  | { kind: 'reply'; reply: string; thread: string }
  | { kind: 'working'; thread: string }
  | { kind: 'needs_approval'; thread: string }
  | { kind: 'error'; status: number; retryAfterSec?: number; cause?: 'access' | 'offline' }

export const MAX_MESSAGE_CHARS = 20000

function base(env: Env): string {
  return `${env.MAUSBOT_BASE_URL.replace(/\/+$/, '')}/hooks/api/bots/${encodeURIComponent(env.MAUSBOT_BOT_ID)}/messages`
}

function headers(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.MAUSBOT_BOT_API_KEY}`,
    'Content-Type': 'application/json',
    'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
    'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
  }
}

async function parse(res: Response): Promise<BotReply> {
  // Cloudflare Access login redirect (service token missing/invalid): auth failure, never followed.
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') ?? ''
    return { kind: 'error', status: res.status, cause: /cloudflareaccess\.com/i.test(loc) || res.status === 302 ? 'access' : undefined }
  }
  // Tunnel down: Cloudflare 52x/530, or a 502 that is HTML (MausBot's own 502 is JSON).
  const html = !/json/i.test(res.headers.get('content-type') ?? '')
  if ([521, 522, 523, 524, 530].includes(res.status) || (res.status === 502 && html)) {
    return { kind: 'error', status: res.status, cause: 'offline' }
  }
  if (res.status !== 200 && res.status !== 202) {
    const ra = Number(res.headers.get('retry-after'))
    return { kind: 'error', status: res.status, retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : undefined }
  }
  let j: { reply?: unknown; thread?: unknown; status?: unknown }
  try { j = await res.json() as typeof j } catch { return { kind: 'error', status: 502 } }
  const thread = typeof j.thread === 'string' ? j.thread : ''
  if (res.status === 200 && typeof j.reply === 'string') return { kind: 'reply', reply: j.reply, thread }
  if (j.status === 'needs_approval') return { kind: 'needs_approval', thread }
  if (j.status === 'working') return { kind: 'working', thread }
  return { kind: 'error', status: 502 }
}

/** POST a message. Network failure => status 0 (the message may or may not have been taken). */
export async function postMessage(env: Env, message: string, thread: string | undefined, waitSec: number, f: typeof fetch): Promise<BotReply> {
  const body: Record<string, unknown> = { message: message.slice(0, MAX_MESSAGE_CHARS), wait: waitSec }
  if (thread) body.thread = thread
  try {
    return await parse(await f(base(env), { method: 'POST', headers: headers(env), body: JSON.stringify(body), redirect: 'manual' }))
  } catch {
    return { kind: 'error', status: 0 }
  }
}

export async function getThread(env: Env, thread: string, f: typeof fetch): Promise<BotReply> {
  try {
    return await parse(await f(`${base(env)}?thread=${encodeURIComponent(thread)}`, { method: 'GET', headers: headers(env), redirect: 'manual' }))
  } catch {
    return { kind: 'error', status: 0 }
  }
}
