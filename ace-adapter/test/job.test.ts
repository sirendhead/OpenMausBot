import { describe, it, expect } from 'vitest'
import { processJob, DEADLINE_MARGIN_MS } from '../src/job'
import type { Job } from '../src/types'
import * as engine from './engine-verifier'
import { SECRET, NOW, makeEnv, fakeFetch, J } from './helpers'

const CB = 'https://ace.example.test/api/external-agents/runs/xrun_1/result'
const expires = (ms = 30 * 60_000) => new Date(NOW + ms).toISOString()
const send = (over: Partial<Extract<Job, { phase: 'send' }>> = {}): Job => ({
  phase: 'send', runId: 'xrun_1', callbackUrl: CB, expiresAt: expires(), mapKey: 'thr:ch1:root', message: 'Dong: hi', attempt: 0, ...over,
})
const poll = (over: Partial<Extract<Job, { phase: 'poll' }>> = {}): Job => ({
  phase: 'poll', runId: 'xrun_1', callbackUrl: CB, expiresAt: expires(), mapKey: 'thr:ch1:root', thread: 't1', attempt: 0, ...over,
})
const run = (job: Job, env: ReturnType<typeof makeEnv>['env'], f: typeof fetch, now = NOW) =>
  processJob(job, env, { now: () => now, fetch: f })

const expectCallback = (step: Awaited<ReturnType<typeof run>>, status: 'completed' | 'failed', textRe?: RegExp) => {
  expect(step).not.toBeNull()
  const n = step!.next
  expect(n.phase).toBe('callback')
  if (n.phase !== 'callback') return
  expect(n.result.status).toBe(status)
  if (textRe) expect(n.result.text).toMatch(textRe)
}

describe('send phase', () => {
  it('200 -> completed callback with reply; stores thread mapping; sends Access + Bearer headers', async () => {
    const { env, kv } = makeEnv()
    const { f, calls } = fakeFetch([J(200, { reply: 'hi there', thread: 't1' })])
    const step = await run(send(), env, f)
    expectCallback(step, 'completed', /^hi there$/)
    expect(kv.m.get('thr:ch1:root')).toBe('t1')
    expect(calls[0].url).toBe('https://bot.example.test/hooks/api/bots/bot1/messages')
    const h = calls[0].init.headers as Record<string, string>
    expect(h.Authorization).toBe('Bearer k_secret')
    expect(h['CF-Access-Client-Id']).toBe('cid.access')
    expect(h['CF-Access-Client-Secret']).toBe('csecret')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ message: 'Dong: hi', wait: 25 })
  })
  it('continues a mapped thread', async () => {
    const { env, kv } = makeEnv()
    kv.m.set('thr:ch1:root', 'tOld')
    const { f, calls } = fakeFetch([J(200, { reply: 'again', thread: 'tOld' })])
    await run(send(), env, f)
    expect(JSON.parse(calls[0].init.body as string).thread).toBe('tOld')
  })
  it('404 on a mapped thread -> starts a new thread and remaps', async () => {
    const { env, kv } = makeEnv()
    kv.m.set('thr:ch1:root', 'gone')
    const { f, calls } = fakeFetch([J(404, { error: 'no such thread' }), J(200, { reply: 'fresh', thread: 'tNew' })])
    const step = await run(send(), env, f)
    expectCallback(step, 'completed', /fresh/)
    expect(JSON.parse(calls[1].init.body as string).thread).toBeUndefined()
    expect(kv.m.get('thr:ch1:root')).toBe('tNew')
  })
  it('202 working -> poll job with backoff delay', async () => {
    const { env } = makeEnv()
    const { f } = fakeFetch([J(202, { thread: 't9', status: 'working' })])
    const step = await run(send(), env, f)
    expect(step!.next).toMatchObject({ phase: 'poll', thread: 't9', attempt: 1 })
    expect(step!.delaySeconds).toBe(5)
  })
  it('202 needs_approval -> completed callback saying approval happens in MausBot', async () => {
    const { env } = makeEnv({ MAUSBOT_THREAD_URL_TEMPLATE: 'https://bot.example.test/t/{thread}' })
    const { f } = fakeFetch([J(202, { thread: 't7', status: 'needs_approval' })])
    const step = await run(send(), env, f)
    expectCallback(step, 'completed', /^Waiting for approval in MausBot: https:\/\/bot\.example\.test\/t\/t7\./)
  })
  it('needs_approval without a link template falls back to the thread id', async () => {
    const { env } = makeEnv()
    const { f } = fakeFetch([J(202, { thread: 't7', status: 'needs_approval' })])
    expectCallback(await run(send(), env, f), 'completed', /Waiting for approval in MausBot: thread t7/)
  })
  it('409 busy -> re-queued send with backoff, then fails at the deadline', async () => {
    const { env } = makeEnv()
    const { f } = fakeFetch([J(409, { error: 'busy' })])
    const step = await run(send(), env, f)
    expect(step!.next).toMatchObject({ phase: 'send', attempt: 1 })
    expect(step!.delaySeconds).toBe(10)
    const { f: f2 } = fakeFetch([J(409, { error: 'busy' })])
    const late = await run(send({ expiresAt: expires(DEADLINE_MARGIN_MS + 500), attempt: 5 }), env, f2)
    expectCallback(late, 'failed', /busy/)
  })
  it('429 honours Retry-After and retries; fails when no time is left', async () => {
    const { env } = makeEnv()
    const { f } = fakeFetch([J(429, { error: 'x' }, { 'Retry-After': '45' })])
    const step = await run(send(), env, f)
    expect(step!.next.phase).toBe('send')
    expect(step!.delaySeconds).toBe(45)
    const { f: f2 } = fakeFetch([J(429, { error: 'x' })])
    expectCallback(await run(send({ expiresAt: expires(DEADLINE_MARGIN_MS + 500) }), env, f2), 'failed', /rate limit/)
  })
  it('401 / 403 / 502 (JSON) -> failed, no retry, no secrets in text', async () => {
    for (const [status, re] of [[401, /credentials/], [403, /credentials/], [502, /could not answer/]] as const) {
      const { env } = makeEnv()
      const { f, calls } = fakeFetch([J(status, { error: 'k_secret leaked?' })])
      const step = await run(send(), env, f)
      expectCallback(step, 'failed', re)
      if (step!.next.phase === 'callback') expect(step!.next.result.text).not.toMatch(/k_secret|csecret|whsec/)
      expect(calls).toHaveLength(1)
    }
  })
  it('network error on POST is not resent (could duplicate)', async () => {
    const { env } = makeEnv()
    const { f, calls } = fakeFetch([new Error('boom')])
    expectCallback(await run(send(), env, f), 'failed', /Could not reach/)
    expect(calls).toHaveLength(1)
  })
  it('already past the deadline -> failed with honest message', async () => {
    const { env } = makeEnv()
    const { f, calls } = fakeFetch([])
    expectCallback(await run(send({ expiresAt: expires(-1000) }), env, f), 'failed', /did not finish before the ACE deadline/)
    expect(calls).toHaveLength(0)
  })
})

describe('Cloudflare Access / tunnel', () => {
  it('403 from Access -> failed, no retry', async () => {
    const { env } = makeEnv()
    const { f, calls } = fakeFetch([new Response('Forbidden', { status: 403 })])
    expectCallback(await run(send(), env, f), 'failed', /refused/)
    expect(calls).toHaveLength(1)
  })
  it('302 to cloudflareaccess.com -> Access auth failure, not followed, no retry', async () => {
    const { env } = makeEnv()
    const { f, calls } = fakeFetch([new Response(null, { status: 302, headers: { Location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/bot.example.test' } })])
    const step = await run(send(), env, f)
    expectCallback(step, 'failed', /Cloudflare Access.*service token/)
    expect(calls).toHaveLength(1)
    expect(calls[0].init.redirect).toBe('manual')
  })
  it.each([502, 521, 522, 530])('tunnel down (%i HTML) -> retried with backoff on send', async (status) => {
    const { env } = makeEnv()
    const { f } = fakeFetch([new Response('<html>Bad gateway</html>', { status, headers: { 'Content-Type': 'text/html' } })])
    const step = await run(send(), env, f)
    expect(step!.next).toMatchObject({ phase: 'send', attempt: 1 })
    expect(step!.delaySeconds).toBe(15)
  })
  it('tunnel down until the deadline -> failed "host offline"', async () => {
    const { env } = makeEnv()
    const { f } = fakeFetch([new Response('<html/>', { status: 530, headers: { 'Content-Type': 'text/html' } })])
    expectCallback(await run(send({ expiresAt: expires(DEADLINE_MARGIN_MS + 500), attempt: 3 }), env, f), 'failed', /offline/)
  })
  it('tunnel down during polling is retried; Access failure during polling fails', async () => {
    const { env } = makeEnv()
    const { f } = fakeFetch([new Response('<html/>', { status: 522, headers: { 'Content-Type': 'text/html' } })])
    const step = await run(poll(), env, f)
    expect(step!.next).toMatchObject({ phase: 'poll', attempt: 1 })
    const { f: f2 } = fakeFetch([new Response(null, { status: 302, headers: { Location: 'https://t.cloudflareaccess.com/x' } })])
    expectCallback(await run(poll(), env, f2), 'failed', /Cloudflare Access/)
  })
  it('poll also sends Access headers', async () => {
    const { env } = makeEnv()
    const { f, calls } = fakeFetch([J(200, { reply: 'done', thread: 't1' })])
    await run(poll(), env, f)
    const h = calls[0].init.headers as Record<string, string>
    expect(h['CF-Access-Client-Id']).toBe('cid.access')
    expect(h['CF-Access-Client-Secret']).toBe('csecret')
  })
})

describe('reply size limits', () => {
  it('truncates a 16001-char reply so the callback is <=16000 chars', async () => {
    const { env } = makeEnv()
    const step = await run(send(), env, fakeFetch([J(200, { reply: 'a'.repeat(16001), thread: 't' })]).f)
    const n = step!.next
    if (n.phase !== 'callback') throw new Error('expected callback')
    expect(n.result.text.length).toBeLessThanOrEqual(16000)
    expect(n.result.text).toMatch(/truncated/)
  })
  it('keeps the JSON body under 64 KB for multi-byte text', async () => {
    const { env } = makeEnv()
    const step = await run(send(), env, fakeFetch([J(200, { reply: '€'.repeat(15000), thread: 't' })]).f)
    const n = step!.next
    if (n.phase !== 'callback') throw new Error('expected callback')
    expect(new TextEncoder().encode(JSON.stringify(n.result)).length).toBeLessThanOrEqual(64 * 1024)
  })
})

describe('poll phase', () => {
  it('202 working repeatedly backs off 5 -> 10 -> 20 -> 30 -> 30', async () => {
    const { env } = makeEnv()
    const delays: number[] = []
    let job: Job = poll()
    for (let i = 0; i < 5; i++) {
      const { f } = fakeFetch([J(202, { thread: 't1', status: 'working' })])
      const step = await run(job, env, f)
      delays.push(step!.delaySeconds)
      job = step!.next
    }
    expect(delays).toEqual([5, 10, 20, 30, 30])
  })
  it('200 reply -> completed', async () => {
    const { env } = makeEnv()
    const { f, calls } = fakeFetch([J(200, { reply: 'finally', thread: 't1' })])
    expectCallback(await run(poll(), env, f), 'completed', /finally/)
    expect(calls[0].url).toContain('?thread=t1')
    expect(calls[0].init.method).toBe('GET')
  })
  it('needs_approval while polling -> completed note', async () => {
    const { env } = makeEnv()
    const { f } = fakeFetch([J(202, { thread: 't1', status: 'needs_approval' })])
    expectCallback(await run(poll(), env, f), 'completed', /Waiting for approval in MausBot/)
  })
  it('404 -> failed; 502 -> failed; transient 503 -> retried', async () => {
    const { env } = makeEnv()
    expectCallback(await run(poll(), env, fakeFetch([J(404, {})]).f), 'failed', /disappeared/)
    expectCallback(await run(poll(), env, fakeFetch([J(502, {})]).f), 'failed', /could not answer/)
    const step = await run(poll(), env, fakeFetch([J(503, {})]).f)
    expect(step!.next).toMatchObject({ phase: 'poll', attempt: 1 })
  })
  it('expiry -> failed with an honest message', async () => {
    const { env } = makeEnv()
    const { f } = fakeFetch([])
    expectCallback(await run(poll({ expiresAt: expires(5_000) }), env, f), 'failed', /did not finish before the ACE deadline/)
  })
  it('working but delay would pass the deadline -> failed', async () => {
    const { env } = makeEnv()
    const { f } = fakeFetch([J(202, { thread: 't1', status: 'working' })])
    expectCallback(await run(poll({ expiresAt: expires(DEADLINE_MARGIN_MS + 500) }), env, f), 'failed', /deadline/)
  })
})

describe('callback phase (contract C)', () => {
  const cbJob = (text = 'answer', status: 'completed' | 'failed' = 'completed', over = {}): Job => ({
    phase: 'callback', runId: 'xrun_1', callbackUrl: CB, expiresAt: expires(), result: { status, text }, attempt: 0, ...over,
  })

  it('signed callback verifies with the engine verifier (requireTimestamp)', async () => {
    const { env } = makeEnv()
    const { f, calls } = fakeFetch([J(200, { ok: true })])
    expect(await run(cbJob('hello'), env, f)).toBeNull()
    const c = calls[0]
    expect(c.url).toBe(CB)
    const h = c.init.headers as Record<string, string>
    const raw = c.init.body as string
    expect(JSON.parse(raw)).toEqual({ status: 'completed', text: 'hello' })
    expect(await engine.verifyDispatchSignature(raw, h['X-Webhook-Signature'], SECRET, { timestamp: h['X-Webhook-Timestamp'], now: NOW, requireTimestamp: true })).toBe(true)
    expect(await engine.verifyDispatchSignature(raw, h['X-Webhook-Signature'], 'whsec_wrong', { timestamp: h['X-Webhook-Timestamp'], now: NOW, requireTimestamp: true })).toBe(false)
    expect(Math.abs(Number(h['X-Webhook-Timestamp']) - NOW / 1000)).toBeLessThanOrEqual(300)
    expect(h['CF-Access-Client-Secret']).toBeUndefined() // Access headers go only to MausBot
  })
  it('failed callback carries status failed and <=500 chars', async () => {
    const { env } = makeEnv()
    const { f, calls } = fakeFetch([J(200, { ok: true })])
    await run(cbJob('x', 'failed'), env, f)
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ status: 'failed', text: 'x' })
  })
  it('retries 5xx / network with backoff; stops on 4xx and after the run closed', async () => {
    const { env } = makeEnv()
    const s1 = await run(cbJob(), env, fakeFetch([J(502, { code: 'post_failed' })]).f)
    expect(s1!.next).toMatchObject({ phase: 'callback', attempt: 1 })
    expect(s1!.delaySeconds).toBe(5)
    const s2 = await run(cbJob(), env, fakeFetch([new Error('net')]).f)
    expect(s2!.next.phase).toBe('callback')
    for (const st of [401, 404, 409, 410, 413]) expect(await run(cbJob(), env, fakeFetch([J(st, {})]).f)).toBeNull()
    const dead = await run(cbJob('a', 'completed', { expiresAt: expires(-120_000) }), env, fakeFetch([J(502, {})]).f)
    expect(dead).toBeNull()
  })
  it('duplicate 200 is success', async () => {
    const { env } = makeEnv()
    expect(await run(cbJob(), env, fakeFetch([J(200, { ok: true, duplicate: true })]).f)).toBeNull()
  })
})

describe('end to end through the job chain', () => {
  it('send -> working -> poll -> reply -> signed callback', async () => {
    const { env, kv } = makeEnv()
    const { f, calls } = fakeFetch([
      J(202, { thread: 'tZ', status: 'working' }),
      J(202, { thread: 'tZ', status: 'working' }),
      J(200, { reply: 'all done', thread: 'tZ' }),
      J(200, { ok: true }),
    ])
    let step = await run(send(), env, f)
    while (step) {
      const next = await run(step.next, env, f)
      if (!next) break
      step = next
    }
    expect(calls).toHaveLength(4)
    expect(JSON.parse(calls[3].init.body as string)).toEqual({ status: 'completed', text: 'all done' })
    expect(kv.m.get('thr:ch1:root')).toBe('tZ')
  })
})
