import { expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentSession } from '@/agent'
import { InboundJournal } from '@/channels/inbound-journal'
import { createChannelRouter } from '@/channels/router'
import { channelsSchema } from '@/channels/schema'
import { createPermissionService, rolesConfigSchema } from '@/permissions'

import { createSentryAdapter } from './index'

test('실제 HTTP 수신이 공통 저널과 이슈별 세션으로 이어지고 중복을 제거한다', async () => {
  const trial = await fixture()
  try {
    await trial.adapter.start()
    expect((await trial.deliver('a', '42')).status).toBe(200)
    expect((await trial.deliver('a', '42')).status).toBe(200)
    expect((await trial.deliver('b', '43')).status).toBe(200)
    expect(
      trial.journal
        .list()
        .filter((row) => row.phase !== 'closed')
        .map((row) => row.target.chat)
        .sort(),
    ).toEqual(['issue:42', 'issue:43'])
    expect(trial.sessions.sort()).toEqual(['issue:42', 'issue:43'])
    expect(
      trial.journal
        .list()
        .filter((row) => row.phase !== 'closed')
        .every((row) => row.accountIdentity === 'sentry:bot'),
    ).toBe(true)
    expect(trial.adapter.isConnected()).toBe(true)
  } finally {
    await trial.stop()
  }
})

test('서명이 틀리거나 채널 응답 권한이 없으면 세션과 저널을 만들지 않는다', async () => {
  const trial = await fixture({ allowed: false })
  try {
    await trial.adapter.start()
    expect((await trial.deliver('bad', '42', 'wrong-secret')).status).toBe(401)
    expect((await trial.deliver('denied', '42')).status).toBe(200)
    expect(trial.sessions).toEqual([])
    expect(trial.journal.list()).toEqual([])
  } finally {
    await trial.stop()
  }
})

test('재시작으로 변경된 터널 주소를 반영하고 종료해도 Sentry 통합은 삭제하지 않는다', async () => {
  const trial = await fixture()
  try {
    await trial.adapter.start()
    expect(trial.integration().webhookUrl).toBe('https://first.trycloudflare.com')
    expect((await trial.deliver('before-restart', '42')).status).toBe(200)
    await trial.adapter.stop()
    expect(trial.adapter.isConnected()).toBe(false)
    trial.recreateAdapter()
    trial.setTunnelUrl('https://second.trycloudflare.com')
    await trial.adapter.start()
    expect(trial.integration().webhookUrl).toBe('https://second.trycloudflare.com')
    expect(trial.integration().events).toEqual(['error', 'issue'])
    expect((await trial.deliver('before-restart', '42')).status).toBe(200)
    expect(trial.journal.list()).toHaveLength(1)
    expect((await trial.deliver('after-restart', '43')).status).toBe(200)
    expect(trial.journal.list()).toHaveLength(2)
    expect(trial.deleted()).toBe(false)
  } finally {
    await trial.stop()
  }
})

test('명시한 웹훅 URL이 터널보다 우선하고 공통 라우터에서 댓글을 보낼 수 있다', async () => {
  const trial = await fixture({ webhookUrl: 'https://fixed.example.com/sentry' })
  try {
    await trial.adapter.start()
    expect(trial.integration().webhookUrl).toBe('https://fixed.example.com/sentry')
    const sent = await trial.router.send({
      adapter: 'sentry',
      workspace: 'acme/backend',
      chat: 'issue:42',
      thread: null,
      text: '원인을 찾았습니다',
    })
    expect(sent.ok).toBe(true)
    expect(trial.comments()).toEqual(['원인을 찾았습니다'])
  } finally {
    await trial.stop()
  }
})

test('웹훅 등록이 실패해도 수신 서버는 유지하고 원인을 운영 로그에 남긴다', async () => {
  const trial = await fixture({ registrationDenied: true })
  try {
    await trial.adapter.start()
    expect(trial.adapter.isConnected()).toBe(true)
    expect(trial.logs.some((line) => line.includes('HTTP 403') && line.includes('org:write'))).toBe(true)
    expect((await trial.deliver('existing-hook', '42')).status).toBe(200)
    expect(trial.journal.list()).toHaveLength(1)
  } finally {
    await trial.stop()
  }
})

test('앱 토큰만으로 이슈 생명주기와 댓글을 처리하고 재시작해도 중복 전달을 보존한다', async () => {
  const webhookUrl = 'https://fixed.example.com/sentry'
  const trial = await fixture({ authType: 'app', webhookUrl, registrationDenied: true })
  try {
    await trial.adapter.start()
    expect(trial.adapter.isConnected()).toBe(true)
    expect((await trial.deliver('created', '42')).status).toBe(200)
    expect((await trial.deliver('regressed', '43', 'test-secret', 'regressed')).status).toBe(200)
    expect((await trial.deliver('resolved', '44', 'test-secret', 'resolved')).status).toBe(200)
    expect(trial.sessions.sort()).toEqual(['issue:42', 'issue:43', 'issue:44'])
    expect(trial.journal.list()).toHaveLength(3)
    expect(
      await trial.router.send({
        adapter: 'sentry',
        workspace: 'acme/backend',
        chat: 'issue:42',
        thread: null,
        text: '앱 인증으로 원인을 찾았습니다',
      }),
    ).toMatchObject({ ok: true, messageId: '100' })
    expect(await trial.router.fetchHistory('sentry', { chat: 'issue:42', thread: null, limit: 10 })).toMatchObject({
      ok: true,
      messages: [{ authorId: 'bot', text: '앱 인증으로 원인을 찾았습니다' }],
    })
    await trial.adapter.stop()
    trial.recreateAdapter()
    await trial.adapter.start()
    expect((await trial.deliver('created', '42')).status).toBe(200)
    expect(trial.journal.list()).toHaveLength(3)
    expect(trial.integration().webhookUrl).toBe('')
    expect(trial.integration().events).toEqual(['error'])
    expect(trial.logs.some((line) => line.includes(webhookUrl) && line.includes('직접'))).toBe(true)
    expect(trial.logs.some((line) => line.includes('HTTP 403') || line.includes('org:write'))).toBe(false)
  } finally {
    await trial.stop()
  }
})

async function fixture(
  options: { allowed?: boolean; webhookUrl?: string; registrationDenied?: boolean; authType?: 'app' | 'pat' } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-sentry-lifecycle-'))
  let integration = {
    slug: 'typeclaw',
    uuid: 'app-1',
    name: 'TypeClaw',
    scopes: ['event:read'],
    events: ['error'],
    webhookUrl: '',
    owner: { slug: 'acme' },
  }
  let deleted = false
  const comments: string[] = []
  const api = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.headers.get('authorization') !== 'Bearer test-token') return new Response(null, { status: 401 })
      const path = new URL(request.url).pathname
      if (path === '/api/0/') return Response.json({ user: { id: 'bot', name: 'TypeClaw', username: 'typeclaw' } })
      if (request.method === 'DELETE') deleted = true
      if (path === '/api/0/sentry-apps/typeclaw/') {
        if (options.registrationDenied) return new Response(null, { status: 403 })
        if (request.method === 'PUT') integration = { ...integration, ...(await request.json()) }
        return Response.json(integration)
      }
      if (path.endsWith('/comments/')) {
        if (request.method === 'GET')
          return Response.json(
            comments.map((text, index) => ({
              id: String(100 + index),
              data: { text },
              dateCreated: '2026-10-22T00:00:00Z',
              user: { id: 'bot' },
            })),
          )
        const body = (await request.json()) as { text: string }
        comments.push(body.text)
        return Response.json({
          id: '100',
          data: { text: body.text },
          dateCreated: '2026-10-22T00:00:00Z',
          user: { id: 'bot' },
        })
      }
      if (/\/issues\/\d+\/$/.test(path))
        return Response.json({ id: path.split('/').at(-2), title: '오류', project: { id: '7', slug: 'backend' } })
      return new Response(null, { status: 404 })
    },
  })
  const config = channelsSchema.parse({
    sentry: {
      organization: 'acme',
      integration: 'typeclaw',
      projects: ['backend'],
      apiUrl: api.url.origin,
      webhookUrl: options.webhookUrl,
    },
  }).sentry!
  config.webhookPort = 0
  const journal = new InboundJournal(dir)
  await journal.initialize()
  const sessions: string[] = []
  const logs: string[] = []
  const logger = {
    info: (line: string) => logs.push(line),
    warn: (line: string) => logs.push(line),
    error: (line: string) => logs.push(line),
  }
  const router = createChannelRouter({
    agentDir: dir,
    configForAdapter: () => config,
    inboundJournal: journal,
    logger,
    permissions: createPermissionService({
      roles: rolesConfigSchema.parse({ member: { match: options.allowed === false ? [] : ['sentry:acme/backend'] } }),
    }),
    createSessionForChannel: async ({ key }) => {
      sessions.push(key.chat)
      return {
        session: new ProviderlessSession() as unknown as AgentSession,
        sessionId: `session_${key.chat.replace(':', '_')}`,
        dispose: async () => {},
      }
    },
  })
  let tunnelUrl = 'https://first.trycloudflare.com'
  const createAdapter = () =>
    createSentryAdapter({
      router,
      configRef: () => config,
      secrets: {
        auth: { type: options.authType ?? 'pat', token: { value: 'test-token' } },
        webhookSecret: { value: 'test-secret' },
      },
      tunnelUrl: () => tunnelUrl,
      logger,
    })
  let adapter = createAdapter()
  return {
    get adapter() {
      return adapter
    },
    recreateAdapter: () => {
      adapter = createAdapter()
    },
    router,
    journal,
    sessions,
    logs,
    integration: () => integration,
    comments: () => comments,
    deleted: () => deleted,
    setTunnelUrl: (url: string) => {
      tunnelUrl = url
    },
    async deliver(
      delivery: string,
      issueId: string,
      secret = 'test-secret',
      event: 'created' | 'regressed' | 'resolved' = 'created',
    ) {
      const port = logs
        .findLast((line) => line.startsWith('[sentry] 웹훅 수신 포트:'))!
        .split(': ')
        .at(-1)
      const body = JSON.stringify({
        action: event === 'regressed' ? 'unresolved' : event,
        actor: { id: 'sentry', type: 'application', name: 'Sentry' },
        data: {
          issue: {
            id: issueId,
            ...(event === 'regressed' ? { substatus: 'regressed' } : {}),
            title: '새 오류',
            url: `https://sentry.io/api/0/organizations/acme/issues/${issueId}/`,
            project: { slug: 'backend' },
          },
        },
      })
      return fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        body,
        headers: {
          'sentry-hook-resource': 'issue',
          'request-id': delivery,
          'sentry-hook-signature': createHmac('sha256', secret).update(body).digest('hex'),
        },
      })
    },
    async stop() {
      await adapter.stop()
      await router.stop()
      await journal.close()
      await api.stop(true)
      await rm(dir, { recursive: true, force: true })
    },
  }
}

class ProviderlessSession {
  sessionManager = { getLeafEntry: () => undefined }
  agent = { streamFunction: () => undefined, abort: () => {} }
  prompt = async (): Promise<void> => {}
  abort = async (): Promise<void> => {}
  dispose = (): void => {}
  subscribe = (): (() => void) => () => {}
}
