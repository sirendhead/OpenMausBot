// Minimal Cloudflare binding shapes so the project needs no extra type packages.
export interface KV {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}
export interface Queue<T> {
  send(body: T, opts?: { delaySeconds?: number }): Promise<void>
}
export interface Env {
  STATE: KV
  JOBS: Queue<Job>
  // secrets (wrangler secret put)
  ACE_XA_BINDING_SECRET: string
  MAUSBOT_BOT_API_KEY: string
  CF_ACCESS_CLIENT_ID: string
  CF_ACCESS_CLIENT_SECRET: string
  // vars
  MAUSBOT_BASE_URL: string
  MAUSBOT_BOT_ID: string
  /** Optional: if set, callbackUrl must start with this origin. */
  ACE_CALLBACK_ORIGIN?: string
  /** Optional: e.g. https://host/threads/{thread}; used in the needs_approval note. */
  MAUSBOT_THREAD_URL_TEMPLATE?: string
  /** Optional: seconds MausBot holds the first call open (1-120, default 25). */
  MAUSBOT_WAIT_SEC?: string
}

/** ACE contract C: agent.invoke body (engine external-agent-sender.ts). */
export interface InvokePayload {
  type: 'agent.invoke'
  runId: string
  traceId: string | null
  channel: { id: string; slug: string }
  thread: { parentId: string }
  message: { id: string; text: string; author: { name: string } }
  callbackUrl: string
  expiresAt: string
}

export interface CallbackBody {
  status: 'completed' | 'failed'
  text: string
}

export type Job =
  | { phase: 'send'; runId: string; callbackUrl: string; expiresAt: string; mapKey: string; message: string; attempt: number }
  | { phase: 'poll'; runId: string; callbackUrl: string; expiresAt: string; mapKey: string; thread: string; attempt: number }
  | { phase: 'callback'; runId: string; callbackUrl: string; expiresAt: string; result: CallbackBody; attempt: number }

export type Step = { next: Job; delaySeconds: number } | null
