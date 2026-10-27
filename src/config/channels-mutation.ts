import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { channelsSchema } from '@/channels/schema'
import { commitSystemFileSync } from '@/git/system-commit'
import { SecretsBackend } from '@/secrets'

import { validateConfig } from './config'

const CONFIG_FILE = 'typeclaw.json'
const SECRETS_FILE = 'secrets.json'

export const CHANNEL_KINDS = [
  'slack-bot',
  'slack',
  'discord',
  'discord-bot',
  'telegram-bot',
  'webex',
  'webex-bot',
  'teams',
  'instagram',
  'line',
  'kakaotalk',
  'github',
  'sentry',
] as const

export type ChannelKind = (typeof CHANNEL_KINDS)[number]

export type ChannelListEntry = {
  kind: ChannelKind
  configured: boolean
  hasSecrets: boolean
  enabled: boolean
  detail?: string
}

export type GithubConfigCleanup = {
  tunnelsRemoved: number
  matchRulesRemoved: string[]
  matchRulesKept: string[]
}

export type RemoveChannelResult =
  | {
      ok: true
      configRemoved: boolean
      secretsRemoved: boolean
      githubCleanup?: GithubConfigCleanup
      hadRemoteWebhooks: boolean
    }
  | { ok: false; reason: string }

export function isChannelKind(value: string): value is ChannelKind {
  return (CHANNEL_KINDS as ReadonlyArray<string>).includes(value)
}

export function listChannels(cwd: string): ChannelListEntry[] {
  const config = readConfigRecordOrEmpty(cwd)
  const configuredChannels = isObjectRecord(config.channels) ? config.channels : {}
  const secrets = channelSecretsOrEmpty(readChannelSecrets(cwd))

  return CHANNEL_KINDS.map((kind) => {
    const channelConfig = configuredChannels[kind]
    const configured = kind in configuredChannels
    const hasSecrets = kind in secrets
    return {
      kind,
      configured,
      hasSecrets,
      enabled: readEnabled(channelConfig),
      ...buildDetail(kind, channelConfig, secrets[kind]),
    }
  }).filter((entry) => entry.configured || entry.hasSecrets)
}

export function removeChannel(cwd: string, kind: ChannelKind): RemoveChannelResult {
  const config = readConfigRecord(cwd)
  if (!config.ok) return config

  const channels = isObjectRecord(config.value.channels) ? { ...config.value.channels } : {}

  // Bail BEFORE touching typeclaw.json when secrets.json exists but cannot be
  // read. Otherwise the config write below would strip `channels.<kind>` while
  // the credential block stays on disk yet unreachable — `removeChannelSync`
  // would throw on the same parse error, and the next invocation would no
  // longer see the channel in config OR (the swallowed) secrets, stranding the
  // credentials with no CLI path to clean them. Failing first keeps the retry
  // able to target both once the file is fixed.
  const secretsRead = readChannelSecrets(cwd)
  if (secretsRead.kind === 'unreadable') {
    return {
      ok: false,
      reason: `${SECRETS_FILE} is unreadable (${secretsRead.reason}). Fix it by hand, then retry \`typeclaw channel remove ${kind}\`.`,
    }
  }
  const secrets = channelSecretsOrEmpty(secretsRead)

  const inConfig = kind in channels
  const inSecrets = kind in secrets
  if (!inConfig && !inSecrets) {
    return { ok: false, reason: `Channel "${kind}" is not configured in ${CONFIG_FILE} or ${SECRETS_FILE}.` }
  }

  const sentry = channels.sentry
  const sentryTargets =
    isObjectRecord(sentry) && typeof sentry.organization === 'string' && Array.isArray(sentry.projects)
      ? sentry.projects
          .filter((project): project is string => typeof project === 'string')
          .map((project) => `${sentry.organization}/${project}`)
      : []
  const githubRepos = kind === 'github' ? readGithubRepos(channels.github) : []
  const hadRemoteWebhooks = githubRepos.length > 0

  delete channels[kind]
  config.value.channels = channels

  const githubCleanup = kind === 'github' ? cleanWebhookConfig(config.value, 'github', githubRepos) : undefined

  if (kind === 'sentry') cleanWebhookConfig(config.value, 'sentry', sentryTargets)

  const write = writeConfig(cwd, config.value, `channel: remove ${kind}`)
  if (!write.ok) return write

  const secretsRemoved = new SecretsBackend(join(cwd, SECRETS_FILE)).removeChannelSync(kind)

  return {
    ok: true,
    configRemoved: inConfig,
    secretsRemoved,
    ...(githubCleanup !== undefined ? { githubCleanup } : {}),
    hadRemoteWebhooks,
  }
}

export function setChannelWebhookUrl(
  cwd: string,
  channel: 'github' | 'sentry',
  webhookUrl: string,
): { ok: true } | { ok: false; reason: string } {
  const url = channelsSchema.unwrap().shape[channel].unwrap().shape.webhookUrl.safeParse(webhookUrl)
  if (!url.success) {
    return { ok: false, reason: url.error.issues.map((issue) => issue.message).join('; ') }
  }
  const validated = validateConfig(cwd)
  if (!validated.ok) return validated
  const config = readConfigRecord(cwd)
  if (!config.ok) return config
  const channels = isObjectRecord(config.value.channels) ? config.value.channels : {}
  const existing = channels[channel]
  if (!isObjectRecord(existing)) {
    return { ok: false, reason: `Channel "${channel}" is not configured in ${CONFIG_FILE}.` }
  }
  config.value.channels = { ...channels, [channel]: { ...existing, webhookUrl: url.data } }
  return writeConfig(cwd, config.value, `채널 ${channel}의 웹훅 주소를 변경한다`)
}

// GitHub `add` writes three config artifacts beyond `channels.github`: a
// `tunnels[]` entry marked `for: { kind: 'channel', name: 'github' }`,
// `roles.member.match[]` rules `github:<owner>/<repo>`, and the
// `docker.file.cloudflared` enablement flag. Removal strips the first two
// (both channel-owned) but intentionally leaves `docker.file.cloudflared`: it
// is a shared enablement flag a remaining tunnel may still need. Match-rule
// stripping is scoped to the configured repos so hand-authored `github:`
// identities survive.
function cleanWebhookConfig(
  config: Record<string, unknown>,
  channel: 'github' | 'sentry',
  repos: string[],
): GithubConfigCleanup {
  const tunnelsRemoved = removeWebhookTunnels(config, channel)
  const { removed, kept } = removeWebhookMatchRules(config, channel, repos)
  return { tunnelsRemoved, matchRulesRemoved: removed, matchRulesKept: kept }
}

function removeWebhookTunnels(config: Record<string, unknown>, channel: string): number {
  if (!Array.isArray(config.tunnels)) return 0
  const before = config.tunnels.length
  config.tunnels = config.tunnels.filter((entry) => !isWebhookChannelTunnel(entry, channel))
  return before - (config.tunnels as unknown[]).length
}

function isWebhookChannelTunnel(entry: unknown, channel: string): boolean {
  if (!isObjectRecord(entry)) return false
  const target = entry.for
  if (!isObjectRecord(target)) return false
  return target.kind === 'channel' && target.name === channel
}

function readGithubRepos(githubConfig: unknown): string[] {
  if (!isObjectRecord(githubConfig) || !Array.isArray(githubConfig.repos)) return []
  return githubConfig.repos.filter((repo): repo is string => typeof repo === 'string')
}

function removeWebhookMatchRules(
  config: Record<string, unknown>,
  channel: string,
  repos: string[],
): { removed: string[]; kept: string[] } {
  const roles = isObjectRecord(config.roles) ? { ...config.roles } : undefined
  const member = roles !== undefined && isObjectRecord(roles.member) ? { ...roles.member } : undefined
  if (roles === undefined || member === undefined || !Array.isArray(member.match)) {
    return { removed: [], kept: [] }
  }

  const toRemove = new Set(repos.map((repo) => `${channel}:${repo}`))
  const removed: string[] = []
  const kept: string[] = []
  const next = member.match
    .filter((rule): rule is string => typeof rule === 'string')
    .filter((rule) => {
      if (toRemove.has(rule)) {
        removed.push(rule)
        return false
      }
      if (rule.startsWith(`${channel}:`)) kept.push(rule)
      return true
    })

  if (removed.length === 0) return { removed: [], kept }

  member.match = next
  roles.member = member
  config.roles = roles
  return { removed, kept }
}

function buildDetail(kind: ChannelKind, channelConfig: unknown, secretsBlock: unknown): { detail?: string } {
  if (kind === 'sentry') {
    const projects =
      isObjectRecord(channelConfig) && Array.isArray(channelConfig.projects) ? channelConfig.projects.length : 0
    return { detail: `${projects}개 프로젝트` }
  }
  if (kind === 'github') {
    const repos = isObjectRecord(channelConfig) && Array.isArray(channelConfig.repos) ? channelConfig.repos.length : 0
    return { detail: `${repos} repo${repos === 1 ? '' : 's'}` }
  }
  if (
    kind === 'line' ||
    kind === 'instagram' ||
    kind === 'kakaotalk' ||
    kind === 'webex' ||
    kind === 'discord' ||
    kind === 'teams'
  ) {
    if (!isObjectRecord(secretsBlock)) return {}
    const accounts = isObjectRecord(secretsBlock.accounts) ? Object.keys(secretsBlock.accounts).length : 0
    const current = typeof secretsBlock.currentAccount === 'string' ? secretsBlock.currentAccount : undefined
    const accountLabel = `${accounts} account${accounts === 1 ? '' : 's'}`
    return { detail: current !== undefined ? `${accountLabel} (active: ${current})` : accountLabel }
  }
  return {}
}

function readEnabled(channelConfig: unknown): boolean {
  if (isObjectRecord(channelConfig) && typeof channelConfig.enabled === 'boolean') return channelConfig.enabled
  return true
}

function readConfigRecord(cwd: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  try {
    const raw = readFileSync(join(cwd, CONFIG_FILE), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isObjectRecord(parsed)) return { ok: false, reason: `${CONFIG_FILE} must contain a JSON object.` }
    return { ok: true, value: parsed }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: `${CONFIG_FILE} not found at ${cwd}. Run \`typeclaw init\` first.` }
    }
    return { ok: false, reason: `Failed to read ${CONFIG_FILE}: ${(error as Error).message}` }
  }
}

function readConfigRecordOrEmpty(cwd: string): Record<string, unknown> {
  const result = readConfigRecord(cwd)
  return result.ok ? result.value : {}
}

type ChannelSecretsRead =
  | { kind: 'ok'; channels: Record<string, unknown> }
  | { kind: 'missing' }
  | { kind: 'unreadable'; reason: string }

function readChannelSecrets(cwd: string): ChannelSecretsRead {
  try {
    const channels = new SecretsBackend(join(cwd, SECRETS_FILE)).tryReadChannelsSync()
    if (channels === null) return { kind: 'missing' }
    return { kind: 'ok', channels: channels as Record<string, unknown> }
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) }
  }
}

function channelSecretsOrEmpty(read: ChannelSecretsRead): Record<string, unknown> {
  return read.kind === 'ok' ? read.channels : {}
}

function writeConfig(
  cwd: string,
  record: Record<string, unknown>,
  commitMessage: string,
): { ok: true } | { ok: false; reason: string } {
  try {
    writeFileSync(join(cwd, CONFIG_FILE), `${JSON.stringify(record, null, 2)}\n`)
  } catch (error) {
    return { ok: false, reason: `Failed to write ${CONFIG_FILE}: ${(error as Error).message}` }
  }
  commitSystemFileSync(cwd, CONFIG_FILE, commitMessage)
  return { ok: true }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
