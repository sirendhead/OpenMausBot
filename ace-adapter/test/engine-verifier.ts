// Verbatim logic of agent-chat-engine src/worker/engine/dispatch.ts (origin/master):
// hmacHex, signWebhook, signWebhookTs, verifyHmacHex, verifyDispatchSignature.
// Used only to prove our signatures/verification are interchangeable with the engine's.
// (timingSafeEqual stands in for the engine's shared lib helper.)
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

export async function hmacHex(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function signWebhook(payload: string, secret: string): Promise<string> {
  return `sha256=${await hmacHex(payload, secret)}`
}

export async function signWebhookTs(payload: string, secret: string, timestamp: string): Promise<string> {
  return signWebhook(`${timestamp}.${payload}`, secret)
}

async function verifyHmacHex(payload: string, header: string, secret: string): Promise<boolean> {
  const lower = header.toLowerCase()
  const provided = lower.startsWith('sha256=') ? lower.slice('sha256='.length) : lower
  if (!/^[0-9a-f]+$/.test(provided)) return false
  const expected = await hmacHex(payload, secret)
  return timingSafeEqual(provided, expected)
}

export async function verifyDispatchSignature(
  rawBody: string,
  header: string | undefined,
  secret: string | undefined,
  opts: { timestamp?: string | undefined; now?: number; maxSkewSec?: number; requireTimestamp?: boolean } = {},
): Promise<boolean> {
  if (!secret) return true
  if (!header) return false
  const ts = opts.timestamp
  if (ts != null && ts !== '') {
    const tsNum = Number(ts)
    const nowSec = (opts.now ?? Date.now()) / 1000
    const maxSkew = opts.maxSkewSec ?? 300
    if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > maxSkew) return false
    return verifyHmacHex(`${ts}.${rawBody}`, header, secret)
  }
  if (opts.requireTimestamp) return false
  return verifyHmacHex(rawBody, header, secret)
}
