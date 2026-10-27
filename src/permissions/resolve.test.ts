import { describe, expect, test } from 'bun:test'

import type { MatchRule } from './match-rule'
import { type MatchableOrigin, matchesOrigin } from './resolve'

test('Sentry 프로젝트 권한은 해당 조직과 프로젝트의 이슈에만 적용된다', () => {
  const rule: MatchRule = { kind: 'channel', platform: 'sentry', workspace: 'acme/backend' }
  const origin: MatchableOrigin = { kind: 'channel', adapter: 'sentry', workspace: 'acme/backend', chat: 'issue:42' }
  expect(matchesOrigin(rule, origin)).toBe(true)
  expect(matchesOrigin(rule, { ...origin, workspace: 'other/backend' })).toBe(false)
  expect(matchesOrigin(rule, { ...origin, workspace: 'acme/frontend' })).toBe(false)
  expect(matchesOrigin(rule, { ...origin, adapter: 'github' })).toBe(false)
  expect(matchesOrigin({ ...rule, chat: 'issue:43' }, origin)).toBe(false)
})

const tui: MatchableOrigin = { kind: 'tui', sessionId: 's' }
const cron: MatchableOrigin = { kind: 'cron', jobId: 'j' }
const subagent: MatchableOrigin = { kind: 'subagent', subagent: 'memory-logger' }
const slackChat: MatchableOrigin = {
  kind: 'channel',
  adapter: 'slack-bot',
  workspace: 'T0123',
  chat: 'C0ABCDE',
  lastInboundAuthorId: 'U_ME',
}
const slackDm: MatchableOrigin = {
  kind: 'channel',
  adapter: 'slack-bot',
  workspace: '@dm',
  chat: 'D777',
  lastInboundAuthorId: 'U_OTHER',
}
const discordChat: MatchableOrigin = {
  kind: 'channel',
  adapter: 'discord-bot',
  workspace: '9999',
  chat: '123456',
}
const discordThread: MatchableOrigin = {
  ...discordChat,
  chat: 'thread-123',
  parentChat: '123456',
}
const lineSquare: MatchableOrigin = {
  kind: 'channel',
  adapter: 'line',
  workspace: '@line-square',
  chat: 'S_X',
}
const kakaoGroup: MatchableOrigin = {
  kind: 'channel',
  adapter: 'kakaotalk',
  workspace: '@kakao-group',
  chat: 'G_X',
}
const webexDm: MatchableOrigin = {
  kind: 'channel',
  adapter: 'webex-bot',
  workspace: '@dm',
  chat: 'ROOM_X',
  lastInboundAuthorId: 'person-uuid',
}
const webexRoom: MatchableOrigin = {
  kind: 'channel',
  adapter: 'webex-bot',
  workspace: 'ROOM_X',
  chat: 'ROOM_X',
  lastInboundAuthorId: 'person-uuid',
}

const TUI: MatchRule = { kind: 'tui' }
const CRON: MatchRule = { kind: 'cron' }
const WILDCARD: MatchRule = { kind: 'wildcard' }
const SUBAGENT_ANY: MatchRule = { kind: 'subagent' }
const SUBAGENT_NAMED: MatchRule = { kind: 'subagent', subagent: 'memory-logger' }
const SLACK_ANY: MatchRule = { kind: 'channel', platform: 'slack' }
const SLACK_WS: MatchRule = { kind: 'channel', platform: 'slack', workspace: 'T0123' }
const SLACK_CHAT: MatchRule = { kind: 'channel', platform: 'slack', workspace: 'T0123', chat: 'C0ABCDE' }
const SLACK_WS_AUTHOR: MatchRule = { kind: 'channel', platform: 'slack', workspace: 'T0123', author: 'U_ME' }
const SLACK_DM_BUCKET: MatchRule = { kind: 'channel', platform: 'slack', bucket: 'dm' }
const DISCORD_GUILD: MatchRule = { kind: 'channel', platform: 'discord', workspace: '9999' }
const DISCORD_PARENT: MatchRule = {
  kind: 'channel',
  platform: 'discord',
  workspace: '9999',
  chat: '123456',
}
const DISCORD_THREAD: MatchRule = {
  kind: 'channel',
  platform: 'discord',
  workspace: '9999',
  chat: 'thread-123',
}
const LINE_SQUARE_BUCKET: MatchRule = { kind: 'channel', platform: 'line', bucket: 'square' }
const KAKAO_GROUP_BUCKET: MatchRule = { kind: 'channel', platform: 'kakao', bucket: 'group' }
const WEBEX_DM_BUCKET: MatchRule = { kind: 'channel', platform: 'webex', bucket: 'dm' }
const WEBEX_AUTHOR: MatchRule = { kind: 'channel', platform: 'webex', author: 'person-uuid' }

describe('matchesOrigin — keyword scopes', () => {
  test('tui rule matches tui origin only', () => {
    expect(matchesOrigin(TUI, tui)).toBe(true)
    expect(matchesOrigin(TUI, cron)).toBe(false)
    expect(matchesOrigin(TUI, slackChat)).toBe(false)
  })

  test('cron rule matches cron origin only', () => {
    expect(matchesOrigin(CRON, cron)).toBe(true)
    expect(matchesOrigin(CRON, tui)).toBe(false)
  })

  test('wildcard matches any channel, never tui/cron/subagent', () => {
    expect(matchesOrigin(WILDCARD, slackChat)).toBe(true)
    expect(matchesOrigin(WILDCARD, discordChat)).toBe(true)
    expect(matchesOrigin(WILDCARD, tui)).toBe(false)
    expect(matchesOrigin(WILDCARD, cron)).toBe(false)
    expect(matchesOrigin(WILDCARD, subagent)).toBe(false)
  })

  test('subagent rule with no name matches any subagent', () => {
    expect(matchesOrigin(SUBAGENT_ANY, subagent)).toBe(true)
    expect(matchesOrigin(SUBAGENT_ANY, tui)).toBe(false)
  })

  test('subagent rule with name matches only that name', () => {
    expect(matchesOrigin(SUBAGENT_NAMED, subagent)).toBe(true)
    expect(matchesOrigin(SUBAGENT_NAMED, { kind: 'subagent', subagent: 'other' })).toBe(false)
  })
})

describe('matchesOrigin — channel coordinates', () => {
  test('platform-only matches any chat in that platform', () => {
    expect(matchesOrigin(SLACK_ANY, slackChat)).toBe(true)
    expect(matchesOrigin(SLACK_ANY, slackDm)).toBe(true)
    expect(matchesOrigin(SLACK_ANY, discordChat)).toBe(false)
  })

  test('workspace narrows to one workspace', () => {
    expect(matchesOrigin(SLACK_WS, slackChat)).toBe(true)
    expect(matchesOrigin(SLACK_WS, { ...slackChat, workspace: 'T_OTHER' })).toBe(false)
  })

  test('chat narrows to one chat in one workspace', () => {
    expect(matchesOrigin(SLACK_CHAT, slackChat)).toBe(true)
    expect(matchesOrigin(SLACK_CHAT, { ...slackChat, chat: 'C_OTHER' })).toBe(false)
  })

  test('author qualifier matches lastInboundAuthorId', () => {
    expect(matchesOrigin(SLACK_WS_AUTHOR, slackChat)).toBe(true)
    expect(matchesOrigin(SLACK_WS_AUTHOR, { ...slackChat, lastInboundAuthorId: 'U_OTHER' })).toBe(false)
    expect(matchesOrigin(SLACK_WS_AUTHOR, { ...slackChat, lastInboundAuthorId: undefined })).toBe(false)
  })

  test('slack:dm bucket matches the @dm workspace marker', () => {
    expect(matchesOrigin(SLACK_DM_BUCKET, slackDm)).toBe(true)
    expect(matchesOrigin(SLACK_DM_BUCKET, slackChat)).toBe(false)
  })

  test('discord workspace match', () => {
    expect(matchesOrigin(DISCORD_GUILD, discordChat)).toBe(true)
    expect(matchesOrigin(DISCORD_GUILD, discordThread)).toBe(true)
    expect(matchesOrigin(DISCORD_GUILD, { ...discordChat, workspace: '8888' })).toBe(false)
  })

  test('discord parent channel matches its resolved child thread', () => {
    expect(matchesOrigin(DISCORD_PARENT, discordThread)).toBe(true)
    expect(matchesOrigin(DISCORD_PARENT, { ...discordThread, parentChat: 'other-parent' })).toBe(false)
    expect(matchesOrigin(DISCORD_PARENT, { ...discordThread, parentChat: undefined })).toBe(false)
  })

  test('discord explicit thread remains strict and does not match its parent or siblings', () => {
    expect(matchesOrigin(DISCORD_THREAD, discordThread)).toBe(true)
    expect(matchesOrigin(DISCORD_THREAD, discordChat)).toBe(false)
    expect(matchesOrigin(DISCORD_THREAD, { ...discordThread, chat: 'sibling-thread' })).toBe(false)
  })

  test('discord parent channel does not match a DM carrying the same chat id', () => {
    expect(
      matchesOrigin(DISCORD_PARENT, {
        ...discordThread,
        workspace: '@dm',
        chat: '123456',
        parentChat: undefined,
      }),
    ).toBe(false)
  })

  test('line square bucket matches the @line-square workspace prefix', () => {
    expect(matchesOrigin(LINE_SQUARE_BUCKET, lineSquare)).toBe(true)
    expect(matchesOrigin(LINE_SQUARE_BUCKET, { ...lineSquare, workspace: '@line-group' })).toBe(false)
  })

  test('kakao group bucket matches the @kakao-group workspace prefix', () => {
    expect(matchesOrigin(KAKAO_GROUP_BUCKET, kakaoGroup)).toBe(true)
    expect(matchesOrigin(KAKAO_GROUP_BUCKET, { ...kakaoGroup, workspace: '@kakao-dm' })).toBe(false)
  })

  test('webex:dm bucket matches the @dm workspace marker, not a group room', () => {
    expect(matchesOrigin(WEBEX_DM_BUCKET, webexDm)).toBe(true)
    expect(matchesOrigin(WEBEX_DM_BUCKET, webexRoom)).toBe(false)
  })

  test('webex author qualifier matches the personId (lastInboundAuthorId)', () => {
    expect(matchesOrigin(WEBEX_AUTHOR, webexDm)).toBe(true)
    expect(matchesOrigin(WEBEX_AUTHOR, { ...webexDm, lastInboundAuthorId: 'other-uuid' })).toBe(false)
  })

  // base64 of ciscospark://us/PEOPLE/12345678-1234-1234-1234-1234567890ab
  const PERSON_BASE64 = 'Y2lzY29zcGFyazovL3VzL1BFT1BMRS8xMjM0NTY3OC0xMjM0LTEyMzQtMTIzNC0xMjM0NTY3ODkwYWI='
  const PERSON_UUID = '12345678-1234-1234-1234-1234567890ab'
  // base64 of ciscospark://us/PEOPLE/alice@example.com (legacy Hydra account)
  const LEGACY_BASE64 = 'Y2lzY29zcGFyazovL3VzL1BFT1BMRS9hbGljZUBleGFtcGxlLmNvbQ=='
  // base64 of ciscospark://us/ROOM/12345678-1234-1234-1234-1234567890ab (same uuid as PERSON)
  const ROOM_SAME_UUID = 'Y2lzY29zcGFyazovL3VzL1JPT00vMTIzNDU2NzgtMTIzNC0xMjM0LTEyMzQtMTIzNDU2Nzg5MGFi'

  const webexBase64Origin: MatchableOrigin = { ...webexDm, lastInboundAuthorId: PERSON_BASE64 }

  test('webex author: a uuid-ref rule matches an inbound carrying the raw base64 personId', () => {
    const rule: MatchRule = { kind: 'channel', platform: 'webex', author: PERSON_UUID }
    expect(matchesOrigin(rule, webexBase64Origin)).toBe(true)
  })

  test('webex author: a raw base64 rule still matches a raw base64 inbound (back-compat)', () => {
    const rule: MatchRule = { kind: 'channel', platform: 'webex', author: PERSON_BASE64 }
    expect(matchesOrigin(rule, webexBase64Origin)).toBe(true)
  })

  test('webex author: a raw base64 rule matches a uuid-ref inbound (both normalize)', () => {
    const rule: MatchRule = { kind: 'channel', platform: 'webex', author: PERSON_BASE64 }
    expect(matchesOrigin(rule, { ...webexDm, lastInboundAuthorId: PERSON_UUID })).toBe(true)
  })

  test('webex author: a legacy email-ref rule matches the legacy base64 inbound, case-insensitively', () => {
    const rule: MatchRule = { kind: 'channel', platform: 'webex', author: 'Alice@Example.com' }
    expect(matchesOrigin(rule, { ...webexDm, lastInboundAuthorId: LEGACY_BASE64 })).toBe(true)
  })

  test('webex author: a room id sharing the person uuid never satisfies an author rule (fail-closed)', () => {
    const rule: MatchRule = { kind: 'channel', platform: 'webex', author: PERSON_UUID }
    expect(matchesOrigin(rule, { ...webexDm, lastInboundAuthorId: ROOM_SAME_UUID })).toBe(false)
  })

  test('webex author: two DIFFERENT non-person ids must not collide via null normalization', () => {
    // both decode to non-PEOPLE ids → webexPersonRef returns null for each;
    // the matcher must not treat null === null as a match.
    // ROOM_OTHER = base64 of ciscospark://us/ROOM/99999999-9999-9999-9999-999999999999
    const ROOM_OTHER = 'Y2lzY29zcGFyazovL3VzL1JPT00vOTk5OTk5OTktOTk5OS05OTk5LTk5OTktOTk5OTk5OTk5OTk5'
    const rule: MatchRule = { kind: 'channel', platform: 'webex', author: ROOM_SAME_UUID }
    expect(matchesOrigin(rule, { ...webexDm, lastInboundAuthorId: ROOM_OTHER })).toBe(false)
  })

  test('non-webex author matching is unchanged: slack does not decode or normalize', () => {
    const rule: MatchRule = { kind: 'channel', platform: 'slack', workspace: 'T0123', author: PERSON_UUID }
    expect(matchesOrigin(rule, { ...slackChat, lastInboundAuthorId: PERSON_BASE64 })).toBe(false)
  })

  test('platform mismatch on channel rule against channel origin', () => {
    expect(matchesOrigin(SLACK_ANY, discordChat)).toBe(false)
  })
})
