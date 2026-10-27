import { describe, expect, test } from 'bun:test'

import type { SentryClient } from './client'
import { createSentryHistoryCallback } from './history'

describe('createSentryHistoryCallback', () => {
  test('댓글을 채널 기록으로 변환하고 페이지 커서를 보존한다', async () => {
    const history = createSentryHistoryCallback(client(), config)
    expect(await history({ chat: 'issue:42', thread: null, limit: 10 })).toEqual({
      ok: true,
      messages: [
        {
          externalMessageId: '1',
          authorId: '7',
          authorName: '사용자',
          text: '한글 댓글',
          ts: 1000,
          isBot: false,
          replyToBotMessageId: null,
        },
      ],
      nextCursor: 'cursor-2',
    })
    expect(await history({ chat: 'issue:42', thread: null, limit: 10, cursor: 'cursor-2' })).toEqual({
      ok: true,
      messages: [],
    })
  })

  test('다른 프로젝트와 잘못된 이슈 및 스레드를 거부한다', async () => {
    const api = client()
    const history = createSentryHistoryCallback(api, config)
    expect((await history({ chat: 'issue:42', thread: 'thread', limit: 10 })).ok).toBe(false)
    expect((await history({ chat: 'pr:42', thread: null, limit: 10 })).ok).toBe(false)
    api.getIssue = async () => ({ ok: true, value: { id: '42', title: '오류', project: { id: '2', slug: 'foreign' } } })
    expect((await history({ chat: 'issue:42', thread: null, limit: 10 })).ok).toBe(false)
  })

  test('조회 실패를 반환하고 시스템 댓글의 작성자를 표시한다', async () => {
    const api = client()
    const history = createSentryHistoryCallback(api, config)
    api.listComments = async () => ({
      ok: true,
      value: { comments: [{ id: '1', data: { text: '알림' }, dateCreated: '1970-01-01T00:00:01Z', user: null }] },
    })
    expect(await history({ chat: 'issue:42', thread: null, limit: 10 })).toMatchObject({
      ok: true,
      messages: [{ authorId: 'sentry', authorName: 'Sentry', isBot: true }],
    })
    const failure = { ok: false, error: 'HTTP 403' } as const
    api.listComments = async () => failure
    expect(await history({ chat: 'issue:42', thread: null, limit: 10 })).toEqual(failure)
    api.getIssue = async () => failure
    expect(await history({ chat: 'issue:42', thread: null, limit: 10 })).toEqual(failure)
  })
})

function config() {
  return { organization: 'acme', projects: ['backend'] }
}
function client(): Pick<SentryClient, 'getIssue' | 'listComments'> {
  return {
    getIssue: async () => ({ ok: true, value: { id: '42', title: '오류', project: { id: '1', slug: 'backend' } } }),
    listComments: async (_org, _id, options) => ({
      ok: true,
      value:
        options?.cursor === 'cursor-2'
          ? { comments: [] }
          : {
              comments: [
                {
                  id: '1',
                  data: { text: '한글 댓글' },
                  dateCreated: '1970-01-01T00:00:01Z',
                  user: { id: '7', name: '사용자' },
                },
              ],
              nextCursor: 'cursor-2',
            },
    }),
  }
}
