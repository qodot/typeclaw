import { describe, expect, test } from 'bun:test'

import type { SentryClient, SentryIntegration } from './client'
import { registerSentryWebhook } from './webhook-register'

describe('registerSentryWebhook', () => {
  test('기존 구독은 보존하면서 새 웹훅 주소와 이슈 구독을 저장한다', async () => {
    let integration = fixture()
    const client: Pick<SentryClient, 'getIntegration' | 'updateIntegration'> = {
      getIntegration: async () => ({ ok: true, value: integration }),
      updateIntegration: async (_slug, input) => {
        integration = { ...integration, ...input }
        return { ok: true, value: integration }
      },
    }
    const result = await registerSentryWebhook(client, options())
    expect(result).toEqual({ ok: true, value: { webhookUrl: options().webhookUrl } })
    expect(integration.events).toEqual(['comment', 'issue'])
    expect(integration.webhookUrl).toBe(options().webhookUrl)
    expect(await registerSentryWebhook(client, options())).toEqual(result)
    expect(integration.events).toEqual(['comment', 'issue'])
  })

  test('소유 조직이 다르면 통합 설정을 변경하지 않는다', async () => {
    let integration = { ...fixture(), owner: { slug: 'foreign' } }
    const client: Pick<SentryClient, 'getIntegration' | 'updateIntegration'> = {
      getIntegration: async () => ({ ok: true, value: integration }),
      updateIntegration: async (_slug, input) => {
        integration = { ...integration, ...input }
        return { ok: true, value: integration }
      },
    }
    expect((await registerSentryWebhook(client, options())).ok).toBe(false)
    expect(integration.webhookUrl).toBe('https://old.example.com')
  })

  test('조회 실패와 갱신 실패를 그대로 반환한다', async () => {
    const failure = { ok: false, error: 'HTTP 403' } as const
    expect(
      await registerSentryWebhook(
        { getIntegration: async () => failure, updateIntegration: async () => failure },
        options(),
      ),
    ).toEqual(failure)
    expect(
      await registerSentryWebhook(
        { getIntegration: async () => ({ ok: true, value: fixture() }), updateIntegration: async () => failure },
        options(),
      ),
    ).toEqual(failure)
  })

  test('서버 응답에 새 주소나 이슈 구독이 없으면 실패한다', async () => {
    const client: Pick<SentryClient, 'getIntegration' | 'updateIntegration'> = {
      getIntegration: async () => ({ ok: true, value: fixture() }),
      updateIntegration: async () => ({ ok: true, value: fixture() }),
    }
    expect((await registerSentryWebhook(client, options())).ok).toBe(false)
    client.updateIntegration = async () => ({ ok: true, value: { ...fixture(), webhookUrl: options().webhookUrl } })
    expect((await registerSentryWebhook(client, options())).ok).toBe(false)
  })
})

function options() {
  return { organization: 'acme', integration: 'typeclaw', webhookUrl: 'https://new.example.com' }
}
function fixture(): SentryIntegration {
  return {
    slug: 'typeclaw',
    uuid: 'uuid',
    name: 'TypeClaw',
    scopes: ['event:read'],
    events: ['comment'],
    webhookUrl: 'https://old.example.com',
    owner: { slug: 'acme' },
  }
}
