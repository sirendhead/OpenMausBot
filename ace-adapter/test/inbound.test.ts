import { describe, it, expect } from 'vitest'
import { handleRequest } from '../src/index'
import { verifyInbound, signWebhookTs } from '../src/sign'
import * as engine from './engine-verifier'
import { SECRET, NOW, makeEnv, payload, signedRequest } from './helpers'

describe('signature scheme parity with engine', () => {
  it('matches a fixed vector (computed independently with node crypto)', async () => {
    const sig = await signWebhookTs('{"type":"agent.ping"}', 'whsec_testvector', '1760000000')
    expect(sig).toBe('sha256=71c235757363a6f1635b94d62700b496f742358dc740e6dbc4f4f5c0100854fd')
    expect(await engine.signWebhookTs('{"type":"agent.ping"}', 'whsec_testvector', '1760000000')).toBe(sig)
  })
  it('engine signature verifies in the adapter and vice versa', async () => {
    const body = JSON.stringify(payload())
    const ts = String(Math.floor(NOW / 1000))
    expect(await verifyInbound(body, await engine.signWebhookTs(body, SECRET, ts), ts, SECRET, NOW)).toBe('ok')
    const mine = await signWebhookTs(body, SECRET, ts)
    expect(await engine.verifyDispatchSignature(body, mine, SECRET, { timestamp: ts, now: NOW, requireTimestamp: true })).toBe(true)
  })
})

describe('inbound webhook', () => {
  it('accepts a valid agent.invoke with 202 and enqueues a send job', async () => {
    const { env, sent } = makeEnv()
    const res = await handleRequest(await signedRequest(payload()), env, NOW)
    expect(res.status).toBe(202)
    expect(sent).toHaveLength(1)
    const job = sent[0].job
    expect(job).toMatchObject({ phase: 'send', runId: 'xrun_1', mapKey: 'thr:ch1:msg_root', message: 'Dong: hello bot' })
  })
  it('uses message.id as the thread key when parentId is empty', async () => {
    const { env, sent } = makeEnv()
    await handleRequest(await signedRequest(payload({ thread: { parentId: '' } })), env, NOW)
    expect((sent[0].job as { mapKey: string }).mapKey).toBe('thr:ch1:msg_1')
  })
  it('answers agent.ping 2xx on a valid signature', async () => {
    const { env, sent } = makeEnv()
    const res = await handleRequest(await signedRequest({ type: 'agent.ping' }), env, NOW)
    expect(res.status).toBe(200)
    expect(sent).toHaveLength(0)
  })
  it('rejects a bad signature, wrong secret, missing headers', async () => {
    const { env, sent } = makeEnv()
    expect((await handleRequest(await signedRequest(payload(), { secret: 'whsec_other' }), env, NOW)).status).toBe(401)
    expect((await handleRequest(await signedRequest(payload(), { sig: 'sha256=' + 'a'.repeat(64) }), env, NOW)).status).toBe(401)
    expect((await handleRequest(new Request('https://a.test/', { method: 'POST', body: '{}' }), env, NOW)).status).toBe(401)
    expect(sent).toHaveLength(0)
  })
  it('rejects a body tampered after signing', async () => {
    const { env } = makeEnv()
    const req = await signedRequest(payload())
    const tampered = new Request(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(payload({ message: { id: 'm', text: 'evil', author: { name: 'x' } } })) })
    expect((await handleRequest(tampered, env, NOW)).status).toBe(401)
  })
  it('rejects stale and future timestamps (+/-5 min)', async () => {
    const { env } = makeEnv()
    const old = String(Math.floor(NOW / 1000) - 301)
    const fut = String(Math.floor(NOW / 1000) + 301)
    const edge = String(Math.floor(NOW / 1000) - 299)
    expect((await handleRequest(await signedRequest(payload(), { ts: old }), env, NOW)).status).toBe(401)
    expect((await handleRequest(await signedRequest(payload(), { ts: fut }), env, NOW)).status).toBe(401)
    expect((await handleRequest(await signedRequest(payload({ runId: 'xrun_e' }), { ts: edge }), env, NOW)).status).toBe(202)
  })
  it('rejects a replayed event id', async () => {
    const { env, sent } = makeEnv()
    expect((await handleRequest(await signedRequest(payload()), env, NOW)).status).toBe(202)
    expect((await handleRequest(await signedRequest(payload()), env, NOW)).status).toBe(409)
    expect(sent).toHaveLength(1)
  })
  it('rejects non-https callback and callback outside the allowed origin', async () => {
    const { env } = makeEnv()
    expect((await handleRequest(await signedRequest(payload({ callbackUrl: 'http://ace.example.test/x' })), env, NOW)).status).toBe(400)
    const { env: e2 } = makeEnv({ ACE_CALLBACK_ORIGIN: 'https://ace.example.test' })
    expect((await handleRequest(await signedRequest(payload({ callbackUrl: 'https://evil.test/x', runId: 'r2' })), e2, NOW)).status).toBe(400)
    expect((await handleRequest(await signedRequest(payload({ runId: 'r3' })), e2, NOW)).status).toBe(202)
  })
  it('releases the replay mark if enqueue fails', async () => {
    const { env } = makeEnv()
    env.JOBS.send = async () => { throw new Error('queue down') }
    expect((await handleRequest(await signedRequest(payload()), env, NOW)).status).toBe(503)
    env.JOBS.send = async () => {}
    expect((await handleRequest(await signedRequest(payload()), env, NOW)).status).toBe(202)
  })
})
