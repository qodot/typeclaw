import type { SentryAdapterConfig } from '@/channels/schema'
import type { OutboundCallback } from '@/channels/types'

import { recoveryMarker } from '../recovery-correlation'
import type { SentryClient } from './client'

export function createSentryOutboundCallback(
  client: Pick<SentryClient, 'getSelf' | 'getIssue' | 'createComment'>,
  configRef: () => Pick<SentryAdapterConfig, 'organization' | 'projects'>,
): OutboundCallback {
  return async (message) => {
    const config = configRef()
    const project = message.workspace.slice(config.organization.length + 1)
    const issueId = /^issue:(\d+)$/.exec(message.chat)?.[1]
    if (
      message.adapter !== 'sentry' ||
      !message.workspace.startsWith(`${config.organization}/`) ||
      !config.projects.includes(project) ||
      issueId === undefined ||
      message.thread != null
    )
      return { ok: false, error: '등록한 Sentry 프로젝트의 이슈만 대상으로 지정할 수 있습니다' }
    if ((message.attachments?.length ?? 0) > 0)
      return { ok: false, error: 'Sentry 댓글은 첨부파일을 지원하지 않습니다' }
    if (!message.text?.trim()) return { ok: false, error: 'Sentry 댓글 내용이 비어 있습니다' }
    const issue = await client.getIssue(config.organization, issueId)
    if (!issue.ok) return issue
    if (issue.value.project.slug !== project)
      return { ok: false, error: 'Sentry 이슈가 대상 프로젝트에 속하지 않습니다' }
    const recovery = message.sendOptions?.accounting === 'recovery' ? message.sendOptions : undefined
    if (recovery) {
      const self = await client.getSelf()
      if (!self.ok) return self
      if (`sentry:${self.value.id}` !== recovery.expectedAccountIdentity)
        return {
          ok: false,
          error: 'recovery-account-identity-changed',
          recoveryFailure: { kind: 'identity', safeReason: 'Authenticated account changed' },
        }
    }
    const text = message.text + (recovery ? `\n\n${recoveryMarker(recovery.deliveryId)}` : '')
    const result = await client.createComment(config.organization, issueId, text)
    return result.ok ? { ok: true, messageId: result.value.id, messageIds: [result.value.id] } : result
  }
}
