import { describe, expect, test } from 'bun:test'

import type { OutboundMessage } from '@/channels/types'

import { recoveryMarker } from '../recovery-correlation'
import type { SentryClient, SentryComment } from './client'
import { createSentryOutboundCallback } from './outbound'

describe('createSentryOutboundCallback', () => {
  test('등록한 프로젝트의 이슈에 댓글을 저장하고 메시지 식별자를 반환한다', async () => {
    const comments: SentryComment[] = []
    const send = createSentryOutboundCallback(client(comments), config)
    expect(await send(message())).toEqual({ ok: true, messageId: '1', messageIds: ['1'] })
    expect(comments[0]?.data.text).toBe('원인과 해결 방법')
  })

  test('다른 어댑터와 조직 및 프로젝트와 스레드 대상은 거부한다', async () => {
    const comments: SentryComment[] = []
    const send = createSentryOutboundCallback(client(comments), config)
    for (const changes of [
      { adapter: 'github' as const },
      { workspace: 'foreign/backend' },
      { workspace: 'acme/frontend' },
      { chat: 'pr:42' },
      { thread: 'thread-1' },
    ])
      expect((await send({ ...message(), ...changes })).ok).toBe(false)
    expect(comments).toEqual([])
  })

  test('이슈가 지정한 프로젝트와 다르면 댓글을 작성하지 않는다', async () => {
    const comments: SentryComment[] = []
    const api = client(comments)
    api.getIssue = async () => ({
      ok: true,
      value: { id: '42', title: '오류', project: { id: '2', slug: 'frontend' } },
    })
    expect((await createSentryOutboundCallback(api, config)(message())).ok).toBe(false)
    expect(comments).toEqual([])
  })

  test('빈 댓글과 첨부파일을 거부한다', async () => {
    const comments: SentryComment[] = []
    const send = createSentryOutboundCallback(client(comments), config)
    expect((await send({ ...message(), text: '  ' })).ok).toBe(false)
    expect((await send({ ...message(), attachments: [{ path: '/tmp/image.png' }] })).ok).toBe(false)
    expect(comments).toEqual([])
  })

  test('복구 대상 계정과 현재 계정이 다르면 댓글을 작성하지 않는다', async () => {
    const comments: SentryComment[] = []
    const api = client(comments)
    api.getSelf = async () => ({ ok: true, value: { id: 'other', name: '다른 사용자', username: 'other' } })
    const send = createSentryOutboundCallback(api, config)
    const recoveryMessage: OutboundMessage = {
      ...message(),
      sendOptions: {
        accounting: 'recovery',
        deliveryId: 'delivery-1',
        coveredIds: ['input-1'],
        expectedAccountIdentity: 'sentry:7',
      },
    }
    expect(await send(recoveryMessage)).toEqual({
      ok: false,
      error: 'recovery-account-identity-changed',
      recoveryFailure: { kind: 'identity', safeReason: 'Authenticated account changed' },
    })
    expect(comments).toEqual([])
  })

  test('복구 댓글에 전달 표식을 포함하고 생성 실패를 명시적으로 반환한다', async () => {
    const comments: SentryComment[] = []
    const api = client(comments)
    const send = createSentryOutboundCallback(api, config)
    const recoveryMessage: OutboundMessage = {
      ...message(),
      sendOptions: {
        accounting: 'recovery',
        deliveryId: 'delivery-1',
        coveredIds: ['input-1'],
        expectedAccountIdentity: 'sentry:7',
      },
    }
    expect(await send(recoveryMessage)).toEqual({ ok: true, messageId: '1', messageIds: ['1'] })
    expect(comments[0]?.data.text).toBe(`원인과 해결 방법\n\n${recoveryMarker('delivery-1')}`)
    const failure = { ok: false, error: 'HTTP 503' } as const
    api.createComment = async () => failure
    expect(await send(recoveryMessage)).toEqual(failure)
    expect(comments).toHaveLength(1)
  })

  test('복구 계정 조회 실패는 예외 없이 실패로 반환하고 댓글을 작성하지 않는다', async () => {
    const comments: SentryComment[] = []
    const api = client(comments)
    const failure = { ok: false, error: 'Sentry API GET failed (HTTP 503)' } as const
    api.getSelf = async () => failure
    const send = createSentryOutboundCallback(api, config)
    expect(
      await send({
        ...message(),
        sendOptions: {
          accounting: 'recovery',
          deliveryId: 'delivery-1',
          coveredIds: ['input-1'],
          expectedAccountIdentity: 'sentry:7',
        },
      }),
    ).toEqual(failure)
    expect(comments).toEqual([])
  })

  test('이슈 조회와 댓글 생성 실패를 반환한다', async () => {
    const failure = { ok: false, error: 'HTTP 403' } as const
    const api = client([])
    api.createComment = async () => failure
    expect(await createSentryOutboundCallback(api, config)(message())).toEqual(failure)
    api.getIssue = async () => failure
    expect(await createSentryOutboundCallback(api, config)(message())).toEqual(failure)
  })
})

function config() {
  return { organization: 'acme', projects: ['backend'] }
}
function message(): OutboundMessage {
  return { adapter: 'sentry', workspace: 'acme/backend', chat: 'issue:42', text: '원인과 해결 방법' }
}
function client(comments: SentryComment[]): Pick<SentryClient, 'getSelf' | 'getIssue' | 'createComment'> {
  return {
    getSelf: async () => ({ ok: true, value: { id: '7', name: '사용자', username: 'user' } }),
    getIssue: async () => ({ ok: true, value: { id: '42', title: '오류', project: { id: '1', slug: 'backend' } } }),
    createComment: async (_org, _id, text) => {
      const value = { id: '1', data: { text }, dateCreated: '2026-10-22T00:00:00Z', user: null }
      comments.push(value)
      return { ok: true, value }
    },
  }
}
