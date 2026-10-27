import { confirm, isCancel, log, note, spinner } from '@clack/prompts'

import { c } from '@/cli/ui'
import { runClaimSession } from '@/role-claim'

import type { ChannelKind } from './index'

const CHANNEL_LABELS: Record<ChannelKind, string> = {
  slack: 'Slack (User)',
  'slack-bot': 'Slack',
  discord: 'Discord (User)',
  'discord-bot': 'Discord',
  github: 'GitHub',
  sentry: 'Sentry',
  'telegram-bot': 'Telegram',
  webex: 'Webex (User)',
  'webex-bot': 'Webex',
  teams: 'Teams',
  instagram: 'Instagram',
  line: 'LINE',
  kakaotalk: 'KakaoTalk',
}

const DEFAULT_TTL_MS = 10 * 60 * 1000

export type RunOwnerClaimOptions = {
  url: string
  configuredChannels: readonly ChannelKind[]
}

// Drives the post-hatching claim flow: ask the operator whether to pair now,
// run the claim handshake against the running container, print the result.
// Aborts (kind: 'cancel' or a clack cancel) drop straight back into the
// normal hatching path so the TUI still opens — the operator can run
// `typeclaw role claim` later.
export async function runOwnerClaim({ url, configuredChannels }: RunOwnerClaimOptions): Promise<void> {
  // GitHub has no DM affordance, and the github adapter doesn't yet route
  // claim codes (the `typeclaw role claim` CLI explicitly lists only the
  // four chat adapters as --channel values). Owner authorization for github
  // is handled by the `roles.member.match[]` repo allowlist that
  // runAddChannel writes during init. Filtering here keeps the auto-claim
  // working for chat channels mixed with github, and skips the flow
  // entirely when github is the only wired channel.
  const claimable = configuredChannels.filter((c) => c !== 'github' && c !== 'sentry')
  if (claimable.length === 0) return

  const channelList = claimable.map((c) => CHANNEL_LABELS[c] ?? c).join(', ')

  const proceed = await confirm({
    message: `Claim owner role on ${channelList} now?`,
    initialValue: true,
  })
  if (isCancel(proceed) || proceed === false) {
    warnMuteUntilClaimed()
    return
  }

  const s = spinner()
  s.start('Generating your claim code...')

  const result = await runClaimSession({
    url,
    role: 'owner',
    ttlMs: DEFAULT_TTL_MS,
    onStarted: (payload) => {
      const expiresInMin = Math.max(1, Math.round((payload.expiresAt - Date.now()) / 60_000))
      s.stop('Code ready.')
      note(
        [
          `Open ${channelList} and DM your bot with this code:`,
          '',
          `  ${c.bold(payload.code)}`,
          '',
          `(expires in ~${expiresInMin}m)`,
        ].join('\n'),
        'Claim your owner role',
      )
      s.start('Waiting for your DM...')
    },
  })

  if (result.kind === 'completed') {
    s.stop(c.green(`Paired as owner.`))
    log.info(`Match rule added to typeclaw.json#roles.owner.match: ${c.bold(result.payload.matchRule)}`)
    return
  }
  if (result.kind === 'error') {
    s.stop(c.red(`Claim failed: ${result.payload.reason}`))
    warnMuteUntilClaimed()
    return
  }
  s.stop(c.yellow(`Claim timed out — no DM received within the window.`))
  warnMuteUntilClaimed()
}

// Printed on every path that finishes init WITHOUT a successful owner claim.
// Since the scoped-by-default change removed the `member: ["*"]` seeding, an
// unclaimed chat agent resolves every inbound to `guest` and drops it — the
// agent answers no one. This is a footgun unless the operator is told plainly,
// so the warning is loud and names the exact recovery command.
function warnMuteUntilClaimed(): void {
  note(
    [
      `Your agent will respond to ${c.bold('no one')} until you claim the owner role —`,
      `every inbound message is currently dropped.`,
      '',
      `Run ${c.bold('typeclaw role claim')} to pair yourself, then grant others`,
      `with the agent (ask it: "respond to <user>") or by editing typeclaw.json#roles.`,
    ].join('\n'),
    c.yellow('Heads up: agent is muted'),
  )
}
