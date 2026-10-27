import { randomBytes } from 'node:crypto'

import { cancel, confirm, intro, isCancel, log, note, password, select, spinner, text } from '@clack/prompts'
import { defineCommand } from 'citty'
import QRCode from 'qrcode'

import { githubRequiredPermissionsNote } from '@/channels/adapters/github/permission-guidance'
import { channelsSchema } from '@/channels/schema'
import { config } from '@/config'
import {
  listChannels,
  removeChannel,
  setChannelWebhookUrl,
  type ChannelListEntry,
  type GithubConfigCleanup,
} from '@/config/channels-mutation'
import { resolveController } from '@/container'
import {
  CHANNEL_KINDS,
  appendOrReplaceEnvKey,
  findAgentDir,
  formatEagerGithubWebhookInstallResult,
  hasEnvKey,
  isInitialized,
  readConfiguredChannels,
  readGithubAuthType,
  readSentryAuthType,
  runAddChannel,
  setChannelSecrets,
  setGithubSecrets,
  setSentrySecrets,
  type AddChannelStepEvent,
  type ChannelKind,
  type DiscordAuthResult,
  type SentryInitCredentials,
  type SentryCredentialPatch,
  type WebhookTunnelProvider,
  type GithubCredentialPatch,
  type GithubInitCredentials,
  type GithubTunnelProvider,
  type InstagramAuthResult,
  type KakaotalkAuthResult,
  type LineAuthResult,
  type SlackAuthResult,
  type TeamsAuthResult,
  type WebexAuthResult,
} from '@/init'
import { runDiscordBootstrap } from '@/init/discord-auth'
import { runInstagramBootstrap, type InstagramLoginCallbacks } from '@/init/instagram-auth'
import { runKakaotalkBootstrap } from '@/init/kakaotalk-auth'
import { runLineBootstrap } from '@/init/line-auth'
import { runSlackBootstrap } from '@/init/slack-auth'
import { runTeamsBootstrap, type TeamsDeviceCodeCallbacks } from '@/init/teams-auth'
import { runWebexBootstrap } from '@/init/webex-auth'
import { SecretsKakaoCredentialStore } from '@/secrets/kakao-store'
import type { TeamsAccountType } from '@/secrets/schema'
import { SecretsWebexCredentialStore } from '@/secrets/webex-store'

import { CANCEL_SYMBOL, promptPrivateKeyPem } from './prompt-pem'
import { displayQR } from './qr'
import { c, done, errorLine, printDiscordInviteHint, printSlackAppManifestSetup, successLine } from './ui'

export async function promptSentryCredentials(cwd: string): Promise<SentryInitCredentials | null> {
  note(
    'Sentry Custom Integration을 먼저 만들고 Issues 웹훅을 선택하세요. 앱 토큰은 event:read, event:write 권한과 고정 웹훅 URL을 사용합니다. 개인 토큰은 org:write 권한으로 웹훅 URL도 자동 갱신합니다.',
    'Sentry 연결',
  )
  const authType = await select<'app' | 'pat'>({
    message: 'Sentry 인증 방식',
    options: [
      { value: 'pat', label: '개인 인증 토큰' },
      { value: 'app', label: 'Internal Integration 앱 토큰 (권장)' },
    ],
    initialValue: 'app',
  })
  if (isCancel(authType)) return null
  const organization = await text({
    message: 'Sentry 조직 slug',
    validate: (v) =>
      channelsSchema.unwrap().shape.sentry.unwrap().shape.organization.safeParse(v?.trim()).success
        ? undefined
        : '유효한 조직 slug를 입력하세요.',
  })
  if (isCancel(organization)) return null
  const integration = await text({
    message: 'Custom Integration slug',
    validate: (v) =>
      channelsSchema.unwrap().shape.sentry.unwrap().shape.integration.safeParse(v?.trim()).success
        ? undefined
        : '유효한 Integration slug를 입력하세요.',
  })
  if (isCancel(integration)) return null
  const projects = await text({
    message: '수신할 프로젝트 slug (쉼표로 구분, 비워 두면 수신하지 않음)',
    validate: (v) =>
      channelsSchema
        .unwrap()
        .shape.sentry.unwrap()
        .shape.projects.safeParse(
          (v ?? '')
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean),
        ).success
        ? undefined
        : '유효한 프로젝트 slug를 쉼표로 구분해 입력하세요.',
  })
  if (isCancel(projects)) return null
  const token = await promptSentryToken(authType)
  if (isCancel(token)) return null
  const webhookSecret = await password({
    message: 'Custom Integration의 Client Secret',
    validate: (v) => (v ? undefined : '기존 Client Secret을 입력하세요.'),
  })
  if (isCancel(webhookSecret)) return null
  const apiUrl = await text({
    message: 'Sentry API 서버 주소',
    initialValue: 'https://sentry.io',
    validate: (v) => validateUrl(v ?? '', 'API 서버 주소를 입력하세요.'),
  })
  if (isCancel(apiUrl)) return null
  const tunnelProvider = await select<WebhookTunnelProvider>({
    message: 'Sentry 웹훅 터널',
    options: [
      ...(authType === 'pat'
        ? [{ value: 'cloudflare-quick' as const, label: 'Cloudflare Quick Tunnel (계정 불필요, 재시작 시 주소 변경)' }]
        : []),
      { value: 'cloudflare-named', label: 'Cloudflare Named Tunnel (고정 주소)' },
      { value: 'external', label: '직접 준비한 공개 URL' },
      { value: 'none', label: '나중에 설정' },
    ],
    initialValue: authType === 'app' ? 'cloudflare-named' : 'cloudflare-quick',
  })
  if (isCancel(tunnelProvider)) return null
  const webhookUrl =
    tunnelProvider === 'external'
      ? await text({ message: '공개 웹훅 URL', validate: (v) => validateUrl(v ?? '', '웹훅 URL을 입력하세요.') })
      : undefined
  if (isCancel(webhookUrl)) return null
  const named =
    tunnelProvider === 'cloudflare-named'
      ? await promptCloudflareNamedTunnel(cwd, 'SENTRY_CLOUDFLARE_TUNNEL_TOKEN')
      : undefined
  if (named === null) return null
  const port = await text({
    message: '컨테이너 내부 웹훅 수신 포트',
    initialValue: '8976',
    validate: (value) =>
      channelsSchema.unwrap().shape.sentry.unwrap().shape.webhookPort.safeParse(Number(value)).success
        ? undefined
        : '1부터 65535 사이의 포트를 입력하세요.',
  })
  if (isCancel(port)) return null
  if (authType === 'app') {
    const fixedUrl = webhookUrl ?? named?.hostname
    note(
      fixedUrl
        ? `Sentry 통합 설정에 웹훅 URL ${fixedUrl}를 직접 등록하세요. 앱 토큰은 통합의 웹훅 URL을 변경하지 않습니다.`
        : '앱 인증은 고정 공개 URL이 필요합니다. URL을 준비한 뒤 Sentry 통합 설정에 직접 등록하세요.',
      'Sentry 앱 웹훅',
    )
  }
  return {
    organization: organization.trim(),
    integration: integration.trim(),
    projects: (projects ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
    auth: { type: authType, token },
    webhookPort: Number(port),
    webhookSecret,
    apiUrl,
    tunnelProvider,
    ...(webhookUrl !== undefined ? { webhookUrl } : {}),
    ...named,
  }
}

const CHANNEL_LABELS: Record<ChannelKind, string> = {
  'slack-bot': 'Slack',
  slack: 'Slack (User)',
  discord: 'Discord (User)',
  'discord-bot': 'Discord',
  'telegram-bot': 'Telegram',
  webex: 'Webex (User)',
  'webex-bot': 'Webex',
  teams: 'Teams',
  instagram: 'Instagram',
  line: 'LINE',
  kakaotalk: 'KakaoTalk',
  github: 'GitHub',
  sentry: 'Sentry',
}

const ADDABLE_CHANNEL_KINDS = CHANNEL_KINDS

const addSub = defineCommand({
  meta: {
    name: 'add',
    description: 'add a new channel adapter to an existing agent (run this from inside the agent folder)',
  },
  args: {
    adapter: {
      type: 'positional',
      description: `which adapter to add (${ADDABLE_CHANNEL_KINDS.join(' | ')}); omit to pick interactively`,
      required: false,
    },
  },
  async run({ args }) {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()

    if (!isInitialized(cwd)) {
      console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first, or cd into an agent folder.'))
      process.exit(1)
    }

    const configured = await readConfiguredChannels(cwd)
    const requested = args.adapter
    const channel = requested === undefined ? await pickChannel(configured) : validateAdapterArg(requested, configured)

    intro(`Adding channel: ${CHANNEL_LABELS[channel]}`)

    const lineSpinnerHolder: LineAuthSpinnerHolder = { current: null }
    const credentials = await collectCredentials(channel, cwd, lineSpinnerHolder)

    const events: AddChannelStepEvent[] = []
    try {
      await runAddChannel({
        cwd,
        ...credentials,
        onProgress: reportProgress(events, lineSpinnerHolder),
      })
      if (credentials.channel === 'sentry')
        log.info(
          credentials.auth.type === 'app'
            ? 'Sentry 통합에 고정 웹훅 URL을 직접 등록한 뒤 에이전트를 시작하세요.'
            : '에이전트를 시작하면 Sentry 웹훅 주소를 갱신합니다. Custom Integration은 유지됩니다.',
        )
      if (credentials.channel === 'github' && credentials.tunnelProvider === 'none') {
        log.warn(
          'Webhook delivery is disabled until you add a `tunnels[]` entry or set `channels.github.webhookUrl` manually.',
        )
      }
    } catch (error) {
      console.error(errorLine(error instanceof Error ? error.message : String(error)))
      process.exit(1)
    }

    await maybePromptRestart(cwd, channel)
  },
})

// Adapters whose credentials are rotated via the generic `channel set` flow:
// one or more named token fields, no passcode-on-phone, no encryption envelope.
// KakaoTalk is excluded by design — it has its own `channel reauth` flow that
// replays the full interactive login (see REAUTHABLE_ADAPTERS below). GitHub
// is included here but routed through its own prompt path because it has
// three independent secrets (PAT or App private key + webhook secret) and a
// structural auth-type flip is forbidden during rotation.
const SETTABLE_ADAPTERS = ['slack-bot', 'discord-bot', 'telegram-bot', 'webex-bot', 'github', 'sentry'] as const
type SettableAdapter = (typeof SETTABLE_ADAPTERS)[number]

const setSub = defineCommand({
  meta: {
    name: 'set',
    description: 'rotate credentials of an already-configured channel adapter (symmetric with `typeclaw provider set`)',
  },
  args: {
    adapter: {
      type: 'positional',
      description: `which adapter to rotate (${SETTABLE_ADAPTERS.join(' | ')}); omit to pick interactively`,
      required: false,
    },
  },
  async run({ args }) {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()

    if (!isInitialized(cwd)) {
      console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first, or cd into an agent folder.'))
      process.exit(1)
    }

    const configured = await readConfiguredChannels(cwd)

    if (args.adapter === 'kakaotalk') {
      console.error(
        errorLine(
          'KakaoTalk uses an interactive auth flow (phone passcode + device_uuid). Use `typeclaw channel reauth kakaotalk` to rotate its credentials.',
        ),
      )
      process.exit(1)
    }

    if (args.adapter === 'line') {
      console.error(
        errorLine(
          'LINE uses an interactive auth flow (QR or email + PIN). Use `typeclaw channel reauth line` to rotate its credentials.',
        ),
      )
      process.exit(1)
    }

    if (args.adapter === 'instagram') {
      console.error(
        errorLine(
          'Instagram uses a username/password auth flow. Use `typeclaw channel reauth instagram` to rotate its credentials.',
        ),
      )
      process.exit(1)
    }

    const adapter =
      args.adapter === undefined
        ? await pickSettableAdapter(configured)
        : validateSetAdapterArg(args.adapter, configured)

    intro(`Rotating channel: ${CHANNEL_LABELS[adapter]}`)

    await runSet(cwd, adapter)
  },
})

// Adapters that re-authenticate through a full interactive login replay rather
// than a token-field rotation (`channel set`). Discord (User) belongs here — its
// unofficial QR session expires and is refreshed by replaying the QR login, the
// same shape as LINE's QR flow. `discord-bot` stays in SETTABLE_ADAPTERS.
const REAUTHABLE_ADAPTERS = ['line', 'instagram', 'kakaotalk', 'webex', 'discord', 'teams'] as const
type ReauthableAdapter = (typeof REAUTHABLE_ADAPTERS)[number]

const reauthSub = defineCommand({
  meta: {
    name: 'reauth',
    description: `re-authenticate a channel adapter (${REAUTHABLE_ADAPTERS.join(', ')}). Use after a stale-token 401 or to rotate the saved password.`,
  },
  args: {
    adapter: {
      type: 'positional',
      description: `which adapter to re-authenticate (${REAUTHABLE_ADAPTERS.join(' | ')})`,
      required: false,
    },
  },
  async run({ args }) {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()

    if (!isInitialized(cwd)) {
      console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first, or cd into an agent folder.'))
      process.exit(1)
    }

    const configured = await readConfiguredChannels(cwd)
    const adapter = await resolveReauthableAdapter(args.adapter, configured)

    intro(`Re-authenticating channel: ${CHANNEL_LABELS[adapter]}`)

    await runReauth(cwd, adapter)
  },
})

const listSub = defineCommand({
  meta: {
    name: 'list',
    description: 'list channel adapters configured for this agent',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'emit channels as JSON',
      default: false,
    },
  },
  async run({ args }) {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()
    if (!isInitialized(cwd)) {
      console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first, or cd into an agent folder.'))
      process.exit(1)
    }
    const channels = listChannels(cwd)
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ channels }, null, 2)}\n`)
      return
    }
    process.stdout.write(`${formatChannelList(channels)}\n`)
  },
})

const removeSub = defineCommand({
  meta: {
    name: 'remove',
    description: 'remove a channel adapter from typeclaw.json and secrets.json',
  },
  args: {
    adapter: {
      type: 'positional',
      description: `which adapter to remove (${CHANNEL_KINDS.join(' | ')}); omit to pick interactively`,
      required: false,
    },
    yes: {
      type: 'boolean',
      description: 'skip the confirmation prompt',
      default: false,
    },
  },
  async run({ args }) {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()
    if (!isInitialized(cwd)) {
      console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first, or cd into an agent folder.'))
      process.exit(1)
    }

    const present = presentChannels(listChannels(cwd))
    if (present.length === 0) {
      console.error(errorLine('No channels are configured. Nothing to remove.'))
      process.exit(1)
    }

    const adapter =
      args.adapter === undefined ? await pickChannelToRemove(present) : validateRemoveAdapterArg(args.adapter, present)

    if (args.yes !== true) {
      const confirmed = await confirm({
        message: `Remove the ${CHANNEL_LABELS[adapter]} channel? This deletes its config and credentials.`,
        initialValue: false,
      })
      if (isCancel(confirmed) || !confirmed) {
        cancel('Aborted.')
        process.exit(0)
      }
    }

    const result = removeChannel(cwd, adapter)
    if (!result.ok) {
      console.error(errorLine(result.reason))
      process.exit(1)
    }

    process.stdout.write(`${successLine(`Removed ${CHANNEL_LABELS[adapter]} channel.`)}\n`)
    if (adapter === 'sentry')
      log.info(
        'Sentry Custom Integration은 삭제하지 않았습니다. 수신을 종료하려면 Sentry에서 해당 Integration의 웹훅 설정도 변경하세요.',
      )
    if (result.githubCleanup !== undefined) printGithubCleanup(result.githubCleanup)
    if (result.hadRemoteWebhooks) {
      log.warn(
        'GitHub webhooks registered on your repositories were NOT deleted. Remove them by hand at https://github.com/<owner>/<repo>/settings/hooks.',
      )
    }

    await maybePromptRestart(cwd, adapter, 'removed')
  },
})

export const channelCommand = defineCommand({
  meta: {
    name: 'channel',
    description: 'manage channel adapters wired into the agent',
  },
  subCommands: {
    add: addSub,
    set: setSub,
    reauth: reauthSub,
    list: listSub,
    remove: removeSub,
  },
})

function presentChannels(entries: ChannelListEntry[]): ChannelKind[] {
  return entries.map((entry) => entry.kind)
}

async function pickChannelToRemove(present: ChannelKind[]): Promise<ChannelKind> {
  if (present.length === 1) return present[0]!
  const selected = await select<ChannelKind>({
    message: 'Pick a channel to remove',
    options: present.map((kind) => ({ value: kind, label: CHANNEL_LABELS[kind] })),
    initialValue: present[0],
  })
  if (isCancel(selected)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return selected
}

function validateRemoveAdapterArg(adapter: string, present: ChannelKind[]): ChannelKind {
  if (!isChannelKind(adapter)) {
    console.error(errorLine(`Unknown adapter "${adapter}". Expected one of: ${CHANNEL_KINDS.join(', ')}.`))
    process.exit(1)
  }
  if (!present.includes(adapter)) {
    console.error(
      errorLine(
        `${CHANNEL_LABELS[adapter]} ("${adapter}") is not configured. Run \`typeclaw channel list\` to see what is.`,
      ),
    )
    process.exit(1)
  }
  return adapter
}

function formatChannelList(channels: ChannelListEntry[]): string {
  if (channels.length === 0) return c.dim('No channels configured.')

  const kindWidth = Math.max(4, ...channels.map((ch) => ch.kind.length))
  const statusWidth = Math.max(6, ...channels.map((ch) => channelStatusText(ch).length))
  const lines: string[] = []
  lines.push(c.dim(`${'KIND'.padEnd(kindWidth)}  ${'STATUS'.padEnd(statusWidth)}  DETAIL`))
  for (const ch of channels) {
    const statusText = channelStatusText(ch)
    const status = channelStatusOk(ch)
      ? c.green(statusText.padEnd(statusWidth))
      : c.yellow(statusText.padEnd(statusWidth))
    const detail = ch.detail ?? ''
    lines.push(`${ch.kind.padEnd(kindWidth)}  ${status}  ${c.dim(detail)}`)
  }
  return lines.join('\n')
}

function channelStatusOk(ch: ChannelListEntry): boolean {
  return ch.configured && ch.hasSecrets && ch.enabled
}

function channelStatusText(ch: ChannelListEntry): string {
  if (!ch.configured) return 'secrets-only'
  if (!ch.hasSecrets) return 'no-secrets'
  if (!ch.enabled) return 'disabled'
  return 'ready'
}

function printGithubCleanup(cleanup: GithubConfigCleanup): void {
  const parts: string[] = []
  if (cleanup.tunnelsRemoved > 0) {
    parts.push(`removed ${cleanup.tunnelsRemoved} GitHub webhook tunnel${cleanup.tunnelsRemoved === 1 ? '' : 's'}`)
  }
  if (cleanup.matchRulesRemoved.length > 0) {
    parts.push(
      `removed ${cleanup.matchRulesRemoved.length} repo match rule${cleanup.matchRulesRemoved.length === 1 ? '' : 's'}`,
    )
  }
  if (parts.length > 0) process.stdout.write(`${c.dim(`Also ${parts.join(', ')}.`)}\n`)
  if (cleanup.matchRulesKept.length > 0) {
    log.warn(
      `Left ${cleanup.matchRulesKept.length} other \`github:\` match rule(s) in roles.member untouched: ${cleanup.matchRulesKept.join(', ')}.`,
    )
  }
}

async function resolveReauthableAdapter(
  requested: string | undefined,
  configured: Set<ChannelKind>,
): Promise<ReauthableAdapter> {
  if (requested !== undefined) {
    if (!isReauthableAdapter(requested)) {
      console.error(errorLine(reauthAdapterRejectionMessage(requested)))
      process.exit(1)
    }
    if (!configured.has(requested)) {
      console.error(
        errorLine(
          `${CHANNEL_LABELS[requested]} ("${requested}") is not configured in typeclaw.json. Run \`typeclaw channel add ${requested}\` first.`,
        ),
      )
      process.exit(1)
    }
    return requested
  }

  const available = REAUTHABLE_ADAPTERS.filter((kind) => configured.has(kind))
  if (available.length === 0) {
    console.error(
      errorLine(
        `No reauth-capable channels are configured. Run \`typeclaw channel add ${REAUTHABLE_ADAPTERS[0]}\` first.`,
      ),
    )
    process.exit(1)
  }
  if (available.length === 1) return available[0]!

  const selected = await select<ReauthableAdapter>({
    message: 'Pick a channel to re-authenticate',
    options: available.map((kind) => ({ value: kind, label: CHANNEL_LABELS[kind] })),
    initialValue: available[0],
  })
  if (isCancel(selected)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return selected
}

function isReauthableAdapter(value: string): value is ReauthableAdapter {
  return (REAUTHABLE_ADAPTERS as ReadonlyArray<string>).includes(value)
}

// Returns the string (rather than exiting inline) so the routing stays testable.
export function reauthAdapterRejectionMessage(adapter: string): string {
  if (isSettableAdapter(adapter)) {
    return `Adapter "${adapter}" does not support reauth. Use \`typeclaw channel set ${adapter}\` to rotate its credentials.`
  }
  return `Adapter "${adapter}" does not support reauth. Supported: ${REAUTHABLE_ADAPTERS.join(', ')}.`
}

async function runReauth(cwd: string, adapter: ReauthableAdapter): Promise<void> {
  switch (adapter) {
    case 'line':
      await runLineReauth(cwd)
      return
    case 'instagram':
      await runInstagramReauth(cwd)
      return
    case 'kakaotalk':
      await runKakaotalkReauth(cwd)
      return
    case 'webex':
      await runWebexReauth(cwd)
      return
    case 'discord':
      await runDiscordReauth(cwd)
      return
    case 'teams':
      await runTeamsReauth(cwd)
      return
  }
}

async function runTeamsReauth(cwd: string): Promise<void> {
  const accountType = await promptTeamsAccountType()
  const result = await runTeamsBootstrap({ agentDir: cwd, accountType, callbacks: teamsDeviceCodeCallbacks() })
  if (!result.ok) {
    console.error(errorLine(`Teams login failed: ${result.reason}`))
    process.exit(1)
  }
  process.stdout.write(`${successLine('Teams credentials refreshed in secrets.json.')}\n`)

  await maybePromptReauthRefresh(cwd, 'teams')
}

async function runInstagramReauth(cwd: string): Promise<void> {
  const creds = await promptInstagramCredentials()
  const s = spinner()
  s.start('Logging in to Instagram...')
  const result = await runInstagramBootstrap({
    username: creds.username,
    password: creds.password,
    agentDir: cwd,
    callbacks: instagramLoginCallbacks({ pause: () => s.stop(), resume: (message) => s.start(message) }),
  })
  if (!result.ok) {
    s.stop(`Instagram login failed: ${result.reason}`)
    process.exit(1)
  }
  s.stop('Instagram credentials refreshed in secrets.json.')

  await maybePromptReauthRefresh(cwd, 'instagram')
}

async function runLineReauth(cwd: string): Promise<void> {
  const holder: LineAuthSpinnerHolder = { current: null }
  const login = await promptLineLogin(holderSpinnerControl(holder))
  const s = spinner()
  s.start('Logging in to LINE...')
  holder.current = s
  const result = await runLineBootstrap({ ...login, agentDir: cwd })
  holder.current = null
  if (!result.ok) {
    s.stop(`LINE login failed: ${result.reason}`)
    process.exit(1)
  }
  s.stop('LINE credentials refreshed in secrets.json.')

  await maybePromptReauthRefresh(cwd, 'line')
}

async function runKakaotalkReauth(cwd: string): Promise<void> {
  const existingEmail = await readExistingKakaotalkEmail(cwd)
  const creds = await promptKakaotalkCredentials({ defaultEmail: existingEmail })

  const s = spinner()
  s.start('Logging in to KakaoTalk...')
  const result = await runKakaotalkBootstrap({
    email: creds.email,
    password: creds.password,
    agentDir: cwd,
    callbacks: {
      onPasscode: (code) => log.info(`Confirm this passcode on your phone: ${code}`),
    },
  })
  if (!result.ok) {
    s.stop(`KakaoTalk login failed: ${result.reason}`)
    process.exit(1)
  }
  s.stop('KakaoTalk credentials refreshed in secrets.json.')

  await maybePromptReauthRefresh(cwd, 'kakaotalk')
}

async function runWebexReauth(cwd: string): Promise<void> {
  const existingEmail = await readExistingWebexEmail(cwd)
  const creds = await promptWebexCredentials({ defaultEmail: existingEmail })

  const s = spinner()
  s.start('Logging in to Webex...')
  const result = await runWebexBootstrap({ email: creds.email, password: creds.password, agentDir: cwd })
  if (!result.ok) {
    s.stop(`Webex login failed: ${result.reason}`)
    process.exit(1)
  }
  s.stop('Webex credentials refreshed in secrets.json.')

  await maybePromptReauthRefresh(cwd, 'webex')
}

async function runDiscordReauth(cwd: string): Promise<void> {
  const result = await runDiscordBootstrap({ agentDir: cwd, onQrUrl: renderDiscordQrToTerminal })
  if (!result.ok) {
    console.error(errorLine(`Discord login failed: ${result.reason}`))
    process.exit(1)
  }
  process.stdout.write(`${successLine('Discord credentials refreshed in secrets.json.')}\n`)

  await maybePromptReauthRefresh(cwd, 'discord')
}

async function readExistingKakaotalkEmail(cwd: string): Promise<string | undefined> {
  try {
    const store = new SecretsKakaoCredentialStore({ mode: 'host', secretsPath: `${cwd}/secrets.json` })
    const account = await store.getAccountWithRenewalFields()
    return account?.email ?? undefined
  } catch {
    // First-time reauth or a brand-new agent dir: no account yet, prompt from scratch.
    return undefined
  }
}

async function readExistingWebexEmail(cwd: string): Promise<string | undefined> {
  try {
    const store = new SecretsWebexCredentialStore({ mode: 'host', secretsPath: `${cwd}/secrets.json` })
    const account = await store.getAccountWithRenewalFields()
    return account?.email ?? undefined
  } catch {
    return undefined
  }
}

// The renewed tokens are already on disk via secrets.json. What still needs
// to happen depends on the running adapter's state:
//   - Container NOT running → nothing to do; next `typeclaw start` picks them up.
//   - Container running, adapter previously 401'd → `typeclaw reload` re-runs
//     startAdapter, which loads the fresh tokens.
//   - Container running, adapter currently live (e.g. proactive rotation) →
//     reload will report `restart-required` because tokens are captured at
//     start time; `typeclaw restart` is needed to actually pick them up.
// We can't reliably distinguish the last two cases from outside the container
// without calling reload first, so the next-step hints surface both paths.
async function maybePromptReauthRefresh(cwd: string, adapter: ReauthableAdapter): Promise<void> {
  await maybePromptCredentialRefresh(cwd, CHANNEL_LABELS[adapter], 're-authenticated')
}

async function maybePromptCredentialRefresh(
  cwd: string,
  label: string,
  verbPast: 're-authenticated' | 'credentials updated',
): Promise<void> {
  const controller = resolveController()
  const current = await controller.status({ cwd }).catch(() => null)
  if (current === null || current.kind !== 'running') {
    done({
      title: c.green(`${label} ${verbPast}.`),
      hints: [
        { label: 'Start the agent:', command: 'typeclaw start' },
        { label: 'Then check status:', command: 'typeclaw status' },
      ],
    })
    return
  }

  const restartNow = await confirm({
    message:
      'The agent container is running. Restart it now so the adapter picks up the fresh credentials (recommended)?',
    initialValue: true,
  })
  if (isCancel(restartNow) || !restartNow) {
    done({
      title: c.green(`${label} ${verbPast}.`),
      hints: [
        { label: 'Try a live reload first:', command: 'typeclaw reload' },
        { label: 'If reload reports restart-required:', command: 'typeclaw restart' },
      ],
    })
    return
  }

  const restarted = await controller.restart({ cwd, preferredHostPort: config.port, cliEntry: process.argv[1] })
  if (!restarted.ok) {
    console.error(errorLine(formatRestartFailure(restarted.reason)))
    process.exit(1)
  }
  const started = restarted.start
  done({
    title: c.green(`${label} ${verbPast}. Restarted ${started.plan.containerName} on host port ${started.hostPort}.`),
    hints: [
      { label: 'Attach TUI:', command: 'typeclaw tui' },
      { label: 'Follow logs:', command: 'typeclaw logs -f' },
    ],
  })
}

function validateAdapterArg(adapter: string, configured: Set<ChannelKind>): ChannelKind {
  if (!isChannelKind(adapter)) {
    console.error(errorLine(`Unknown adapter "${adapter}". Expected one of: ${ADDABLE_CHANNEL_KINDS.join(', ')}.`))
    process.exit(1)
  }
  if (!(ADDABLE_CHANNEL_KINDS as ReadonlyArray<string>).includes(adapter)) {
    console.error(
      errorLine(
        `${CHANNEL_LABELS[adapter]} ("${adapter}") has no interactive auth yet. Populate secrets.json#channels.${adapter} manually.`,
      ),
    )
    process.exit(1)
  }
  if (configured.has(adapter)) {
    console.error(
      errorLine(
        `${CHANNEL_LABELS[adapter]} ("${adapter}") is already configured in typeclaw.json. Edit the file directly to change its configuration.`,
      ),
    )
    process.exit(1)
  }
  return adapter
}

function isChannelKind(value: string): value is ChannelKind {
  return (CHANNEL_KINDS as ReadonlyArray<string>).includes(value)
}

async function pickChannel(configured: Set<ChannelKind>): Promise<ChannelKind> {
  const available = ADDABLE_CHANNEL_KINDS.filter((kind) => !configured.has(kind))
  if (available.length === 0) {
    console.error(errorLine('All supported channel adapters are already configured in typeclaw.json. Nothing to add.'))
    process.exit(0)
  }

  type FamilyValue = 'webex-family' | 'slack-family' | 'discord-family'
  type FlatKind = Exclude<ChannelKind, 'webex' | 'webex-bot' | 'slack' | 'slack-bot' | 'discord' | 'discord-bot'>
  type PickerValue = FlatKind | FamilyValue
  const options: Array<{ value: PickerValue; label: string }> = []
  for (const kind of available) {
    const family = FAMILY_OF[kind]
    if (family !== undefined) {
      if (!options.some((option) => option.value === family.value))
        options.push({ value: family.value, label: family.label })
      continue
    }
    options.push({ value: kind as FlatKind, label: CHANNEL_LABELS[kind] })
  }

  const selected = await select<PickerValue>({
    message: 'Pick a channel to add',
    options,
    initialValue: options[0]?.value,
  })
  if (isCancel(selected)) {
    cancel('Aborted.')
    process.exit(0)
  }
  if (selected === 'webex-family') return pickWebexMode(available)
  if (selected === 'slack-family') return pickSlackMode(available)
  if (selected === 'discord-family') return pickDiscordMode(available)
  return selected
}

const FAMILY_OF: Partial<Record<ChannelKind, { value: FamilyValue; label: string }>> = {
  webex: { value: 'webex-family', label: 'Webex' },
  'webex-bot': { value: 'webex-family', label: 'Webex' },
  slack: { value: 'slack-family', label: 'Slack' },
  'slack-bot': { value: 'slack-family', label: 'Slack' },
  discord: { value: 'discord-family', label: 'Discord' },
  'discord-bot': { value: 'discord-family', label: 'Discord' },
}

type FamilyValue = 'webex-family' | 'slack-family' | 'discord-family'

type FamilyMode<K extends ChannelKind> = { value: K; label: string }

export const WEBEX_MODES: ReadonlyArray<FamilyMode<'webex' | 'webex-bot'>> = [
  { value: 'webex', label: 'User (ID/PW) — receives all messages, no @mention needed (recommended)' },
  { value: 'webex-bot', label: 'Bot (Token) — only sees @mentions in group spaces' },
]

export const SLACK_MODES: ReadonlyArray<FamilyMode<'slack' | 'slack-bot'>> = [
  { value: 'slack-bot', label: 'Bot (Token) — posts as a Slack app/bot user (recommended)' },
  { value: 'slack', label: 'User (QR) — posts as your own Slack account; unofficial session, may need re-auth' },
]

export const DISCORD_MODES: ReadonlyArray<FamilyMode<'discord' | 'discord-bot'>> = [
  { value: 'discord-bot', label: 'Bot (Token) — posts as a Discord app/bot user (recommended)' },
  { value: 'discord', label: 'User (QR) — posts as your own Discord account; unofficial session, may need re-auth' },
]

// Keep the displayed order (recommended/User first), dropping already-configured
// modes. The caller defaults the selection to options[0], so this order — NOT
// CHANNEL_KINDS order — decides which mode is preselected.
export function familyModeOptions<K extends ChannelKind>(
  modes: ReadonlyArray<FamilyMode<K>>,
  available: ReadonlyArray<ChannelKind>,
): Array<FamilyMode<K>> {
  return modes.filter((mode) => available.includes(mode.value))
}

async function pickWebexMode(available: ReadonlyArray<ChannelKind>): Promise<'webex' | 'webex-bot'> {
  const options = familyModeOptions(WEBEX_MODES, available)
  if (options.length === 1) return options[0]!.value
  const mode = await select<'webex' | 'webex-bot'>({
    message: 'Which Webex mode?',
    options: options.map((o) => ({ value: o.value, label: o.label })),
    initialValue: options[0]?.value,
  })
  if (isCancel(mode)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return mode
}

async function pickSlackMode(available: ReadonlyArray<ChannelKind>): Promise<'slack' | 'slack-bot'> {
  const options = familyModeOptions(SLACK_MODES, available)
  if (options.length === 1) return options[0]!.value
  const mode = await select<'slack' | 'slack-bot'>({
    message: 'Which Slack mode?',
    options: options.map((o) => ({ value: o.value, label: o.label })),
    initialValue: options[0]?.value,
  })
  if (isCancel(mode)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return mode
}

async function pickDiscordMode(available: ReadonlyArray<ChannelKind>): Promise<'discord' | 'discord-bot'> {
  const options = familyModeOptions(DISCORD_MODES, available)
  if (options.length === 1) return options[0]!.value
  const mode = await select<'discord' | 'discord-bot'>({
    message: 'Which Discord mode?',
    options: options.map((o) => ({ value: o.value, label: o.label })),
    initialValue: options[0]?.value,
  })
  if (isCancel(mode)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return mode
}

function isSettableAdapter(value: string): value is SettableAdapter {
  return (SETTABLE_ADAPTERS as ReadonlyArray<string>).includes(value)
}

// Returns the string (rather than exiting inline) so the routing stays testable.
export function setAdapterRejectionMessage(adapter: string): string {
  if (isReauthableAdapter(adapter)) {
    return `Adapter "${adapter}" does not support \`channel set\`. Use \`typeclaw channel reauth ${adapter}\` instead.`
  }
  if (isChannelKind(adapter)) {
    return `Adapter "${adapter}" does not support \`channel set\`. Rotate its credentials by removing and re-adding it: \`typeclaw channel remove ${adapter} && typeclaw channel add ${adapter}\`.`
  }
  return `Unknown adapter "${adapter}". Expected one of: ${SETTABLE_ADAPTERS.join(', ')}.`
}

function validateSetAdapterArg(adapter: string, configured: Set<ChannelKind>): SettableAdapter {
  if (!isSettableAdapter(adapter)) {
    console.error(errorLine(setAdapterRejectionMessage(adapter)))
    process.exit(1)
  }
  if (!configured.has(adapter)) {
    console.error(
      errorLine(
        `${CHANNEL_LABELS[adapter]} ("${adapter}") is not configured in typeclaw.json. Run \`typeclaw channel add ${adapter}\` first.`,
      ),
    )
    process.exit(1)
  }
  return adapter
}

async function pickSettableAdapter(configured: Set<ChannelKind>): Promise<SettableAdapter> {
  const available = SETTABLE_ADAPTERS.filter((kind) => configured.has(kind))
  if (available.length === 0) {
    console.error(
      errorLine(
        'No rotatable channels are configured. Run `typeclaw channel add <adapter>` first, or use `typeclaw channel reauth kakaotalk` for KakaoTalk.',
      ),
    )
    process.exit(1)
  }
  if (available.length === 1) return available[0]!

  const selected = await select<SettableAdapter>({
    message: 'Pick a channel to rotate credentials for',
    options: available.map((kind) => ({ value: kind, label: CHANNEL_LABELS[kind] })),
    initialValue: available[0],
  })
  if (isCancel(selected)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return selected
}

async function runSet(cwd: string, adapter: SettableAdapter): Promise<void> {
  switch (adapter) {
    case 'discord-bot':
      await runSetDiscord(cwd)
      break
    case 'telegram-bot':
      await runSetTelegram(cwd)
      break
    case 'webex-bot':
      await runSetWebex(cwd)
      break
    case 'slack-bot':
      await runSetSlack(cwd)
      break
    case 'sentry':
      await runSetSentry(cwd)
      break
    case 'github':
      await runSetGithub(cwd)
      break
  }
}

async function runSetDiscord(cwd: string): Promise<void> {
  const token = await promptDiscordToken()
  const result = await setChannelSecrets(cwd, 'discord-bot', { token })
  if (!result.ok) {
    console.error(errorLine(result.reason))
    process.exit(1)
  }
  await maybePromptCredentialRefresh(cwd, CHANNEL_LABELS['discord-bot'], 'credentials updated')
}

async function runSetTelegram(cwd: string): Promise<void> {
  const token = await promptTelegramToken()
  const result = await setChannelSecrets(cwd, 'telegram-bot', { token })
  if (!result.ok) {
    console.error(errorLine(result.reason))
    process.exit(1)
  }
  await maybePromptCredentialRefresh(cwd, CHANNEL_LABELS['telegram-bot'], 'credentials updated')
}

async function runSetWebex(cwd: string): Promise<void> {
  const token = await promptWebexToken()
  const result = await setChannelSecrets(cwd, 'webex-bot', { token })
  if (!result.ok) {
    console.error(errorLine(result.reason))
    process.exit(1)
  }
  await maybePromptCredentialRefresh(cwd, CHANNEL_LABELS['webex-bot'], 'credentials updated')
}

type SlackSetChoice = 'bot' | 'app' | 'both'

async function runSetSlack(cwd: string): Promise<void> {
  note(
    [
      'Rotate at https://api.slack.com/apps → your app:',
      '  Bot token  (xoxb-...) — OAuth & Permissions → Reset Token.',
      '  App-level token (xapp-...) — Basic Information → App-Level Tokens → Revoke and regenerate.',
      'Slack only shows the app-level token once on screen — copy it before closing.',
    ].join('\n'),
    'Rotate the Slack tokens',
  )
  const choice = await select<SlackSetChoice>({
    message: 'Which Slack token do you want to rotate?',
    options: [
      { value: 'bot', label: 'Bot user token (xoxb-...) — used to post messages as the bot (recommended)' },
      { value: 'app', label: 'App-level token (xapp-...) — required for Socket Mode' },
      { value: 'both', label: 'Both tokens — rotate the bot token and the app-level token' },
    ],
    initialValue: 'bot',
  })
  if (isCancel(choice)) {
    cancel('Aborted.')
    process.exit(0)
  }

  const tokens: Record<string, string> = {}
  if (choice === 'bot' || choice === 'both') tokens.botToken = await promptSlackBotToken()
  if (choice === 'app' || choice === 'both') tokens.appToken = await promptSlackAppToken()

  const result = await setChannelSecrets(cwd, 'slack-bot', tokens)
  if (!result.ok) {
    console.error(errorLine(result.reason))
    process.exit(1)
  }
  await maybePromptCredentialRefresh(cwd, CHANNEL_LABELS['slack-bot'], 'credentials updated')
}

type GithubSetChoice = 'auth' | 'webhook' | 'both'

async function runSetGithub(cwd: string): Promise<void> {
  const authType = readGithubAuthType(cwd)
  if (authType === null) {
    console.error(
      errorLine(
        'GitHub auth block is missing or malformed in secrets.json. Run `typeclaw channel add github` first, or fix the file by hand.',
      ),
    )
    process.exit(1)
  }
  const authLabel =
    authType === 'pat'
      ? 'Auth credential — rotate the PAT, or switch to GitHub App auth (recommended)'
      : 'Auth credential — rotate the App private key, or switch to PAT auth (recommended)'
  const choice = await select<GithubSetChoice>({
    message: 'Which GitHub secret do you want to update?',
    options: [
      { value: 'auth', label: authLabel },
      { value: 'webhook', label: 'Webhook secret — shared secret for verifying GitHub payloads' },
      { value: 'both', label: 'Both secrets — update the auth credential and the webhook secret' },
    ],
    initialValue: 'auth',
  })
  if (isCancel(choice)) {
    cancel('Aborted.')
    process.exit(0)
  }

  const patch: GithubCredentialPatch = {}

  if (choice === 'auth' || choice === 'both') {
    patch.auth = await promptGithubAuthUpdate(authType)
  }

  if (choice === 'webhook' || choice === 'both') {
    const secret = await password({
      message: 'New webhook secret (leave blank to auto-generate)',
    })
    if (isCancel(secret)) {
      cancel('Aborted.')
      process.exit(0)
    }
    const enteredSecret = typeof secret === 'string' ? secret : ''
    patch.webhookSecret = enteredSecret.length > 0 ? enteredSecret : randomBytes(32).toString('hex')
  }

  const result = await setGithubSecrets(cwd, patch)
  if (!result.ok) {
    console.error(errorLine(result.reason))
    process.exit(1)
  }
  await maybePromptCredentialRefresh(cwd, CHANNEL_LABELS.github, 'credentials updated')
}

type CollectedCredentials =
  | { channel: 'discord'; runDiscordAuth: (options: { cwd: string }) => Promise<DiscordAuthResult> }
  | ({ channel: 'sentry' } & SentryInitCredentials)
  | { channel: 'discord-bot'; discordBotToken: string }
  | {
      channel: 'slack'
      slackQrDataUrl: string
      runSlackAuth: (options: { cwd: string; qrDataUrl: string }) => Promise<SlackAuthResult>
    }
  | { channel: 'slack-bot'; slackBotToken: string; slackAppToken: string }
  | { channel: 'telegram-bot'; telegramBotToken: string }
  | { channel: 'webex'; runWebexAuth: (options: { cwd: string }) => Promise<WebexAuthResult> }
  | { channel: 'webex-bot'; webexBotToken: string }
  | { channel: 'teams'; runTeamsAuth: (options: { cwd: string }) => Promise<TeamsAuthResult> }
  | { channel: 'instagram'; runInstagramAuth: (options: { cwd: string }) => Promise<InstagramAuthResult> }
  | { channel: 'line'; runLineAuth: (options: { cwd: string }) => Promise<LineAuthResult> }
  | { channel: 'kakaotalk'; runKakaotalkAuth: (options: { cwd: string }) => Promise<KakaotalkAuthResult> }
  | ({ channel: 'github' } & GithubInitCredentials)

async function collectCredentials(
  channel: ChannelKind,
  cwd: string,
  lineSpinnerHolder?: LineAuthSpinnerHolder,
): Promise<CollectedCredentials> {
  switch (channel) {
    case 'discord':
      return { channel, runDiscordAuth: ({ cwd: agentDir }) => runDiscordQrAuth(agentDir) }
    case 'discord-bot':
      return { channel, discordBotToken: await promptDiscordToken() }
    case 'slack-bot': {
      const slack = await promptSlackTokens()
      return { channel, slackBotToken: slack.bot, slackAppToken: slack.app }
    }
    case 'slack': {
      const qrDataUrl = await promptSlackQrDataUrl()
      return {
        channel,
        slackQrDataUrl: qrDataUrl,
        runSlackAuth: ({ cwd: agentDir, qrDataUrl }) => runSlackBootstrap({ qrDataUrl, agentDir }),
      }
    }
    case 'telegram-bot':
      return { channel, telegramBotToken: await promptTelegramToken() }
    case 'webex': {
      const creds = await promptWebexCredentials()
      return {
        channel,
        runWebexAuth: ({ cwd: agentDir }) =>
          runWebexBootstrap({ email: creds.email, password: creds.password, agentDir }),
      }
    }
    case 'webex-bot':
      return { channel, webexBotToken: await promptWebexToken() }
    case 'teams': {
      const accountType = await promptTeamsAccountType()
      return {
        channel,
        runTeamsAuth: ({ cwd: agentDir }) =>
          runTeamsBootstrap({ agentDir, accountType, callbacks: teamsDeviceCodeCallbacks() }),
      }
    }
    case 'instagram': {
      const creds = await promptInstagramCredentials()
      const callbacks = instagramLoginCallbacks(lineSpinnerHolder ? holderSpinnerControl(lineSpinnerHolder) : undefined)
      return {
        channel,
        runInstagramAuth: ({ cwd: agentDir }) =>
          runInstagramBootstrap({ username: creds.username, password: creds.password, agentDir, callbacks }),
      }
    }
    case 'line': {
      const login = await promptLineLogin(lineSpinnerHolder ? holderSpinnerControl(lineSpinnerHolder) : undefined)
      return {
        channel,
        runLineAuth: ({ cwd: agentDir }) => runLineBootstrap({ ...login, agentDir }),
      }
    }
    case 'kakaotalk': {
      const creds = await promptKakaotalkCredentials()
      return {
        channel,
        runKakaotalkAuth: ({ cwd: agentDir }) =>
          runKakaotalkBootstrap({
            email: creds.email,
            password: creds.password,
            agentDir,
            callbacks: { onPasscode: (code) => log.info(`Confirm this passcode on your phone: ${code}`) },
          }),
      }
    }
    case 'sentry': {
      const creds = await promptSentryCredentials(cwd)
      if (creds === null) {
        cancel('취소했습니다.')
        process.exit(0)
      }
      return { channel, ...creds }
    }
    case 'github': {
      const creds = await promptGithubCredentials(cwd)
      return { channel, ...creds }
    }
  }
}

async function runDiscordQrAuth(agentDir: string): Promise<DiscordAuthResult> {
  return await runDiscordBootstrap({ agentDir, onQrUrl: renderDiscordQrToTerminal })
}

async function renderDiscordQrToTerminal(url: string): Promise<void> {
  const qr = await QRCode.toString(url, { type: 'terminal', small: true })
  note(
    [`Open Discord mobile app → Settings → scan QR.`, '', qr, '', 'Approve the login on your phone to continue.'].join(
      '\n',
    ),
    'Discord QR login',
  )
}

type SentrySetChoice = 'auth' | 'webhook' | 'both'

async function runSetSentry(cwd: string): Promise<void> {
  const authType = readSentryAuthType(cwd)
  if (authType === null) {
    console.error(errorLine('Sentry 인증 설정이 없습니다. `typeclaw channel add sentry`를 먼저 실행하세요.'))
    process.exit(1)
  }
  const choice = await select<SentrySetChoice>({
    message: '변경할 Sentry 인증 정보',
    options: [
      { value: 'auth', label: '인증 토큰 교체 또는 인증 방식 전환' },
      { value: 'webhook', label: '웹훅 서명용 Client Secret 교체' },
      { value: 'both', label: '인증 토큰과 Client Secret 모두 변경' },
    ],
    initialValue: 'auth',
  })
  if (isCancel(choice)) return
  const patch: SentryCredentialPatch = {}
  if (choice === 'auth' || choice === 'both') {
    const auth = await promptSentryAuthUpdate(authType)
    if (auth === null) return
    patch.auth = auth
  }
  if (choice === 'webhook' || choice === 'both') {
    const webhookSecret = await password({
      message: 'Custom Integration의 새 Client Secret',
      validate: (value) => (value ? undefined : '기존 Client Secret을 입력하세요.'),
    })
    if (isCancel(webhookSecret)) return
    patch.webhookSecret = webhookSecret
  }
  let webhookUrl: string | undefined
  if (patch.auth?.type === 'app') {
    const tunnel = config.tunnels.find((entry) => entry.for.kind === 'channel' && entry.for.name === 'sentry')
    const fixedUrl =
      config.channels.sentry?.webhookUrl ??
      (tunnel?.provider === 'cloudflare-named'
        ? tunnel.hostname
        : tunnel?.provider === 'external'
          ? tunnel.externalUrl
          : undefined)
    if (fixedUrl === undefined) {
      const entered = await text({
        message: 'Sentry에 직접 등록할 고정 공개 웹훅 URL (준비한 외부 URL)',
        validate: (value) => validateUrl(value ?? '', '고정 웹훅 URL을 입력하세요.'),
      })
      if (isCancel(entered)) return
      webhookUrl = entered
    }
  }
  const result = await setSentrySecrets(cwd, patch)
  if (!result.ok) {
    console.error(errorLine(result.reason))
    process.exit(1)
  }
  if (webhookUrl !== undefined) {
    const configured = setChannelWebhookUrl(cwd, 'sentry', webhookUrl)
    if (!configured.ok) {
      console.error(errorLine(configured.reason))
      process.exit(1)
    }
    log.info(`Sentry 통합 설정에 고정 웹훅 URL ${webhookUrl}를 직접 등록하세요.`)
  }
  await maybePromptCredentialRefresh(cwd, CHANNEL_LABELS.sentry, 'credentials updated')
}

async function promptSentryAuthUpdate(currentType: 'app' | 'pat'): Promise<SentryInitCredentials['auth'] | null> {
  const action = await select<'rotate' | 'switch'>({
    message: 'Sentry 인증 변경 방식',
    options: [
      { value: 'rotate', label: currentType === 'app' ? '현재 앱 토큰 교체' : '현재 개인 토큰 교체' },
      { value: 'switch', label: currentType === 'app' ? '개인 토큰으로 전환' : '앱 토큰으로 전환' },
    ],
    initialValue: 'rotate',
  })
  if (isCancel(action)) return null
  const type = action === 'rotate' ? currentType : currentType === 'app' ? 'pat' : 'app'
  const token = await promptSentryToken(type)
  if (isCancel(token)) return null
  if (type === 'app') note('고정 공개 URL을 사용하고 Sentry 통합 설정에 웹훅 URL을 직접 등록하세요.', 'Sentry 앱 웹훅')
  return { type, token }
}

async function promptSentryToken(type: 'app' | 'pat'): Promise<string | symbol> {
  note(
    type === 'app'
      ? 'Internal Integration의 event:read, event:write 권한 토큰을 사용하세요. 웹훅은 고정 URL을 직접 등록합니다.'
      : '조직 구성원의 org:write, event:read, event:write 권한 개인 토큰을 사용하세요. 웹훅 URL은 자동 갱신합니다.',
    type === 'app' ? 'Sentry 앱 인증' : 'Sentry 개인 인증',
  )
  return password({
    message: type === 'app' ? 'Sentry Internal Integration 앱 토큰' : 'Sentry 개인 인증 토큰',
    validate: (value) => (value ? undefined : '인증 토큰을 입력하세요.'),
  })
}

async function promptGithubCredentials(cwd: string): Promise<GithubInitCredentials> {
  note(
    [
      'Choose PAT auth for a quick setup, or GitHub App auth for expiring installation tokens.',
      githubRequiredPermissionsNote(true),
    ].join('\n'),
    'Get GitHub credentials',
  )
  const authType = await select({
    message: 'GitHub authentication type',
    options: [
      { value: 'pat', label: 'Fine-grained personal access token' },
      { value: 'app', label: 'GitHub App installation token (recommended)' },
    ],
    initialValue: 'app',
  })
  if (isCancel(authType)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const auth = authType === 'pat' ? await promptGithubPatAuth() : await promptGithubAppAuth()
  note('GitHub webhooks need a public URL. TypeClaw can manage a tunnel for you.', 'GitHub webhook tunnel')
  const tunnelProvider = await select<GithubTunnelProvider>({
    message: 'Tunnel provider',
    options: [
      {
        value: 'cloudflare-quick',
        label: 'Cloudflare Quick Tunnel — no signup, URL rotates on restart (recommended)',
      },
      {
        value: 'cloudflare-named',
        label: 'Cloudflare Named Tunnel — stable URL, needs Cloudflare account + domain',
      },
      { value: 'external', label: 'External URL — I have my own reverse proxy / tunnel' },
      { value: 'none', label: 'None — configure later by hand-editing typeclaw.json' },
    ],
    initialValue: 'cloudflare-quick',
  })
  if (isCancel(tunnelProvider)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const webhookUrl =
    tunnelProvider === 'external'
      ? await text({
          message: 'Public webhook URL (GitHub will POST events here)',
          validate: (value) => validateUrl(value ?? '', 'Webhook URL is required'),
        })
      : undefined
  if (isCancel(webhookUrl)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const namedCreds = tunnelProvider === 'cloudflare-named' ? await promptCloudflareNamedTunnel(cwd) : undefined
  if (namedCreds === null) {
    cancel('Aborted.')
    process.exit(0)
  }
  const port = await text({
    message: 'Local webhook port inside the agent container',
    initialValue: '8975',
    validate: (value) => {
      const parsed = Number(value)
      return Number.isInteger(parsed) && parsed > 0 ? undefined : 'Port must be a positive integer'
    },
  })
  if (isCancel(port)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const secret = await password({
    message: 'Webhook secret (leave blank to auto-generate)',
  })
  if (isCancel(secret)) {
    cancel('Aborted.')
    process.exit(0)
  }
  // clack's password() returns `undefined` on an empty submission (it has no
  // validate guard and never coerces to ''), so we normalize before the
  // length checks below to avoid a TypeError on the "leave blank" path.
  const enteredSecret = typeof secret === 'string' ? secret : ''
  const reposRaw = await text({
    message: 'Repositories to allow (comma-separated owner/repo, leave blank to skip)',
  })
  if (isCancel(reposRaw)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const resolvedSecret = enteredSecret.length > 0 ? enteredSecret : randomBytes(32).toString('hex')
  return {
    webhookSecret: resolvedSecret,
    tunnelProvider,
    ...(webhookUrl !== undefined ? { webhookUrl } : {}),
    webhookPort: Number(port),
    ...(namedCreds !== undefined ? namedCreds : {}),
    repos: parseRepos(reposRaw ?? ''),
    auth,
  }
}

async function promptCloudflareNamedTunnel(
  cwd: string,
  tokenEnv = 'CLOUDFLARE_TUNNEL_TOKEN',
): Promise<{ hostname: string; tokenEnv: string } | null> {
  note(
    [
      'Cloudflare Named Tunnel needs a tunnel you created in the Zero Trust dashboard:',
      '  1. Networks → Tunnels → Create a tunnel → Cloudflared. Copy the token shown on the install screen.',
      '  2. Public Hostname tab → Add: subdomain + your-domain, service type HTTP, URL localhost:<webhook port>.',
      `  3. Paste the token below when prompted — TypeClaw will write it to .env as ${tokenEnv}.`,
      'A tunnel without a Public Hostname registers but routes nothing.',
    ].join('\n'),
    'Cloudflare named tunnel',
  )
  const hostname = await text({
    message: 'Public hostname configured in the dashboard (https://...)',
    validate: (value) => validateUrl(value ?? '', 'Hostname is required'),
  })
  if (isCancel(hostname)) return null
  if (!hasEnvKey(cwd, tokenEnv)) {
    const token = await password({
      message: `Cloudflare tunnel token (will be written to .env as ${tokenEnv})`,
      validate: (value) => (value && value.length > 0 ? undefined : 'Token is required'),
    })
    if (isCancel(token)) return null
    appendOrReplaceEnvKey(cwd, tokenEnv, token)
  }
  return { hostname, tokenEnv }
}

type GithubAuthUpdateAction = 'rotate' | 'switch'

async function promptGithubAuthUpdate(currentType: 'pat' | 'app'): Promise<GithubCredentialPatch['auth']> {
  const rotateLabel =
    currentType === 'pat'
      ? 'Rotate the PAT (replace the current personal access token)'
      : 'Rotate the App private key (replace the current GitHub App private key)'
  const switchLabel =
    currentType === 'pat'
      ? 'Switch to GitHub App auth (replace the PAT with App credentials)'
      : 'Switch to PAT auth (replace the App credentials with a personal access token)'
  const action = await select<GithubAuthUpdateAction>({
    message: 'Update the GitHub auth credential',
    options: [
      { value: 'rotate', label: rotateLabel },
      { value: 'switch', label: switchLabel },
    ],
    initialValue: 'rotate',
  })
  if (isCancel(action)) {
    cancel('Aborted.')
    process.exit(0)
  }

  const nextType: 'pat' | 'app' = action === 'rotate' ? currentType : currentType === 'pat' ? 'app' : 'pat'

  if (nextType === 'pat') {
    if (action === 'rotate') {
      note(
        ['Rotate at https://github.com/settings/personal-access-tokens.', githubRequiredPermissionsNote(false)].join(
          '\n',
        ),
        'Rotate the GitHub PAT',
      )
    } else {
      note(
        [
          'Create a fine-grained PAT at https://github.com/settings/personal-access-tokens.',
          githubRequiredPermissionsNote(false),
        ].join('\n'),
        'Switch to GitHub PAT auth',
      )
    }
    return await promptGithubPatAuth()
  }

  if (action === 'rotate') {
    note(
      [
        'Rotate at https://github.com/settings/apps/<your-app> → Private keys → Generate a private key.',
        'GitHub immediately downloads the new .pem. The previous key keeps working until you delete it,',
        'so it is safe to rotate without downtime.',
      ].join('\n'),
      'Rotate the GitHub App private key',
    )
    const privateKey = await promptPrivateKeyPem('New GitHub App private key PEM, escaped PEM, or path to .pem file')
    if (privateKey === CANCEL_SYMBOL) {
      cancel('Aborted.')
      process.exit(0)
    }
    return { type: 'app', privateKey }
  }

  note(
    [
      'Create a GitHub App at https://github.com/settings/apps/new and install it on your repositories.',
      githubRequiredPermissionsNote(false),
      'Then collect the App ID, generate a private key (.pem), and grab the Installation ID from the URL',
      'of the installation page (https://github.com/settings/installations/<installation-id>).',
    ].join('\n'),
    'Switch to GitHub App auth',
  )
  return await promptGithubAppAuth()
}

async function promptGithubPatAuth(): Promise<{ type: 'pat'; pat: string }> {
  const pat = await password({
    message: 'GitHub fine-grained PAT',
    validate: (value) => (value && value.length > 0 ? undefined : 'PAT is required'),
  })
  if (isCancel(pat)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return { type: 'pat', pat }
}

async function promptGithubAppAuth(): Promise<{
  type: 'app'
  appId: number
  privateKey: string
}> {
  const appId = await text({
    message: 'GitHub App ID',
    validate: (value) => validatePositiveInteger(value ?? '', 'App ID is required'),
  })
  if (isCancel(appId)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const privateKey = await promptPrivateKeyPem('GitHub App private key PEM, escaped PEM, or path to .pem file')
  if (privateKey === CANCEL_SYMBOL) {
    cancel('Aborted.')
    process.exit(0)
  }
  return {
    type: 'app',
    appId: Number(appId),
    privateKey,
  }
}

function parseRepos(input: string): string[] {
  return input
    .split(',')
    .map((v) => v.trim())
    .filter((v) => /^[^\s/]+\/[^\s/]+$/.test(v))
}

function validateUrl(value: string, requiredMessage: string): string | undefined {
  if (!value || value.length === 0) return requiredMessage
  try {
    new URL(value)
    return undefined
  } catch {
    return 'Must be a valid URL'
  }
}

function validatePositiveInteger(value: string, requiredMessage: string): string | undefined {
  if (!value || value.length === 0) return requiredMessage
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? undefined : 'Must be a positive integer'
}

async function promptDiscordToken(): Promise<string> {
  note(
    [
      'https://discord.com/developers/applications',
      'New Application → Bot tab → Reset Token.',
      'Under Privileged Gateway Intents, enable MESSAGE CONTENT and GUILD MEMBERS.',
    ].join('\n'),
    'Get a Discord bot token',
  )
  const token = await password({
    message: 'Discord bot token',
    validate: (value) => (value && value.length > 0 ? undefined : 'Token is required'),
  })
  if (isCancel(token)) {
    cancel('Aborted.')
    process.exit(0)
  }
  printDiscordInviteHint(token)
  return token
}

async function promptSlackTokens(): Promise<{ bot: string; app: string }> {
  printSlackAppManifestSetup()
  const bot = await promptSlackBotToken()
  note(
    [
      'Slack does not accept connections:write inside the manifest, so',
      'this token has to be generated by hand:',
      '',
      '1. Basic Information → App-Level Tokens → Generate Token and Scopes.',
      '2. Token Name: anything (e.g. "socket-mode").',
      '3. Add Scope → connections:write → Generate.',
      '4. Copy the xapp-... token shown once on screen.',
      '   (You cannot retrieve it later — only revoke and regenerate.)',
    ].join('\n'),
    'Generate the Slack app-level token',
  )
  const app = await promptSlackAppToken()
  return { bot, app }
}

async function promptSlackQrDataUrl(): Promise<string> {
  note(
    [
      'Slack user mode signs in as your own account — messages are sent and',
      'received as this Slack user, not a bot.',
      '',
      'Copy the QR image data URL from the Slack desktop app:',
      '',
      '1. Click your name (top-left) → "Sign in on mobile".',
      '2. Right-click the QR code → "Copy Image Address".',
      '3. Paste it below (a long data:image/png;base64,... string).',
      '',
      'Generate a fresh QR each time — the sign-in link expires quickly.',
    ].join('\n'),
    'Sign in to Slack (user account)',
  )
  const qrDataUrl = await text({
    message: 'Slack QR data URL (data:image/png;base64,...)',
    validate: (value) =>
      value && value.startsWith('data:image/') ? undefined : 'QR data URL must start with "data:image/"',
  })
  if (isCancel(qrDataUrl)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return qrDataUrl
}

async function promptSlackBotToken(): Promise<string> {
  const botToken = await password({
    message: 'Slack bot token (xoxb-...)',
    validate: (value) =>
      value && value.length > 0
        ? value.startsWith('xoxb-')
          ? undefined
          : 'Bot token must start with "xoxb-"'
        : 'Token is required',
  })
  if (isCancel(botToken)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return botToken
}

async function promptSlackAppToken(): Promise<string> {
  const appToken = await password({
    message: 'Slack app-level token (xapp-...) — Socket Mode requires this',
    validate: (value) =>
      value && value.length > 0
        ? value.startsWith('xapp-')
          ? undefined
          : 'App-level token must start with "xapp-"'
        : 'Token is required',
  })
  if (isCancel(appToken)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return appToken
}

async function promptTelegramToken(): Promise<string> {
  note(
    [
      'Open Telegram and message @BotFather or visit https://t.me/BotFather.',
      '/newbot → pick a name and username, copy the HTTP API token',
      '  (looks like 1234567890:ABCdef...).',
      'In @BotFather: /setprivacy → Disable, so the bot can see group messages.',
    ].join('\n'),
    'Get a Telegram bot token',
  )
  const token = await password({
    message: 'Telegram bot token',
    validate: (value) =>
      value && value.length > 0
        ? /^\d+:/.test(value)
          ? undefined
          : 'Bot token must look like "<digits>:<secret>" (from @BotFather)'
        : 'Token is required',
  })
  if (isCancel(token)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return token
}

async function promptWebexToken(): Promise<string> {
  note(
    [
      'Create a bot at https://developer.webex.com/my-apps/new/bot.',
      'Copy the Bot Access Token from the bot settings page.',
    ].join('\n'),
    'Get a Webex bot token',
  )
  const token = await password({
    message: 'Webex bot access token',
    validate: (value) => (value && value.length > 0 ? undefined : 'Token is required'),
  })
  if (isCancel(token)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return token
}

async function promptTeamsAccountType(): Promise<TeamsAccountType> {
  note(
    [
      'Teams signs in as your own Microsoft account via device-code login —',
      'no bot registration. You get a short code to enter at',
      'microsoft.com/devicelogin, then approve the sign-in.',
    ].join('\n'),
    'About to log in to Teams',
  )
  const accountType = await select<TeamsAccountType>({
    message: 'Which kind of Microsoft account?',
    options: [
      { value: 'work', label: 'Work or school (Microsoft 365 / Azure AD)' },
      { value: 'personal', label: 'Personal Microsoft account (outlook.com, live.com, …)' },
    ],
    initialValue: 'work',
  })
  if (isCancel(accountType)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return accountType
}

export function teamsDeviceCodeCallbacks(): TeamsDeviceCodeCallbacks {
  return {
    onCode: (prompt) => {
      note(
        [
          `Open ${prompt.verificationUri}`,
          `Enter code: ${prompt.userCode}`,
          '',
          'Then approve the sign-in in your browser. Waiting for approval…',
        ].join('\n'),
        'Teams device-code login',
      )
    },
    onPending: () => log.info('Approved — minting the Teams token…'),
  }
}

async function promptKakaotalkCredentials(
  opts: { defaultEmail?: string } = {},
): Promise<{ email: string; password: string }> {
  note(
    [
      'KakaoTalk authentication uses a personal account, registered as a',
      'tablet sub-device. Messages will be sent and received under this',
      'account. Use a non-primary account if possible.',
      '',
      'On reauth, the existing device_uuid is preserved automatically, so',
      'subsequent logins for the same account typically skip the phone',
      'passcode confirmation.',
    ].join('\n'),
    'About to log in to KakaoTalk',
  )
  const email = await text({
    message: 'KakaoTalk email',
    ...(opts.defaultEmail !== undefined ? { initialValue: opts.defaultEmail, placeholder: opts.defaultEmail } : {}),
    validate: (value) => (value && value.length > 0 ? undefined : 'Email is required'),
  })
  if (isCancel(email)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const pwd = await password({
    message: 'KakaoTalk password',
    validate: (value) => (value && value.length > 0 ? undefined : 'Password is required'),
  })
  if (isCancel(pwd)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return { email, password: pwd }
}

async function promptWebexCredentials(
  opts: { defaultEmail?: string } = {},
): Promise<{ email: string; password: string }> {
  note(
    [
      'Logs in headlessly with your Webex email/password.',
      'SSO/MFA accounts are not supported. Messages will be sent and received under this account.',
    ].join('\n'),
    'About to log in to Webex',
  )
  const email = await text({
    message: 'Webex email',
    ...(opts.defaultEmail !== undefined ? { initialValue: opts.defaultEmail, placeholder: opts.defaultEmail } : {}),
    validate: (value) => (value && value.length > 0 ? undefined : 'Email is required'),
  })
  if (isCancel(email)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const pwd = await password({
    message: 'Webex password',
    validate: (value) => (value && value.length > 0 ? undefined : 'Password is required'),
  })
  if (isCancel(pwd)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return { email, password: pwd }
}

async function promptInstagramCredentials(): Promise<{ username: string; password: string }> {
  note(
    [
      'Instagram authentication uses a personal account.',
      'Messages will be sent and received under this account.',
      'If the account has 2FA or triggers a checkpoint, you will be prompted for the verification code here.',
    ].join('\n'),
    'About to log in to Instagram',
  )
  const username = await text({
    message: 'Instagram username',
    validate: (value) => (value && value.length > 0 ? undefined : 'Username is required'),
  })
  if (isCancel(username)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const pwd = await password({
    message: 'Instagram password',
    validate: (value) => (value && value.length > 0 ? undefined : 'Password is required'),
  })
  if (isCancel(pwd)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return { username, password: pwd }
}

// The login spinner ('Logging in to Instagram...') keeps animating while
// Instagram's 2FA/checkpoint step waits on a human, and would repaint over the
// code prompt. Pause it around the prompt so the input line stays legible, then
// resume with a "waiting" message — same control the LINE PIN flow uses.
function instagramLoginCallbacks(spinnerControl?: LineAuthSpinnerControl): InstagramLoginCallbacks {
  const promptCode = async (message: string): Promise<string | null> => {
    spinnerControl?.pause()
    const code = await text({
      message,
      validate: (value) => (value && value.trim().length > 0 ? undefined : 'A verification code is required'),
    })
    if (isCancel(code)) return null
    spinnerControl?.resume('Verifying the Instagram code...')
    return code
  }

  return {
    onTwoFactorCode: () => promptCode('Enter the Instagram 2FA code from your authenticator app or SMS'),
    onChallengeCode: async ({ contactPoint }) => {
      const where = contactPoint === '' ? 'your email or phone' : contactPoint
      const code = await promptCode(`Enter the Instagram verification code sent to ${where}`)
      return code === null ? null : { code }
    },
  }
}

type LinePromptResult =
  | { method: 'qr'; callbacks: { onQRUrl: (url: string) => Promise<void>; onPincode: (pin: string) => void } }
  | {
      method: 'email'
      email: string
      password: string
      callbacks: { onPincode: (pin: string) => void }
    }

// LINE's interactive logins block while the SDK waits on the phone: QR
// long-polls for a scan, email/password waits for the user to enter a PIN. The
// add-flow spinner ('Logging in to LINE...') keeps animating during that wait
// and would otherwise repaint over the multi-line QR or the PIN, garbling both.
// This control lets the QR/PIN callbacks pause the live spinner, print legibly,
// then resume it with a "waiting for you" message so output stays readable.
export type LineAuthSpinnerControl = {
  pause: () => void
  resume: (message: string) => void
}

async function promptLineLogin(spinnerControl?: LineAuthSpinnerControl): Promise<LinePromptResult> {
  note(
    [
      'LINE authentication uses a personal account registered as a sub-device.',
      'Messages will be sent and received under this account — use a',
      'non-primary account if possible.',
      '',
      'QR login is recommended: it works even when the account has no',
      'email/password set (social-login accounts).',
    ].join('\n'),
    'About to log in to LINE',
  )
  const method = await select<'qr' | 'email'>({
    message: 'How do you want to log in to LINE?',
    options: [
      { value: 'qr', label: 'QR code — scan with the LINE app on your phone (recommended)' },
      { value: 'email', label: 'Email + password — for accounts with email login enabled' },
    ],
    initialValue: 'qr',
  })
  if (isCancel(method)) {
    cancel('Aborted.')
    process.exit(0)
  }

  const onPincode = (pin: string): void => {
    spinnerControl?.pause()
    printLinePincode(pin)
    spinnerControl?.resume('Waiting for you to confirm the PIN in the LINE app...')
  }

  if (method === 'qr') {
    return {
      method: 'qr',
      callbacks: {
        onQRUrl: (url) => presentLineQr(url, spinnerControl),
        onPincode,
      },
    }
  }

  const email = await text({
    message: 'LINE email',
    validate: (value) => (value && value.length > 0 ? undefined : 'Email is required'),
  })
  if (isCancel(email)) {
    cancel('Aborted.')
    process.exit(0)
  }
  const pwd = await password({
    message: 'LINE password',
    validate: (value) => (value && value.length > 0 ? undefined : 'Password is required'),
  })
  if (isCancel(pwd)) {
    cancel('Aborted.')
    process.exit(0)
  }
  return { method: 'email', email, password: pwd, callbacks: { onPincode } }
}

async function presentLineQr(url: string, spinnerControl?: LineAuthSpinnerControl): Promise<void> {
  spinnerControl?.pause()
  const presentation = await displayQR(url, {
    title: 'LINE login',
    scanInstruction: 'Scan with the LINE app on your phone',
  })

  const lines: string[] = []
  if (presentation.terminal !== null) {
    lines.push(presentation.terminal)
    lines.push('Scan the QR code above with the LINE app on your phone.')
    lines.push('If it is too small to scan, enlarge the terminal (or zoom out) and re-run.')
    if (presentation.opened) {
      lines.push('A browser window with a larger QR code was also opened.')
    }
  } else if (presentation.opened) {
    lines.push('A browser window with the QR code was opened. Scan it with the LINE app on your phone.')
  } else if (presentation.htmlPath !== null) {
    lines.push(`Open this file in a browser and scan it with the LINE app: ${presentation.htmlPath}`)
  }
  if (lines.length > 0) note(lines.join('\n'), 'Scan to log in to LINE')

  if (presentation.terminal === null && !presentation.opened && presentation.htmlPath === null) {
    printLineQrUrl(url)
  }

  spinnerControl?.resume('Waiting for you to scan the QR code with the LINE app...')
}

// Last-resort fallback when no QR could be rendered. The raw URL stays OUT of
// note(): clack wraps long lines with a `│` gutter that corrupts the login URL
// (it carries `?secret=...&e2eeVersion=...`). Same constraint as
// src/cli/oauth-callbacks.ts.
export function printLineQrUrl(url: string, output: NodeJS.WritableStream = process.stdout): void {
  note('Open this URL on a device that can render it as a QR code:', 'Log in to LINE')
  output.write(`${url}\n\n`)
}

// PIN stays OUT of the note() gutter (same `│`-splitting reason as
// printLineQrUrl) and must stand out: the SDK blocks on phone confirmation and
// throws if its window lapses, so a PIN scrolled past unnoticed leaves nothing
// in secrets.json — the root cause of the runtime "No account found" error. The
// "waiting" line is emitted by the resumed spinner, not here.
export function printLinePincode(pin: string, output: NodeJS.WritableStream = process.stdout): void {
  note('Open the LINE app on your phone and enter this PIN to authorize this device:', 'Confirm LINE login')
  output.write(`\n  PIN: ${pin}\n\n`)
}

type Spinner = ReturnType<typeof spinner>

// `current` is the live `line-auth` spinner, shared between `reportProgress`
// (which owns its lifecycle) and the QR/PIN callbacks (which must pause it to
// print legibly). It is null whenever no LINE login spinner is active.
export type LineAuthSpinnerHolder = { current: Spinner | null }

export function holderSpinnerControl(holder: LineAuthSpinnerHolder): LineAuthSpinnerControl {
  return {
    pause: () => holder.current?.stop(),
    resume: (message) => holder.current?.start(message),
  }
}

function reportProgress(
  events: AddChannelStepEvent[],
  lineSpinnerHolder?: LineAuthSpinnerHolder,
): (event: AddChannelStepEvent) => void {
  const spinners: Partial<Record<AddChannelStepEvent['step'], Spinner>> = {}

  return (event) => {
    events.push(event)
    if (event.phase === 'start') {
      const s = spinner()
      s.start(START_MESSAGES[event.step])
      spinners[event.step] = s
      if ((event.step === 'line-auth' || event.step === 'instagram-auth') && lineSpinnerHolder) {
        lineSpinnerHolder.current = s
      }
      return
    }

    const s = spinners[event.step]
    if (!s) return

    switch (event.step) {
      case 'line-auth':
        if (lineSpinnerHolder) lineSpinnerHolder.current = null
        s.stop(reportLineAuth(event.result))
        break
      case 'instagram-auth':
        if (lineSpinnerHolder) lineSpinnerHolder.current = null
        s.stop(reportInstagramAuth(event.result))
        break
      case 'kakaotalk-auth':
        s.stop(reportKakaotalkAuth(event.result))
        break
      case 'webex-auth':
        s.stop(reportWebexAuth(event.result))
        break
      case 'teams-auth':
        s.stop(reportTeamsAuth(event.result))
        break
      case 'discord-auth':
        s.stop(reportDiscordAuth(event.result))
        break
      case 'slack-auth':
        s.stop(reportSlackAuth(event.result))
        break
      case 'config':
        s.stop('Updated typeclaw.json.')
        break
      case 'secrets':
        s.stop('Saved credentials to secrets.json.')
        break
      case 'github-webhooks':
        s.stop(formatEagerGithubWebhookInstallResult(event.result))
        break
    }
  }
}

const START_MESSAGES: Record<AddChannelStepEvent['step'], string> = {
  'line-auth': 'Logging in to LINE...',
  'instagram-auth': 'Logging in to Instagram...',
  'kakaotalk-auth': 'Logging in to KakaoTalk...',
  'webex-auth': 'Logging in to Webex...',
  'teams-auth': 'Logging in to Teams...',
  'discord-auth': 'Logging in to Discord...',
  'slack-auth': 'Logging in to Slack...',
  config: 'Updating typeclaw.json...',
  secrets: 'Saving credentials to secrets.json...',
  'github-webhooks': 'Installing GitHub repository webhooks...',
}

function reportKakaotalkAuth(result: KakaotalkAuthResult): string {
  if (result.ok) return 'KakaoTalk credentials saved to secrets.json.'
  return `KakaoTalk login failed: ${result.reason}`
}

function reportSlackAuth(result: SlackAuthResult): string {
  if (result.ok) return 'Slack credentials saved to secrets.json.'
  return `Slack login failed: ${result.reason}`
}

function reportDiscordAuth(result: DiscordAuthResult): string {
  if (result.ok) return 'Discord credentials saved to secrets.json.'
  return `Discord login failed: ${result.reason}`
}

function reportWebexAuth(result: WebexAuthResult): string {
  if (result.ok) return 'Webex credentials saved to secrets.json.'
  return `Webex login failed: ${result.reason}`
}

function reportTeamsAuth(result: TeamsAuthResult): string {
  if (result.ok) return 'Teams credentials saved to secrets.json.'
  return `Teams login failed: ${result.reason}`
}

function reportLineAuth(result: LineAuthResult): string {
  if (result.ok) return 'LINE credentials saved to secrets.json.'
  return `LINE login failed: ${result.reason}`
}

function reportInstagramAuth(result: InstagramAuthResult): string {
  if (result.ok) return 'Instagram credentials saved to secrets.json.'
  return `Instagram login failed: ${result.reason}`
}

async function maybePromptRestart(
  cwd: string,
  channel: ChannelKind,
  verb: 'added' | 'removed' = 'added',
): Promise<void> {
  const label = CHANNEL_LABELS[channel]
  const controller = resolveController()
  const current = await controller.status({ cwd }).catch(() => null)
  if (current === null || current.kind !== 'running') {
    done({
      title: c.green(`${label} channel ${verb}.`),
      hints: [
        { label: 'Start the agent:', command: 'typeclaw start' },
        { label: 'Then check status:', command: 'typeclaw status' },
      ],
    })
    return
  }

  const restartNow = await confirm({
    message: `Channel config is restart-required and the agent container is running. Restart it now to apply the ${verb} channel?`,
    initialValue: true,
  })
  if (isCancel(restartNow) || !restartNow) {
    done({
      title: c.green(`${label} channel ${verb}.`),
      hints: [
        { label: 'Apply later:', command: 'typeclaw restart' },
        { label: 'Check status:', command: 'typeclaw status' },
      ],
    })
    return
  }

  const restarted = await controller.restart({ cwd, preferredHostPort: config.port, cliEntry: process.argv[1] })
  if (!restarted.ok) {
    console.error(errorLine(formatRestartFailure(restarted.reason)))
    process.exit(1)
  }
  const started = restarted.start
  done({
    title: c.green(
      `${label} channel ${verb}. Restarted ${started.plan.containerName} on host port ${started.hostPort}.`,
    ),
    hints: [
      { label: 'Attach TUI:', command: 'typeclaw tui' },
      { label: 'Follow logs:', command: 'typeclaw logs -f' },
    ],
  })
}

function formatRestartFailure(reason: string): string {
  if (reason.startsWith('stop failed: ')) return `Restart failed during stop: ${reason.slice('stop failed: '.length)}`
  if (reason.startsWith('start failed: '))
    return `Restart failed during start: ${reason.slice('start failed: '.length)}`
  return `Restart failed: ${reason}`
}
