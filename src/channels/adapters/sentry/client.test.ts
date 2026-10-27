import { describe, expect, test } from 'bun:test'

import { SentryClient } from './client'

describe('SentryClient', () => {
  test('토큰 사용자의 식별자를 조회하고 미인증 응답을 실패로 반환한다', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname !== '/api/0/') return new Response(null, { status: 404 })
        return Response.json({
          version: '0',
          auth: { scopes: ['org:write'] },
          user:
            request.headers.get('authorization') === 'Bearer test-token'
              ? { id: '7', name: '사용자', username: 'user', email: 'private@example.com' }
              : null,
        })
      },
    })
    try {
      const client = new SentryClient({ token: 'test-token', baseUrl: `${server.url}api/0` })
      expect(await client.getSelf()).toEqual({ ok: true, value: { id: '7', name: '사용자', username: 'user' } })
      const anonymous = new SentryClient({ token: '', baseUrl: `${server.url}api/0` })
      expect((await anonymous.getSelf()).ok).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  test('내부 통합 토큰의 앱 대리 사용자 식별자를 반환한다', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (request.headers.get('authorization') !== 'Bearer integration-token')
          return new Response(null, { status: 401 })
        return Response.json({
          version: '0',
          auth: { scopes: ['event:read', 'event:write'] },
          user: {
            id: '91',
            name: 'typeclaw-app',
            username: 'typeclaw-app-unique-proxy',
            email: 'typeclaw-app-unique-proxy@proxy-user.sentry.io',
          },
        })
      },
    })
    try {
      const client = new SentryClient({ token: 'integration-token', baseUrl: `${server.url}api/0` })
      expect(await client.getSelf()).toEqual({
        ok: true,
        value: { id: '91', name: 'typeclaw-app', username: 'typeclaw-app-unique-proxy' },
      })
    } finally {
      server.stop(true)
    }
  })

  test('인증한 통합 정보를 읽고 비밀 필드를 반환하지 않는다', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname !== '/api/0/sentry-apps/typeclaw/') return new Response(null, { status: 404 })
        if (request.headers.get('authorization') !== 'Bearer test-token') return new Response(null, { status: 401 })
        return Response.json({ ...integration(), clientSecret: 'not-for-callers' })
      },
    })
    try {
      const client = new SentryClient({ token: 'test-token', baseUrl: `${server.url}api/0/` })
      expect(await client.getIntegration('typeclaw')).toEqual({ ok: true, value: integration() })
    } finally {
      server.stop(true)
    }
  })

  test('통합의 웹훅 주소와 구독 이벤트를 갱신한다', async () => {
    let stored = integration()
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.method === 'PUT') stored = { ...stored, ...(await request.json()) }
        return Response.json(stored)
      },
    })
    try {
      const client = new SentryClient({ token: 'test-token', baseUrl: `${server.url}api/0` })
      const updated = { webhookUrl: 'https://new.trycloudflare.com/sentry', events: ['issue'] }
      expect(await client.updateIntegration('typeclaw', updated)).toEqual({
        ok: true,
        value: { ...integration(), ...updated },
      })
      expect(await client.getIntegration('typeclaw')).toEqual({ ok: true, value: { ...integration(), ...updated } })
    } finally {
      server.stop(true)
    }
  })

  test('조직별 이슈와 댓글을 읽고 한글 댓글을 생성한다', async () => {
    const comments = [comment('1', '기존 댓글')]
    const issue = { id: '42', title: '새 오류', project: { id: '7', slug: 'backend' } }
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/api/0/organizations/acme/issues/42/') return Response.json(issue)
        if (path !== '/api/0/organizations/acme/issues/42/comments/') return new Response(null, { status: 404 })
        if (request.method === 'POST') {
          const body = (await request.json()) as { text: string }
          const created = comment('2', body.text)
          comments.push(created)
          return Response.json(created, { status: 201 })
        }
        return Response.json(comments)
      },
    })
    try {
      const client = new SentryClient({ token: 'test-token', baseUrl: `${server.url}api/0` })
      expect(await client.getIssue('acme', '42')).toEqual({ ok: true, value: issue })
      expect(await client.listComments('acme', '42')).toEqual({
        ok: true,
        value: { comments: [comment('1', '기존 댓글')] },
      })
      expect(await client.createComment('acme', '42', '원인을 찾았습니다')).toEqual({
        ok: true,
        value: comment('2', '원인을 찾았습니다'),
      })
      expect(await client.listComments('acme', '42')).toEqual({
        ok: true,
        value: { comments: [comment('1', '기존 댓글'), comment('2', '원인을 찾았습니다')] },
      })
    } finally {
      server.stop(true)
    }
  })

  test('댓글 페이지의 다음 커서를 반환하고 다음 페이지를 읽는다', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const query = new URL(request.url).searchParams
        if (query.get('per_page') !== '1') return new Response(null, { status: 400 })
        if (query.get('cursor') === '123:0:0') {
          return Response.json([comment('1', '이전 댓글')], {
            headers: { Link: '<https://sentry.io/next>; rel="next"; results="false"; cursor="123:1:0"' },
          })
        }
        return Response.json([comment('2', '최근 댓글')], {
          headers: {
            Link: '<https://sentry.io/prev>; rel="previous"; results="false"; cursor="123:0:1", <https://sentry.io/next>; rel="next"; results="true"; cursor="123:0:0"',
          },
        })
      },
    })
    try {
      const client = new SentryClient({ token: 'test-token', baseUrl: String(server.url) })
      expect(await client.listComments('acme', '42', { limit: 1 })).toEqual({
        ok: true,
        value: { comments: [comment('2', '최근 댓글')], nextCursor: '123:0:0' },
      })
      expect(await client.listComments('acme', '42', { limit: 1, cursor: '123:0:0' })).toEqual({
        ok: true,
        value: { comments: [comment('1', '이전 댓글')] },
      })
    } finally {
      server.stop(true)
    }
  })

  test('권한 실패는 응답 본문의 비밀 없이 오류로 반환한다', async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ secret: 'protected' }, { status: 403 }) })
    try {
      const client = new SentryClient({ token: 'test-token', baseUrl: String(server.url) })
      expect(await client.getIntegration('typeclaw')).toEqual({
        ok: false,
        error: 'Sentry API GET failed (HTTP 403)',
      })
    } finally {
      server.stop(true)
    }
  })

  test('잘못된 JSON과 필수 필드가 없는 응답을 실패로 반환한다', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        return request.method === 'PUT' ? new Response('{') : Response.json({ id: '1' })
      },
    })
    try {
      const client = new SentryClient({ token: 'test-token', baseUrl: String(server.url) })
      const failure = { ok: false, error: 'Sentry API returned an invalid response' } as const
      expect(await client.getIntegration('typeclaw')).toEqual(failure)
      expect(await client.updateIntegration('typeclaw', { webhookUrl: 'https://example.com' })).toEqual(failure)
      expect(await client.getIssue('acme', '42')).toEqual(failure)
      expect(await client.listComments('acme', '42')).toEqual(failure)
      expect(await client.createComment('acme', '42', '댓글')).toEqual(failure)
    } finally {
      server.stop(true)
    }
  })

  test('서버 연결 실패를 명시적인 실패로 반환한다', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response() })
    const baseUrl = String(server.url)
    server.stop(true)
    const client = new SentryClient({ token: 'test-token', baseUrl })
    expect(await client.getIntegration('typeclaw')).toEqual({ ok: false, error: 'Sentry API connection failed' })
  })
})

function integration() {
  return {
    slug: 'typeclaw',
    uuid: 'app-uuid',
    name: 'TypeClaw',
    scopes: ['event:read'],
    events: ['issue'],
    webhookUrl: 'https://old.trycloudflare.com/sentry',
    owner: { slug: 'acme' },
  }
}

function comment(id: string, text: string) {
  return { id, data: { text }, dateCreated: '2026-10-22T00:00:00Z', user: { id: 'user-1', name: '테스터' } }
}
