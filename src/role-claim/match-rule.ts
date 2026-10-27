// Builds a canonical match-rule DSL string from an inbound channel origin,
// for the role table. Output shape is always platform-wide + author:
//
//   slack:* author:<authorId>
//   discord:* author:<authorId>
//   telegram:* author:<authorId>
//   kakao:* author:<authorId>
//
// "Platform-wide" means every chat the adapter sees on that platform —
// DMs, group chats, and threads alike — gated by the author qualifier so
// only this specific human is matched. The intent is: once an operator
// proves they control a channel identity (by sending a code to the bot),
// they keep their role wherever they speak from on the same platform. To
// scope tighter (e.g. one workspace, one chat), the operator edits
// typeclaw.json by hand; the claim flow is deliberately broad because
// re-claiming on every new chat would be tedious for the common case.

import type { ChannelKey } from '@/channels/types'

export type PartialChannelOrigin = {
  adapter: ChannelKey['adapter']
  workspace: string
  chat: string
  isDm: boolean
  authorId: string
}

const ADAPTER_TO_PLATFORM: Record<
  ChannelKey['adapter'],
  'slack' | 'discord' | 'telegram' | 'webex' | 'teams' | 'kakao' | 'line' | 'github' | 'sentry' | 'instagram'
> = {
  slack: 'slack',
  'slack-bot': 'slack',
  discord: 'discord',
  'discord-bot': 'discord',
  github: 'github',
  sentry: 'sentry',
  instagram: 'instagram',
  'telegram-bot': 'telegram',
  webex: 'webex',
  'webex-bot': 'webex',
  teams: 'teams',
  line: 'line',
  kakaotalk: 'kakao',
}

export function formatClaimMatchRule(origin: PartialChannelOrigin): string {
  const platform = ADAPTER_TO_PLATFORM[origin.adapter]
  // Webex authorIds are stored as decoded refs (UUID, or email for legacy
  // accounts). The matcher still normalizes older blob-form rules/inbounds.
  const author = origin.authorId
  return `${platform}:* author:${author}`
}
