import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'

import { channelsSchema } from '@/channels/schema'
import type { InboundMessage } from '@/channels/types'

import { classifySentryWebhook, createSentryWebhookHandler } from './inbound'

describe('classifySentryWebhook', () => {
  test('한글 새 이슈를 조직과 프로젝트의 이슈 세션 메시지로 변환한다', () => {
    expect(classify(payload())).toMatchObject({
      adapter: 'sentry',
      workspace: 'acme/backend',
      chat: 'issue:42',
      thread: null,
      externalMessageId: 'delivery-1',
      eventKind: 'issue.created',
      authorId: 'sentry',
      authorIsBot: true,
      isBotMention: true,
      ts: 1000,
      text: '[issue.created] BACKEND-1: 한글 오류\nhttps://acme.sentry.io/issues/42/',
    })
  })

  test('재발과 해결은 처리하고 단순 재오픈은 제외한다', () => {
    expect(classify(payload('unresolved', 'regressed'))?.eventKind).toBe('issue.regressed')
    expect(classify(payload('resolved'))?.eventKind).toBe('issue.resolved')
    expect(classify(payload('unresolved', 'ongoing'))).toBeNull()
    expect(classify(payload('assigned'))).toBeNull()
  })

  test('다른 조직과 프로젝트 또는 허용하지 않은 이벤트는 제외한다', () => {
    const foreignOrg = payload()
    foreignOrg.data.issue.url = 'https://sentry.io/api/0/organizations/foreign/issues/42/'
    expect(classify(foreignOrg)).toBeNull()
    const foreignProject = payload()
    foreignProject.data.issue.project.slug = 'frontend'
    expect(classify(foreignProject)).toBeNull()
    expect(classify(payload(), ['issue.resolved'])).toBeNull()
    expect(classify(payload(), ['issue'])?.eventKind).toBe('issue.created')
  })

  test('사용자 식별자는 문자열로 정규화하고 다른 리소스와 잘못된 페이로드는 제외한다', () => {
    const human = { ...payload(), actor: { type: 'user', id: 7, name: '사용자' } }
    expect(classify(human)).toMatchObject({ authorId: '7', authorIsBot: false })
    expect(classify({})).toBeNull()
    expect(
      classifySentryWebhook({
        resource: 'comment',
        deliveryId: '1',
        timestamp: 0,
        payload: payload(),
        config: config(),
      }),
    ).toBeNull()
  })
})

describe('createSentryWebhookHandler', () => {
  test('서명된 원문을 전달하고 재전송된 요청은 중복 처리하지 않는다', async () => {
    const messages: InboundMessage[] = []
    const handler = createSentryWebhookHandler({
      webhookSecret: 'secret',
      configRef: config,
      logger,
      route: async (message) => {
        messages.push(message)
        return { kind: 'accepted', inputId: 'input-1', generation: 1 }
      },
    })
    expect((await handler(request())).status).toBe(200)
    expect((await handler(request())).status).toBe(200)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.ts).toBe(1000)
  })

  test('동시에 도착한 같은 요청도 한 번만 전달한다', async () => {
    const messages: InboundMessage[] = []
    const gate = Promise.withResolvers<void>()
    const handler = createSentryWebhookHandler({
      webhookSecret: 'secret',
      configRef: config,
      logger,
      route: async (message) => {
        messages.push(message)
        await gate.promise
        return { kind: 'accepted', inputId: 'input-1', generation: 1 }
      },
    })
    const first = handler(request())
    const second = handler(request())
    gate.resolve()
    expect((await Promise.all([first, second])).map((response) => response.status)).toEqual([200, 200])
    expect(messages).toHaveLength(1)
  })

  test('서명 오류와 본문 변조는 거부한다', async () => {
    const messages: InboundMessage[] = []
    const handler = createSentryWebhookHandler({
      webhookSecret: 'secret',
      configRef: config,
      logger,
      route: async (message) => {
        messages.push(message)
        return { kind: 'observed' }
      },
    })
    const unsigned = new Request('http://localhost/', { method: 'POST', body: JSON.stringify(payload()) })
    expect((await handler(unsigned)).status).toBe(401)
    const altered = request()
    altered.headers.set('sentry-hook-signature', '0'.repeat(64))
    expect((await handler(altered)).status).toBe(401)
    expect(messages).toEqual([])
  })

  test('잘못된 메서드와 JSON을 거부하고 대상 외 이벤트에는 성공을 반환한다', async () => {
    const handler = createSentryWebhookHandler({
      webhookSecret: 'secret',
      configRef: config,
      logger,
      route: async () => ({ kind: 'observed' }),
    })
    expect((await handler(new Request('http://localhost/'))).status).toBe(405)
    expect((await handler(request('{'))).status).toBe(400)
    expect((await handler(request(JSON.stringify(payload('assigned'))))).status).toBe(200)
  })

  test('전달 실패 후 같은 요청을 다시 처리할 수 있다', async () => {
    let unavailable = true
    const delivered: InboundMessage[] = []
    const handler = createSentryWebhookHandler({
      webhookSecret: 'secret',
      configRef: config,
      logger,
      route: async (message) => {
        if (unavailable) throw new Error('queue unavailable')
        delivered.push(message)
        return { kind: 'accepted', inputId: 'input-1', generation: 1 }
      },
    })
    expect((await handler(request())).status).toBe(503)
    unavailable = false
    expect((await handler(request())).status).toBe(200)
    expect(delivered).toHaveLength(1)
  })
})

const logger = { warn: () => {}, error: () => {} }

function config() {
  return channelsSchema.parse({ sentry: { organization: 'acme', integration: 'typeclaw', projects: ['backend'] } })
    .sentry!
}

function classify(value: unknown, eventAllowlist = ['issue.created', 'issue.regressed', 'issue.resolved']) {
  return classifySentryWebhook({
    resource: 'issue',
    deliveryId: 'delivery-1',
    timestamp: 1000,
    payload: value,
    config: { ...config(), eventAllowlist },
  })
}

function payload(action = 'created', substatus = 'new') {
  return {
    action,
    installation: { uuid: 'installation-1' },
    actor: { type: 'application', id: 'sentry', name: 'Sentry' },
    data: {
      issue: {
        id: '42',
        shortId: 'BACKEND-1',
        title: '한글 오류',
        substatus,
        url: 'https://sentry.io/api/0/organizations/acme/issues/42/',
        web_url: 'https://acme.sentry.io/issues/42/',
        project: { slug: 'backend' },
      },
    },
  }
}

function request(body = JSON.stringify(payload())) {
  return new Request('http://localhost/', {
    method: 'POST',
    body,
    headers: {
      'sentry-hook-signature': createHmac('sha256', 'secret').update(body).digest('hex'),
      'sentry-hook-resource': 'issue',
      'request-id': 'delivery-1',
      'sentry-hook-timestamp': '1',
    },
  })
}
