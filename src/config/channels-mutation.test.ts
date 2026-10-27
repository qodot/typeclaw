import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listChannels, removeChannel, setChannelWebhookUrl } from './channels-mutation'

const SECRETS_HEADER = { $schema: './node_modules/typeclaw/secrets.schema.json', version: 2 as const }

describe('channels mutation', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-channels-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  async function writeConfig(value: Record<string, unknown>): Promise<void> {
    await writeFile(join(cwd, 'typeclaw.json'), `${JSON.stringify(value, null, 2)}\n`)
  }

  async function writeSecrets(channels: Record<string, unknown>): Promise<void> {
    await writeFile(
      join(cwd, 'secrets.json'),
      `${JSON.stringify({ ...SECRETS_HEADER, providers: {}, channels }, null, 2)}\n`,
    )
  }

  async function readConfig(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(join(cwd, 'typeclaw.json'), 'utf8')) as Record<string, unknown>
  }

  async function readSecretsChannels(): Promise<Record<string, unknown>> {
    const raw = JSON.parse(await readFile(join(cwd, 'secrets.json'), 'utf8')) as { channels: Record<string, unknown> }
    return raw.channels
  }

  test('Sentry 목록은 프로젝트 수를 표시하고 삭제는 해당 터널과 권한만 제거한다', async () => {
    await writeConfig({
      channels: { sentry: { organization: 'acme', integration: 'agent', projects: ['web'] } },
      tunnels: [
        { name: 'sentry-webhook', provider: 'cloudflare-quick', for: { kind: 'channel', name: 'sentry' } },
        { name: 'github-webhook', provider: 'cloudflare-quick', for: { kind: 'channel', name: 'github' } },
      ],
      roles: { member: { match: ['sentry:acme/web', 'sentry:other/project', 'github:acme/web'] } },
    })
    await writeSecrets({ sentry: { auth: { type: 'pat', token: { value: 't' } }, webhookSecret: { value: 's' } } })
    expect(listChannels(cwd)).toContainEqual(
      expect.objectContaining({ kind: 'sentry', detail: '1개 프로젝트', hasSecrets: true }),
    )
    expect(removeChannel(cwd, 'sentry').ok).toBe(true)
    const config = await readConfig()
    expect(config.channels).toEqual({})
    expect(config.tunnels).toEqual([
      { name: 'github-webhook', provider: 'cloudflare-quick', for: { kind: 'channel', name: 'github' } },
    ])
    expect(config.roles).toEqual({ member: { match: ['sentry:other/project', 'github:acme/web'] } })
    expect(await readSecretsChannels()).toEqual({})
  })

  describe('채널 웹훅 주소 변경', () => {
    test.each(['github', 'sentry'] as const)('%s 웹훅 주소만 변경하고 기존 설정과 터널을 보존한다', async (channel) => {
      const original = {
        models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
        channels: {
          sentry: { organization: 'acme', integration: 'agent', projects: ['web'], webhookPort: 8976 },
          github: { repos: ['acme/web'], webhookUrl: 'https://old.example.com/github' },
          'discord-bot': { enabled: false },
        },
        tunnels: [
          { name: 'sentry-webhook', provider: 'cloudflare-quick', for: { kind: 'channel', name: 'sentry' } },
          { name: 'github-webhook', provider: 'cloudflare-quick', for: { kind: 'channel', name: 'github' } },
        ],
        custom: { keep: true },
      }
      await writeConfig(original)
      await writeSecrets({ sentry: { auth: { type: 'pat', token: 'token' }, webhookSecret: 'secret' } })
      const secretsBefore = await readFile(join(cwd, 'secrets.json'), 'utf8')
      const webhookUrl = `https://hooks.example.com/${channel}`

      expect(setChannelWebhookUrl(cwd, channel, webhookUrl)).toEqual({ ok: true })
      expect(await readConfig()).toEqual({
        ...original,
        channels: { ...original.channels, [channel]: { ...original.channels[channel], webhookUrl } },
      })
      expect(await readFile(join(cwd, 'secrets.json'), 'utf8')).toBe(secretsBefore)
    })

    test('잘못된 웹훅 주소는 파일을 변경하지 않고 실패를 반환한다', async () => {
      await writeConfig({ channels: { github: { repos: ['acme/web'] } } })
      const before = await readFile(join(cwd, 'typeclaw.json'), 'utf8')
      expect(setChannelWebhookUrl(cwd, 'github', 'not-a-url')).toMatchObject({ ok: false })
      expect(await readFile(join(cwd, 'typeclaw.json'), 'utf8')).toBe(before)
    })

    test.each(['github', 'sentry'] as const)('등록하지 않은 %s 채널은 실패를 반환한다', async (channel) => {
      await writeConfig({ channels: { 'discord-bot': {} } })
      const before = await readFile(join(cwd, 'typeclaw.json'), 'utf8')
      const result = setChannelWebhookUrl(cwd, channel, 'https://hooks.example.com/channel')
      expect(result).toMatchObject({ ok: false })
      if (!result.ok) expect(result.reason).toContain('not configured')
      expect(await readFile(join(cwd, 'typeclaw.json'), 'utf8')).toBe(before)
    })

    test('설정 파일이 없으면 실패를 반환한다', () => {
      expect(setChannelWebhookUrl(cwd, 'github', 'https://hooks.example.com/github')).toMatchObject({ ok: false })
    })

    test('손상된 설정 파일은 변경하지 않고 실패를 반환한다', async () => {
      await writeFile(join(cwd, 'typeclaw.json'), '{ malformed')
      expect(setChannelWebhookUrl(cwd, 'github', 'https://hooks.example.com/github')).toMatchObject({ ok: false })
      expect(await readFile(join(cwd, 'typeclaw.json'), 'utf8')).toBe('{ malformed')
    })

    test('접근할 수 없는 호스트 마운트가 있으면 변경 전에 실패를 반환한다', async () => {
      await writeConfig({
        channels: { github: { repos: ['acme/web'] } },
        mounts: [{ name: 'missing', path: join(cwd, 'missing'), readOnly: true }],
      })
      const before = await readFile(join(cwd, 'typeclaw.json'), 'utf8')
      expect(setChannelWebhookUrl(cwd, 'github', 'https://hooks.example.com/github')).toMatchObject({ ok: false })
      expect(await readFile(join(cwd, 'typeclaw.json'), 'utf8')).toBe(before)
    })
  })

  describe('listChannels', () => {
    test('reports only channels present in config or secrets', async () => {
      await writeConfig({ channels: { 'discord-bot': {}, github: { repos: ['a/b', 'c/d'] } } })
      await writeSecrets({
        'discord-bot': { token: { value: 't' } },
        github: { auth: { type: 'pat', token: { value: 'p' } }, webhookSecret: { value: 's' } },
      })

      const list = listChannels(cwd)

      expect(list.map((c) => c.kind).sort()).toEqual(['discord-bot', 'github'])
    })

    test('flags a configured channel missing its secrets', async () => {
      await writeConfig({ channels: { 'telegram-bot': {} } })
      await writeSecrets({})

      const [entry] = listChannels(cwd)

      expect(entry).toMatchObject({ kind: 'telegram-bot', configured: true, hasSecrets: false })
    })

    test('surfaces secrets-only drift (secrets present, config absent)', async () => {
      await writeConfig({ channels: {} })
      await writeSecrets({ 'slack-bot': { botToken: { value: 'b' }, appToken: { value: 'a' } } })

      const [entry] = listChannels(cwd)

      expect(entry).toMatchObject({ kind: 'slack-bot', configured: false, hasSecrets: true })
    })

    test('reports enabled=false when the channel is disabled in config', async () => {
      await writeConfig({ channels: { 'discord-bot': { enabled: false } } })
      await writeSecrets({ 'discord-bot': { token: { value: 't' } } })

      const list = listChannels(cwd)

      expect(list).toHaveLength(1)
      expect(list[0]?.enabled).toBe(false)
    })

    test('returns an empty list when nothing is configured', async () => {
      await writeConfig({ channels: {} })

      expect(listChannels(cwd)).toEqual([])
    })

    test('includes a repo-count detail for github', async () => {
      await writeConfig({ channels: { github: { repos: ['a/b'] } } })
      await writeSecrets({ github: { auth: { type: 'pat', token: { value: 'p' } }, webhookSecret: { value: 's' } } })

      const list = listChannels(cwd)

      expect(list).toHaveLength(1)
      expect(list[0]?.detail).toBe('1 repo')
    })

    test('includes an account-count detail for teams', async () => {
      await writeConfig({ channels: { teams: {} } })
      await writeSecrets({
        teams: {
          currentAccount: 'me',
          accounts: {
            me: {
              account_id: 'me',
              access_token: 't',
              account_type: 'work',
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
            },
          },
        },
      })

      const list = listChannels(cwd)

      expect(list).toHaveLength(1)
      expect(list[0]?.detail).toBe('1 account (active: me)')
    })
  })

  describe('removeChannel', () => {
    test('removes a bot adapter from both config and secrets', async () => {
      await writeConfig({ channels: { 'discord-bot': {}, 'telegram-bot': {} } })
      await writeSecrets({ 'discord-bot': { token: { value: 't' } }, 'telegram-bot': { token: { value: 'u' } } })

      const result = removeChannel(cwd, 'discord-bot')

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result).toMatchObject({ configRemoved: true, secretsRemoved: true })
      expect(await readConfig()).toEqual({ channels: { 'telegram-bot': {} } })
      expect(await readSecretsChannels()).toEqual({ 'telegram-bot': { token: { value: 'u' } } })
    })

    test('refuses to remove a channel that is configured nowhere', async () => {
      await writeConfig({ channels: { 'discord-bot': {} } })
      await writeSecrets({ 'discord-bot': { token: { value: 't' } } })

      const result = removeChannel(cwd, 'slack-bot')

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toContain('not configured')
    })

    test('removes a secrets-only channel even when absent from config', async () => {
      await writeConfig({ channels: {} })
      await writeSecrets({ 'slack-bot': { botToken: { value: 'b' }, appToken: { value: 'a' } } })

      const result = removeChannel(cwd, 'slack-bot')

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result).toMatchObject({ configRemoved: false, secretsRemoved: true })
      expect(await readSecretsChannels()).toEqual({})
    })

    test('github removal strips its tunnel and repo-derived match rules but keeps cloudflared and unrelated rules', async () => {
      await writeConfig({
        channels: { github: { webhookPort: 8975, repos: ['acme/app'] } },
        tunnels: [
          { name: 'github-webhook', provider: 'cloudflare-quick', for: { kind: 'channel', name: 'github' } },
          { name: 'devserver', provider: 'cloudflare-quick', for: { kind: 'port', name: '3000' } },
        ],
        docker: { file: { cloudflared: true } },
        roles: { member: { match: ['github:acme/app', 'github:manual/repo', 'slack:U123'] } },
      })
      await writeSecrets({ github: { auth: { type: 'pat', token: { value: 'p' } }, webhookSecret: { value: 's' } } })

      const result = removeChannel(cwd, 'github')

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.githubCleanup).toMatchObject({
        tunnelsRemoved: 1,
        matchRulesRemoved: ['github:acme/app'],
        matchRulesKept: ['github:manual/repo'],
      })
      expect(result.hadRemoteWebhooks).toBe(true)

      const config = await readConfig()
      expect(config.channels).toEqual({})
      expect(config.tunnels).toEqual([
        { name: 'devserver', provider: 'cloudflare-quick', for: { kind: 'port', name: '3000' } },
      ])
      expect(config.docker).toEqual({ file: { cloudflared: true } })
      expect((config.roles as { member: { match: string[] } }).member.match).toEqual([
        'github:manual/repo',
        'slack:U123',
      ])
    })

    test('github removal with no repos leaves match rules untouched and reports no remote webhooks', async () => {
      await writeConfig({
        channels: { github: { webhookPort: 8975, repos: [] } },
        roles: { member: { match: ['github:manual/repo'] } },
      })
      await writeSecrets({ github: { auth: { type: 'pat', token: { value: 'p' } }, webhookSecret: { value: 's' } } })

      const result = removeChannel(cwd, 'github')

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.hadRemoteWebhooks).toBe(false)
      expect(result.githubCleanup).toMatchObject({
        tunnelsRemoved: 0,
        matchRulesRemoved: [],
        matchRulesKept: ['github:manual/repo'],
      })
      expect((await readConfig()).roles).toEqual({ member: { match: ['github:manual/repo'] } })
    })

    test('is idempotent on secrets when the channel exists only in config', async () => {
      await writeConfig({ channels: { 'discord-bot': {} } })
      await writeSecrets({})

      const result = removeChannel(cwd, 'discord-bot')

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result).toMatchObject({ configRemoved: true, secretsRemoved: false })
    })

    test('refuses without touching typeclaw.json when secrets.json is unreadable', async () => {
      await writeConfig({ channels: { 'discord-bot': {} } })
      await writeFile(join(cwd, 'secrets.json'), '{ this is not valid json')

      const result = removeChannel(cwd, 'discord-bot')

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toContain('unreadable')
      // The channel must survive in config so a retry can still clean both
      // sides once the user fixes secrets.json.
      expect(await readConfig()).toEqual({ channels: { 'discord-bot': {} } })
    })
  })
})
