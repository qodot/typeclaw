import type { SentryAdapterConfig } from '@/channels/schema'
import type { RecoveryAdapterCallbacks } from '@/channels/types'

import { recoveryMarker } from '../recovery-correlation'
import type { SentryClient } from './client'

export function createSentryRecoveryCallbacks(
  client: Pick<SentryClient, 'getSelf' | 'getIssue' | 'listComments'>,
  configRef: () => Pick<SentryAdapterConfig, 'organization' | 'projects'>,
  cachedAccountIdentity: () => string | undefined,
): RecoveryAdapterCallbacks {
  return {
    cachedAccountIdentity,
    async accountIdentity() {
      const self = await client.getSelf()
      if (!self.ok) throw new Error(self.error)
      return `sentry:${self.value.id}`
    },
    async reconcile(record) {
      const self = await client.getSelf()
      if (!self.ok) throw new Error(self.error)
      if (`sentry:${self.value.id}` !== (record.boundAccountIdentity ?? record.accountIdentity)) {
        throw new Error('recovery-account-identity-changed')
      }
      const config = configRef()
      const { workspace, chat, thread } = record.target
      const issueId = /^issue:(\d+)$/.exec(chat)?.[1]
      const project = workspace.slice(config.organization.length + 1)
      if (
        !workspace.startsWith(`${config.organization}/`) ||
        !config.projects.includes(project) ||
        !issueId ||
        thread !== null
      ) {
        throw new Error('invalid-recovery-sentry-target')
      }
      const issue = await client.getIssue(config.organization, issueId)
      if (!issue.ok) throw new Error(issue.error)
      if (issue.value.project.slug !== project) throw new Error('invalid-recovery-sentry-project')
      const marker = recoveryMarker(record.deliveryId)
      const seen = new Set<string>()
      let cursor: string | undefined
      do {
        const result = await client.listComments(config.organization, issueId, { limit: 100, cursor })
        if (!result.ok) throw new Error(result.error)
        const found = result.value.comments.find(
          (comment) => comment.user?.id === self.value.id && comment.data.text.includes(marker),
        )
        if (found) return { status: 'found', messageId: found.id }
        cursor = result.value.nextCursor
        if (cursor !== undefined) {
          if (seen.has(cursor)) throw new Error('recovery-history-cursor-loop')
          seen.add(cursor)
        }
      } while (cursor !== undefined)
      return { status: 'unknown' }
    },
  }
}
