import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import { z } from 'zod'

import type { SentryAdapterConfig } from '@/channels/schema'
import type { InboundMessage, RouteReceipt } from '@/channels/types'

export type SentryWebhookHandlerOptions = {
  webhookSecret: string
  configRef: () => SentryAdapterConfig
  route: (message: InboundMessage) => Promise<RouteReceipt>
  logger: { warn: (message: string) => void; error: (message: string) => void }
}

export function createSentryWebhookHandler(options: SentryWebhookHandlerOptions): (req: Request) => Promise<Response> {
  const deliveries = new Map<string, Promise<Response>>()
  return async (request) => {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
    const body = await request.text()
    const signature = request.headers.get('sentry-hook-signature') ?? ''
    const expected = createHmac('sha256', options.webhookSecret).update(body).digest()
    if (!/^[a-fA-F0-9]{64}$/.test(signature) || !timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
      options.logger.warn('[sentry] 웹훅 서명 검증 실패')
      return new Response('bad signature', { status: 401 })
    }
    let payload: unknown
    try {
      payload = JSON.parse(body)
    } catch {
      return new Response('invalid json', { status: 400 })
    }
    const deliveryId = request.headers.get('request-id') || createHash('sha256').update(body).digest('hex')
    const message = classifySentryWebhook({
      resource: request.headers.get('sentry-hook-resource') ?? '',
      deliveryId,
      timestamp: Number(request.headers.get('sentry-hook-timestamp') ?? 0) * 1000,
      payload,
      config: options.configRef(),
    })
    if (message === null) return new Response('ok')
    const pending = deliveries.get(deliveryId)
    if (pending !== undefined) return (await pending).clone()
    const routed = options.route(message).then(
      () => new Response('ok'),
      () => {
        deliveries.delete(deliveryId)
        options.logger.error('[sentry] 이벤트 전달 실패, Sentry 재전송을 기다립니다')
        return new Response('delivery failed', { status: 503 })
      },
    )
    deliveries.set(deliveryId, routed)
    const response = await routed
    while (deliveries.size > 1000) deliveries.delete(deliveries.keys().next().value!)
    return response.clone()
  }
}

export function classifySentryWebhook(input: {
  resource: string
  deliveryId: string
  timestamp: number
  payload: unknown
  config: Pick<SentryAdapterConfig, 'organization' | 'projects' | 'eventAllowlist' | 'integration'>
}): InboundMessage | null {
  if (input.resource !== 'issue') return null
  const parsed = issueWebhookSchema.safeParse(input.payload)
  if (!parsed.success) return null
  const { action, data, actor } = parsed.data
  const issue = data.issue
  const organization = new URL(issue.url).pathname.match(/^\/api\/0\/organizations\/([^/]+)\/issues\/[^/]+\/$/)?.[1]
  if (organization !== input.config.organization || !input.config.projects.includes(issue.project.slug)) return null
  const event = action === 'unresolved' && issue.substatus === 'regressed' ? 'issue.regressed' : `issue.${action}`
  if (!['issue.created', 'issue.regressed', 'issue.resolved'].includes(event)) return null
  if (!input.config.eventAllowlist.includes(event) && !input.config.eventAllowlist.includes('issue')) return null
  return {
    adapter: 'sentry',
    workspace: `${organization}/${issue.project.slug}`,
    chat: `issue:${issue.id}`,
    thread: null,
    text: [
      `[${event}] ${issue.shortId ?? issue.id}: ${issue.title}`,
      issue.web_url ?? issue.permalink ?? issue.url,
    ].join('\n'),
    externalMessageId: input.deliveryId,
    eventKind: event,
    revision: 'original',
    authorId: String(actor.id),
    authorName: actor.name,
    authorIsBot: actor.type === 'application',
    isBotMention: true,
    suppressSticky: true,
    replyToBotMessageId: null,
    replyToOtherMessageId: null,
    mentionsOthers: false,
    isDm: false,
    ts: Number.isFinite(input.timestamp) ? input.timestamp : 0,
  }
}

const issueWebhookSchema = z.object({
  action: z.string(),
  actor: z.object({ id: z.union([z.string(), z.number()]), name: z.string(), type: z.string() }),
  data: z.object({
    issue: z.object({
      id: z.string().regex(/^\d+$/),
      title: z.string(),
      shortId: z.string().optional(),
      substatus: z.string().nullable().optional(),
      url: z.string().url(),
      web_url: z.string().url().optional(),
      permalink: z.string().url().optional(),
      project: z.object({ slug: z.string() }),
    }),
  }),
})
