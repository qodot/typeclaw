import type { SentryAdapterConfig } from '@/channels/schema'
import type { HistoryCallback } from '@/channels/types'

import type { SentryClient } from './client'

export function createSentryHistoryCallback(
  client: Pick<SentryClient, 'getIssue' | 'listComments'>,
  configRef: () => Pick<SentryAdapterConfig, 'organization' | 'projects'>,
): HistoryCallback {
  return async (args) => {
    const config = configRef()
    const issueId = /^issue:(\d+)$/.exec(args.chat)?.[1]
    if (issueId === undefined || args.thread !== null) return { ok: false, error: '잘못된 Sentry 이슈 대상입니다' }
    const issue = await client.getIssue(config.organization, issueId)
    if (!issue.ok) return issue
    if (!config.projects.includes(issue.value.project.slug))
      return { ok: false, error: '등록하지 않은 Sentry 프로젝트입니다' }
    const result = await client.listComments(config.organization, issueId, { limit: args.limit, cursor: args.cursor })
    if (!result.ok) return result
    return {
      ok: true,
      messages: result.value.comments.map((comment) => ({
        externalMessageId: comment.id,
        authorId: comment.user?.id ?? 'sentry',
        authorName: comment.user?.name ?? comment.user?.username ?? 'Sentry',
        text: comment.data.text,
        ts: Date.parse(comment.dateCreated) || 0,
        isBot: comment.user === null,
        replyToBotMessageId: null,
      })),
      ...(result.value.nextCursor !== undefined ? { nextCursor: result.value.nextCursor } : {}),
    }
  }
}
