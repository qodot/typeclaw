import type { SentryClient, SentryResult } from './client'

export async function registerSentryWebhook(
  client: Pick<SentryClient, 'getIntegration' | 'updateIntegration'>,
  options: { integration: string; organization: string; webhookUrl: string },
): Promise<SentryResult<{ webhookUrl: string }>> {
  const current = await client.getIntegration(options.integration)
  if (!current.ok) return current
  if (current.value.owner?.slug !== options.organization) {
    return { ok: false, error: 'Sentry 통합의 소유 조직이 channels.sentry.organization과 다릅니다' }
  }
  const events = [...new Set([...current.value.events, 'issue'])]
  const updated = await client.updateIntegration(options.integration, { webhookUrl: options.webhookUrl, events })
  if (!updated.ok) return updated
  if (updated.value.webhookUrl !== options.webhookUrl || !updated.value.events.includes('issue')) {
    return { ok: false, error: 'Sentry 응답에 요청한 웹훅 URL 또는 issue 구독이 반영되지 않았습니다' }
  }
  return { ok: true, value: { webhookUrl: options.webhookUrl } }
}
