// Same scheme as agent-chat-engine src/worker/engine/dispatch.ts:
// X-Webhook-Signature = "sha256=" + hex(HMAC_SHA256(secret, "<ts>.<rawBody>"))
const enc = new TextEncoder()

export async function hmacHex(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function signWebhookTs(body: string, secret: string, timestamp: string): Promise<string> {
  return `sha256=${await hmacHex(`${timestamp}.${body}`, secret)}`
}

export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

export const MAX_SKEW_SEC = 300

export type VerifyResult = 'ok' | 'missing' | 'stale' | 'bad_signature'

/** Constant-time check of a timestamped signature; ts must be within +/-5 min. */
export async function verifyInbound(
  rawBody: string,
  sigHeader: string | null,
  tsHeader: string | null,
  secret: string,
  nowMs: number = Date.now(),
): Promise<VerifyResult> {
  if (!secret || !sigHeader || !tsHeader) return 'missing'
  const ts = Number(tsHeader)
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > MAX_SKEW_SEC) return 'stale'
  const lower = sigHeader.toLowerCase()
  const provided = lower.startsWith('sha256=') ? lower.slice(7) : lower
  if (!/^[0-9a-f]+$/.test(provided)) return 'bad_signature'
  const expected = await hmacHex(`${tsHeader}.${rawBody}`, secret)
  return timingSafeEqual(provided, expected) ? 'ok' : 'bad_signature'
}
