import type { MinimalSessionOrigin } from '@/agent/session-meta'
import { toRef } from '@/channels/adapters/webex-id-ref'

const ADAPTER_DISPLAY: Record<string, string> = {
  'slack-bot': 'Slack',
  slack: 'Slack',
  'discord-bot': 'Discord',
  discord: 'Discord',
  github: 'GitHub',
  sentry: 'Sentry',
  'telegram-bot': 'Telegram',
  webex: 'Webex',
  'webex-bot': 'Webex',
  teams: 'Teams',
  instagram: 'Instagram',
  line: 'LINE',
  kakaotalk: 'KakaoTalk',
}

const SLACK_CHAT_PREFIX_ADAPTERS = new Set(['slack-bot', 'discord-bot'])
const WEBEX_ADAPTERS = new Set(['webex', 'webex-bot'])

export function originLabel(origin: MinimalSessionOrigin): string {
  switch (origin.kind) {
    case 'tui':
      return 'TUI'
    case 'cron':
      return `Cron ${origin.jobId} (${origin.jobKind})`
    case 'subagent':
      return `Subagent ${origin.subagent}`
    case 'channel':
      return channelLabel(origin)
    case 'system':
      return `System ${origin.component}`
  }
}

function channelLabel(origin: Extract<MinimalSessionOrigin, { kind: 'channel' }>): string {
  const platform = ADAPTER_DISPLAY[origin.adapter] ?? origin.adapter
  const chatPart = renderChat(origin)
  const wsPart = renderWorkspace(origin)
  if (wsPart === '') return `${platform} ${chatPart}`
  return `${platform} ${wsPart}/${chatPart}`
}

function renderChat(origin: Extract<MinimalSessionOrigin, { kind: 'channel' }>): string {
  if (origin.chatName !== undefined && origin.chatName !== '') {
    const prefix = SLACK_CHAT_PREFIX_ADAPTERS.has(origin.adapter) ? '#' : ''
    return `${prefix}${origin.chatName}`
  }
  return readableId(origin.adapter, origin.chat)
}

function renderWorkspace(origin: Extract<MinimalSessionOrigin, { kind: 'channel' }>): string {
  if (origin.workspaceName !== undefined && origin.workspaceName !== '') return origin.workspaceName
  return readableId(origin.adapter, origin.workspace)
}

// Webex room/workspace/person ids are base64 `ciscospark://` blobs that read as
// gibberish. With no resolved title, decode to the trailing ref (a UUID) so the
// row is at least skimmable; non-Webex ids pass through.
export function readableId(adapter: string, id: string): string {
  return WEBEX_ADAPTERS.has(adapter) ? toRef(id) : id
}

export function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 12) return sessionId
  return sessionId.slice(0, 12)
}
