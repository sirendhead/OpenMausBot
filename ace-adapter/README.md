# mausbot-ace-adapter

A small Cloudflare Worker that lets a self-hosted OpenMausBot bot act as an
**ACE external webhook agent** (contract C, ace-desktop #1040 / engine #1522 E-B).
ACE keeps one protocol; the adapter translates to the MausBot Bot API.

This branch (`ace-adapter`) is an orphan branch holding only this directory. It contains
no MausBot code. Do not run MausBot install scripts from here.

## Architecture

```
ACE channel (human @mention)
   |  POST agent.invoke   X-Webhook-Timestamp / X-Webhook-Signature / X-Webhook-Event-Id
   v
Worker fetch()  -- verify HMAC (constant time, +/-5 min), replay guard (KV), 202 ack
   |  enqueue job
   v
Queue consumer  -- one step per invocation, re-enqueues itself with delaySeconds
   |  POST /hooks/api/bots/<id>/messages   (Bearer + CF-Access service token)
   |  200 reply | 202 working -> poll GET ?thread= (5s,10s,20s,30s...) | 202 needs_approval
   v
signed callback  POST <callbackUrl>  {status:'completed'|'failed', text}
```

- Signature: `X-Webhook-Signature: sha256=HMAC_SHA256(secret, "<ts>.<rawBody>")`, the same scheme
  as the engine's `signWebhookTs` / `verifyDispatchSignature`. Tests include a copy of the
  engine verifier logic and a fixed vector.
- `agent.ping` (E-A test event) answers 200 on a valid signature.
- Thread mapping: ACE `thread.parentId` (or `message.id`) <-> MausBot `thread`, in KV
  (`thr:<channelId>:<parentId>`, 30 days). If continuing a thread returns 404, a new one starts.
- The message sent to MausBot is `"<author name>: <text>"` as plain data, with no extra instructions.
- A Queue (not `waitUntil`) drives polling because `waitUntil` work is cut off about 30 s after the
  response; Queue delays can wait until `expiresAt` (30 min in ACE).

### Outcome mapping

| MausBot / network | Adapter result |
|---|---|
| 200 `{reply}` | callback `completed` with the reply |
| 202 `working` | poll with backoff; stop 10 s before `expiresAt` -> `failed` (honest timeout text) |
| 202 `needs_approval` | callback `completed`: "Waiting for approval in MausBot: <link or thread id>". Approval happens in MausBot, not ACE; the eventual reply is NOT posted to ACE |
| 409 busy / 429 | retry with backoff (honours `Retry-After`) within the deadline, then `failed` |
| 401 / 403 / 502 (JSON) / 400 / 413 / 415 | `failed`, short reason, no retry |
| Cloudflare Access 403, or 302 to `*.cloudflareaccess.com` | `failed` (Access refused; check the service token), no retry, redirect never followed |
| Tunnel down: 521/522/523/524/530, or 502 with a non-JSON (HTML) body | retry 15s/30s/60s inside the deadline, then `failed`: "MausBot host is offline" |
| Network error on the first POST | `failed`; NOT resent, because the message may already have been taken |

Logs: the Worker logs no message bodies or secrets.

## Hosting model (best-effort)

MausBot runs on the operator's Mac mini behind a **Cloudflare Tunnel**, protected by
**Cloudflare Access** with a **service-token policy**. The host is best-effort: if the Mac is
asleep or the tunnel is down, runs end as `failed` ("bot host offline") once the 30 min ACE
deadline passes. Nothing is queued beyond that.

### Tunnel + Access setup

1. On the Mac mini, run `cloudflared` as a service with a tunnel routing a hostname
   (e.g. `mausbot.example.com`) to MausBot's local port. Only the `/hooks/*` path needs exposing.
2. Zero Trust -> Access -> Service Auth -> **Create service token**. Copy the Client ID and
   Client Secret once (the secret is shown once).
3. Zero Trust -> Access -> Applications -> add a self-hosted app for that hostname with a policy
   **Action: Service Auth**, including that service token. No other policy.
4. In MausBot, enable **Let apps talk to this bot** (Bot settings, Advanced: Access) and keep the
   key. Needs a plan/AI that can run confined (see MausBot `docs/bot-api.md`).
5. Verify: `curl -i https://mausbot.example.com/hooks/api/bots/<id>/messages` without headers should
   be refused by Access (302/403); with the two `CF-Access-Client-*` headers + Bearer key it should
   reach MausBot.

## Deploy (operator, after TASK-5434 and engine E-B are live in prod)

```sh
cd ace-adapter
npm install --ignore-scripts
npx wrangler kv namespace create STATE         # copy the id into wrangler.jsonc
npx wrangler queues create mausbot-ace-jobs
# edit wrangler.jsonc vars: MAUSBOT_BASE_URL, MAUSBOT_BOT_ID, ACE_CALLBACK_ORIGIN
```

Secrets: set from ColorVault labels, never paste values into chat or commits. Pipe each value in
(for example via `vault_exec` running a `.cjs` that reads `process.env` and pipes to wrangler):

```sh
npx wrangler secret put ACE_XA_BINDING_SECRET     # the whsec_... shown once at ACE invite time
npx wrangler secret put MAUSBOT_BOT_API_KEY       # the Bot API key from MausBot
npx wrangler secret put CF_ACCESS_CLIENT_ID       # Access service token
npx wrangler secret put CF_ACCESS_CLIENT_SECRET
```

Pick/create ColorVault labels for these four (suggested: `MAUSBOT_ACE_XA_BINDING_SECRET`,
`MAUSBOT_BOT_API_KEY`, `MAUSBOT_CF_ACCESS_CLIENT_ID`, `MAUSBOT_CF_ACCESS_CLIENT_SECRET`).

Then `npx wrangler deploy`, put the public Worker URL (`https://<worker>/`) as the
`endpointUrl` when inviting the agent in ACE (https only), and use the invite's one-time
`whsec_` as `ACE_XA_BINDING_SECRET`. Use ACE's agent test (`agent.ping`) to confirm.

Vars: `MAUSBOT_BASE_URL`, `MAUSBOT_BOT_ID`; optional `ACE_CALLBACK_ORIGIN` (reject callbacks to
any other origin), `MAUSBOT_THREAD_URL_TEMPLATE` (e.g. `https://host/threads/{thread}`),
`MAUSBOT_WAIT_SEC` (first-call wait, default 25).

## Develop

```sh
npm install --ignore-scripts
npm run typecheck
npm test
```

## Limits

- One reply per invocation; ACE contract C has no interim status events, so "working" is silent.
- `needs_approval` ends the ACE run; the post-approval answer stays in MausBot.
- Replay guard uses KV (eventually consistent): best-effort, backed by the 5 min timestamp window.
- MausBot Bot API: 20,000-char message cap, 10 calls/min per key, only API-opened threads can be
  continued, confined/Ask mode with no tools, and a single bot key (all ACE users share it).
  ACE text is capped at 4000 chars by the engine.
- The GET-poll response shape (200 `{reply,thread}` / 202 `{thread,status}`) is taken from MausBot
  source (`server/bot-api-host.ts`), not a documented contract.
- Best-effort host (Mac mini + tunnel); no HA.
- Not deployed from this repo's CI; deployment is manual by the operator.
