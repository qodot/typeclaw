import { describe, expect, test } from 'bun:test'

import type { RecoveryRecord } from '@/channels/continuity-types'

import { recoveryMarker } from '../recovery-correlation'
import type { SentryClient } from './client'
import { createSentryRecoveryCallbacks } from './recovery'

describe('createSentryRecoveryCallbacks', () => {
  test('실제 토큰 사용자와 캐시된 계정 식별자를 반환한다', async () => {
    const callbacks = createSentryRecoveryCallbacks(client(), config, () => 'sentry:7')
    expect(await callbacks.accountIdentity()).toBe('sentry:7')
    expect(callbacks.cachedAccountIdentity?.()).toBe('sentry:7')
  })

  test('다음 페이지에서 자기 계정이 작성한 전달 표식을 찾는다', async () => {
    const api = client()
    api.listComments = async (_organization, _issueId, options) => ({
      ok: true,
      value:
        options?.cursor === 'page-2'
          ? { comments: [comment('self', '7')] }
          : { comments: [comment('foreign', '8')], nextCursor: 'page-2' },
    })
    expect(await createSentryRecoveryCallbacks(api, config, () => 'sentry:7').reconcile(record())).toEqual({
      status: 'found',
      messageId: 'self',
    })
  })

  test('다른 계정의 전달 표식은 성공으로 간주하지 않는다', async () => {
    const api = client()
    api.listComments = async () => ({ ok: true, value: { comments: [comment('foreign', '8')] } })
    expect(await createSentryRecoveryCallbacks(api, config, () => 'sentry:7').reconcile(record())).toEqual({
      status: 'unknown',
    })
  })

  test('계정 변경과 등록하지 않은 대상은 복구를 거부한다', async () => {
    const callbacks = createSentryRecoveryCallbacks(client(), config, () => 'sentry:7')
    await expect(callbacks.reconcile({ ...record(), accountIdentity: 'sentry:8' })).rejects.toThrow(
      'recovery-account-identity-changed',
    )
    for (const target of [
      { ...record().target, workspace: 'foreign/backend' },
      { ...record().target, workspace: 'acme/frontend' },
      { ...record().target, thread: 'thread-1' },
      { ...record().target, chat: 'issue:other' },
    ])
      await expect(callbacks.reconcile({ ...record(), target })).rejects.toThrow('invalid-recovery-sentry-target')
    const api = client()
    api.getIssue = async () => ({
      ok: true,
      value: { id: '42', title: '오류', project: { id: '2', slug: 'frontend' } },
    })
    await expect(createSentryRecoveryCallbacks(api, config, () => 'sentry:7').reconcile(record())).rejects.toThrow(
      'invalid-recovery-sentry-project',
    )
  })

  test('계정과 이슈 및 댓글 조회 실패를 복구 성공으로 간주하지 않는다', async () => {
    const failure = { ok: false, error: 'HTTP 403' } as const
    const api = client()
    const callbacks = createSentryRecoveryCallbacks(api, config, () => 'sentry:7')
    api.listComments = async () => failure
    await expect(callbacks.reconcile(record())).rejects.toThrow('HTTP 403')
    api.getIssue = async () => failure
    await expect(callbacks.reconcile(record())).rejects.toThrow('HTTP 403')
    api.getSelf = async () => failure
    await expect(callbacks.reconcile(record())).rejects.toThrow('HTTP 403')
    await expect(callbacks.accountIdentity()).rejects.toThrow('HTTP 403')
  })

  test('반복된 페이지 커서는 중단하고 복구 실패를 반환한다', async () => {
    const api = client()
    api.listComments = async () => ({ ok: true, value: { comments: [], nextCursor: 'same' } })
    await expect(createSentryRecoveryCallbacks(api, config, () => 'sentry:7').reconcile(record())).rejects.toThrow(
      'recovery-history-cursor-loop',
    )
  })
})

function config() {
  return { organization: 'acme', projects: ['backend'] }
}
function comment(id: string, userId: string) {
  return {
    id,
    user: { id: userId },
    data: { text: `복구 안내\n${recoveryMarker('delivery-1')}` },
    dateCreated: '2026-10-22T00:00:00Z',
  }
}
function client(): Pick<SentryClient, 'getSelf' | 'getIssue' | 'listComments'> {
  return {
    getSelf: async () => ({ ok: true, value: { id: '7', name: '사용자', username: 'user' } }),
    getIssue: async () => ({ ok: true, value: { id: '42', title: '오류', project: { id: '1', slug: 'backend' } } }),
    listComments: async () => ({ ok: true, value: { comments: [] } }),
  }
}
function record(): RecoveryRecord {
  return {
    schemaVersion: 1,
    deliveryId: 'delivery-1',
    purpose: 'interruption-notice',
    target: { adapter: 'sentry', workspace: 'acme/backend', chat: 'issue:42', thread: null },
    accountIdentity: 'sentry:7',
    principal: {
      kind: 'channel',
      adapter: 'sentry',
      workspace: 'acme/backend',
      chat: 'issue:42',
      lastInboundAuthorId: 'sentry',
    },
    covers: [],
    transferId: 'transfer-1',
    recoveryGeneration: 'generation-1',
    templateVersion: 1,
    locale: 'en',
    text: 'recovery',
    createdAt: 1,
    generation: 1,
    state: 'pending',
    attempts: 0,
  }
}
