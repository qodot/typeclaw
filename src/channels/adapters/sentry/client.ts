import { z } from 'zod'

export type SentryResult<T> = { ok: true; value: T } | { ok: false; error: string }

export type SentrySelf = z.infer<typeof selfSchema>
export type SentryIntegration = z.infer<typeof integrationSchema>
export type SentryIssue = z.infer<typeof issueSchema>
export type SentryComment = z.infer<typeof commentSchema>
export type SentryCommentPage = { comments: SentryComment[]; nextCursor?: string }

export type SentryIntegrationUpdate = {
  webhookUrl: string
  events?: string[]
  name?: string
  scopes?: string[]
}

export class SentryClient {
  private readonly token: string
  private readonly baseUrl: string

  constructor(options: { token: string; baseUrl?: string }) {
    this.token = options.token
    this.baseUrl = (options.baseUrl ?? 'https://sentry.io/api/0').replace(/\/+$/, '')
  }

  async getSelf(): Promise<SentryResult<SentrySelf>> {
    const result = await this.request('', z.object({ user: selfSchema }))
    return result.ok ? { ok: true, value: result.value.user } : result
  }

  getIntegration(integration: string): Promise<SentryResult<SentryIntegration>> {
    return this.request(`sentry-apps/${encodeURIComponent(integration)}/`, integrationSchema)
  }

  updateIntegration(integration: string, input: SentryIntegrationUpdate): Promise<SentryResult<SentryIntegration>> {
    return this.request(`sentry-apps/${encodeURIComponent(integration)}/`, integrationSchema, 'PUT', input)
  }

  getIssue(organization: string, issueId: string): Promise<SentryResult<SentryIssue>> {
    return this.request(
      `organizations/${encodeURIComponent(organization)}/issues/${encodeURIComponent(issueId)}/`,
      issueSchema,
    )
  }

  async listComments(
    organization: string,
    issueId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<SentryResult<SentryCommentPage>> {
    const query = new URLSearchParams()
    if (options.limit !== undefined) query.set('per_page', String(options.limit))
    if (options.cursor !== undefined) query.set('cursor', options.cursor)
    const result = await this.request(
      `organizations/${encodeURIComponent(organization)}/issues/${encodeURIComponent(issueId)}/comments/${query.size > 0 ? `?${query}` : ''}`,
      z.array(commentSchema),
    )
    if (!result.ok) return result
    return {
      ok: true,
      value: {
        comments: result.value,
        ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
      },
    }
  }

  createComment(organization: string, issueId: string, text: string): Promise<SentryResult<SentryComment>> {
    return this.request(
      `organizations/${encodeURIComponent(organization)}/issues/${encodeURIComponent(issueId)}/comments/`,
      commentSchema,
      'POST',
      { text },
    )
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    method = 'GET',
    body?: unknown,
  ): Promise<SentryResult<T> & { nextCursor?: string }> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      return { ok: false, error: 'Sentry API connection failed' }
    }
    if (!response.ok) return { ok: false, error: `Sentry API ${method} failed (HTTP ${response.status})` }
    try {
      const parsed = schema.safeParse(await response.json())
      if (!parsed.success) return { ok: false, error: 'Sentry API returned an invalid response' }
      const next = response.headers
        .get('link')
        ?.split(',')
        .find((link) => /rel="next"/.test(link) && /results="true"/.test(link))
      const nextCursor = next?.match(/cursor="([^"]+)"/)?.[1]
      return { ok: true, value: parsed.data, ...(nextCursor === undefined ? {} : { nextCursor }) }
    } catch {
      return { ok: false, error: 'Sentry API returned an invalid response' }
    }
  }
}

const selfSchema = z.object({
  id: z.string(),
  name: z.string(),
  username: z.string(),
})

const integrationSchema = z.object({
  slug: z.string(),
  uuid: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  events: z.array(z.string()),
  webhookUrl: z.string().nullable(),
  owner: z.object({ slug: z.string() }).optional(),
})

const issueSchema = z.object({
  id: z.string(),
  title: z.string(),
  shortId: z.string().optional(),
  status: z.string().optional(),
  substatus: z.string().nullable().optional(),
  permalink: z.string().optional(),
  project: z.object({ id: z.string(), slug: z.string(), name: z.string().optional() }),
})

const commentSchema = z.object({
  id: z.string(),
  commentId: z.string().nullable().optional(),
  data: z.object({ text: z.string() }),
  dateCreated: z.string(),
  user: z.object({ id: z.string(), name: z.string().optional(), username: z.string().optional() }).nullable(),
})
