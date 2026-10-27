// Compact string DSL for permissions match rules. Examples:
//
//   tui                                # any TUI session
//   cron                               # any cron session (resolved by provenance, not match)
//   subagent                           # any subagent session
//   subagent:memory-logger             # specific subagent
//   *                                  # any channel session, any platform
//   slack:*                            # any Slack chat, any workspace
//   slack:T0123                        # one Slack workspace, any chat
//   slack:T0123/C0ABCDE                # one specific Slack chat
//   slack:dm/*                         # any Slack DM
//   slack:T0123 author:U_ME            # specific author across workspace
//
// Within one rule: all tokens AND'd. Across multiple rules: OR'd. The parser
// is hand-rolled (not regex) because the rejection table demands precise
// error messages with typo suggestions; a single big regex would only ever
// say "didn't match".

export const PLATFORMS = [
  'slack',
  'discord',
  'telegram',
  'webex',
  'teams',
  'instagram',
  'line',
  'kakao',
  'github',
  'sentry',
] as const
export type Platform = (typeof PLATFORMS)[number]

const SUBAGENT_NAME = /^[a-z][a-z0-9-]*$/

export type MatchRule =
  | { kind: 'tui' }
  | { kind: 'cron' }
  | { kind: 'subagent'; subagent?: string }
  | { kind: 'wildcard' }
  | {
      kind: 'channel'
      platform: Platform
      // undefined when the rule wildcards across the whole platform (e.g. `slack:*`).
      // '*' is never stored — it is collapsed to undefined at parse time so
      // matchers stay shape-pure (presence == specificity).
      workspace?: string
      chat?: string
      // Buckets for DM-style scopes. `slack:dm/*`, `discord:dm/*`,
      // `kakao:dm/*`, `kakao:group/*`, `kakao:open/*`, `line:dm/*`,
      // `line:group/*`, `line:square/*` produce `bucket` only (no workspace,
      // no chat).
      bucket?: 'dm' | 'group' | 'open' | 'square'
      author?: string
    }

export type ParseMatchRuleResult = { ok: true; value: MatchRule } | { ok: false; error: string }

// Regex used by the JSON Schema layer for editor-time validation. Kept here
// next to the parser so divergence is harder. Deliberately permissive: it
// matches any `<name>:<value>` qualifier shape so the parser still gets to
// run and emit typo suggestions like `autor:` -> `author:`. If we tightened
// this to `author:` only, the JSON schema would reject typos with a generic
// "did not match pattern" error and the user would lose the actionable hint.
//
// The platform alternation is derived from PLATFORMS so a newly added
// platform can never validate at the parser but be rejected by this schema
// regex (the bug that shipped when 'webex' was added to PLATFORMS but not
// here).
export const MATCH_RULE_REGEX_SOURCE = `^(tui|cron|subagent(:[a-z][a-z0-9-]*)?|\\*|(${PLATFORMS.join('|')}):[^\\s]+)(\\s+[a-zA-Z][a-zA-Z0-9_]*:[^\\s]+)*$`

export function parseMatchRule(input: string): ParseMatchRuleResult {
  if (input !== input.trim() || input.length === 0) {
    return { ok: false, error: 'match rule must not have leading or trailing whitespace' }
  }

  // The DSL allows ONLY single literal spaces as token separators. Any
  // other whitespace (tabs, newlines, CR, vertical tab, NBSP, NUL, etc.)
  // inside a rule is rejected -- both because the JSON Schema regex uses
  // `\s` boundaries that would diverge from this parser otherwise, and
  // because workspace/chat IDs containing whitespace are not a legitimate
  // shape on any supported platform.
  if (/[^\S ]|\u0000/.test(input)) {
    return {
      ok: false,
      error: 'match rule must use only single ASCII spaces; no tabs, newlines, or control characters',
    }
  }
  const tokens = input.split(' ')
  if (tokens.some((t) => t.length === 0)) {
    return { ok: false, error: 'match rule must use exactly one space between tokens' }
  }
  const [scope, ...qualifiers] = tokens
  if (scope === undefined) return { ok: false, error: 'match rule is empty' }

  const qualifierResult = parseQualifiers(qualifiers)
  if (!qualifierResult.ok) return { ok: false, error: qualifierResult.error }
  const { author } = qualifierResult.value

  // Reject legacy shorthand prefixes with a hint to the canonical form.
  const legacy = LEGACY_PREFIXES.find((p) => scope === p.from || scope.startsWith(`${p.from}:`))
  if (legacy) {
    const replaced = scope === legacy.from ? legacy.to : `${legacy.to}${scope.slice(legacy.from.length)}`
    return {
      ok: false,
      error: `legacy prefix '${legacy.from}'; use '${replaced}' instead`,
    }
  }

  // Top-level keyword scopes.
  if (scope === 'tui') {
    if (author !== undefined) return { ok: false, error: "qualifier 'author:' requires a channel scope" }
    return { ok: true, value: { kind: 'tui' } }
  }
  if (scope === 'cron') {
    if (author !== undefined) return { ok: false, error: "qualifier 'author:' requires a channel scope" }
    return { ok: true, value: { kind: 'cron' } }
  }
  if (scope === 'subagent' || scope.startsWith('subagent:')) {
    if (author !== undefined) return { ok: false, error: "qualifier 'author:' requires a channel scope" }
    if (scope === 'subagent') return { ok: true, value: { kind: 'subagent' } }
    const name = scope.slice('subagent:'.length)
    if (!SUBAGENT_NAME.test(name)) {
      return { ok: false, error: `subagent name '${name}' must match ${SUBAGENT_NAME.source}` }
    }
    return { ok: true, value: { kind: 'subagent', subagent: name } }
  }
  if (scope === '*') {
    if (author !== undefined) return { ok: false, error: "qualifier 'author:' requires a specific channel scope" }
    return { ok: true, value: { kind: 'wildcard' } }
  }

  // Channel scopes: `<platform>:<rest>`.
  const colon = scope.indexOf(':')
  if (colon === -1) {
    return { ok: false, error: suggestUnknownScope(scope) }
  }
  const prefix = scope.slice(0, colon)
  const rest = scope.slice(colon + 1)
  if (!(PLATFORMS as readonly string[]).includes(prefix)) {
    return { ok: false, error: suggestUnknownScope(scope) }
  }
  const platform = prefix as Platform

  return parseChannelScope(platform, rest, author)
}

function parseChannelScope(platform: Platform, rest: string, author: string | undefined): ParseMatchRuleResult {
  if (rest.length === 0) {
    return { ok: false, error: `channel scope '${platform}:' is missing a coordinate` }
  }

  // Wildcards and redundant forms.
  if (rest === '*') {
    return { ok: true, value: buildChannelRule(platform, { author }) }
  }

  if (platform === 'github') return parseGithubChannelScope(rest, author)
  if (platform === 'sentry') return parseSentryChannelScope(rest, author)

  // Bucket scopes: `dm/*`, `dm/<id>`, `group/*`, `open/*`. Slack's `im` is
  // renamed to `dm`; that mapping is enforced by the legacy-prefix table at
  // the top of parseMatchRule for unprefixed forms — here we just refuse the
  // bare `im` bucket.
  const slash = rest.indexOf('/')
  if (slash !== -1) {
    const head = rest.slice(0, slash)
    const tail = rest.slice(slash + 1)

    if (head === 'im') {
      return { ok: false, error: `bucket 'im' renamed; use '${platform}:dm/${tail}'` }
    }

    if (head === '*') {
      // `slack:*/...` is always wrong — a chat ID is workspace-scoped, so any
      // concrete chat ID under a wildcard workspace is logically impossible.
      // Even `slack:*/*` simplifies to `slack:*`.
      const suggestion = tail === '*' ? `${platform}:*` : `${platform}:*`
      return {
        ok: false,
        error: `wildcard workspace combined with '/${tail}' is nonsensical; use '${suggestion}'`,
      }
    }

    if (head === 'dm' || head === 'group' || head === 'open' || head === 'square') {
      const bucketError = invalidBucketForPlatform(head, platform)
      if (bucketError !== null) {
        return { ok: false, error: bucketError }
      }
      if (tail === '') {
        return { ok: false, error: `bucket '${platform}:${head}/' requires '*' or a chat id` }
      }
      if (tail === '*') {
        return { ok: true, value: buildChannelRule(platform, { bucket: head, author }) }
      }
      // `slack:dm/<id>` — keep the bucket plus the specific chat. We omit a
      // separate workspace field; DM IDs are globally unique within a
      // platform's adapter.
      return {
        ok: true,
        value: buildChannelRule(platform, {
          bucket: head,
          chat: tail,
          author,
        }),
      }
    }

    // `slack:T0123/*` is redundant — drop the trailing `/*`.
    if (tail === '*') {
      return { ok: false, error: `trailing '/*' is redundant; use '${platform}:${head}'` }
    }
    // `slack:T0123/C0ABCDE` — workspace + chat.
    return {
      ok: true,
      value: buildChannelRule(platform, { workspace: head, chat: tail, author }),
    }
  }

  // No slash: `slack:T0123` or `kakao:dm` (bare bucket — error).
  if (rest === 'dm' || rest === 'group' || rest === 'open' || rest === 'square') {
    return { ok: false, error: `bucket '${platform}:${rest}' requires a chat id or '*'` }
  }
  return { ok: true, value: buildChannelRule(platform, { workspace: rest, author }) }
}

// `dm` is universal. `group`/`open` are KakaoTalk buckets; `group`/`square`
// are LINE buckets. Reject a bucket on a platform whose workspace shapes don't
// produce it, so a typo'd rule fails loudly instead of silently never matching.
function invalidBucketForPlatform(bucket: 'dm' | 'group' | 'open' | 'square', platform: Platform): string | null {
  if (bucket === 'dm') return null
  if (bucket === 'open') {
    return platform === 'kakao' ? null : `bucket 'open' is only valid for kakao`
  }
  if (bucket === 'square') {
    return platform === 'line' ? null : `bucket 'square' is only valid for line`
  }
  return platform === 'kakao' || platform === 'line' ? null : `bucket 'group' is only valid for kakao or line`
}

function parseGithubChannelScope(rest: string, author: string | undefined): ParseMatchRuleResult {
  const [owner, repo, ...chatParts] = rest.split('/')
  if (owner === undefined || owner === '' || repo === undefined || repo === '') {
    return { ok: false, error: "github scope requires 'owner/repo' format" }
  }
  if (repo === '*') {
    return {
      ok: false,
      error: `'github:${owner}/*' is not supported; use 'github:${owner}/repo' for a specific repo or 'github:*' for all github events`,
    }
  }
  const workspace = `${owner}/${repo}`
  if (chatParts.length === 0) return { ok: true, value: buildChannelRule('github', { workspace, author }) }
  const chat = chatParts.join('/')
  if (chat === '' || chat.includes('/')) {
    return { ok: false, error: "github chat scope must be a single segment like 'issue:42'" }
  }
  return { ok: true, value: buildChannelRule('github', { workspace, chat, author }) }
}

function parseSentryChannelScope(rest: string, author: string | undefined): ParseMatchRuleResult {
  const [organization, project, ...chatParts] = rest.split('/')
  if (!organization || !project || organization === '*' || project === '*') {
    return { ok: false, error: "sentry scope requires 'organization/project' or '*'" }
  }
  const workspace = `${organization}/${project}`
  if (chatParts.length === 0) return { ok: true, value: buildChannelRule('sentry', { workspace, author }) }
  const [chat] = chatParts
  if (chatParts.length !== 1 || chat === undefined || !/^issue:\d+$/.test(chat)) {
    return { ok: false, error: "sentry chat scope requires 'issue:<id>'" }
  }
  return { ok: true, value: buildChannelRule('sentry', { workspace, chat, author }) }
}

function buildChannelRule(
  platform: Platform,
  parts: {
    workspace?: string
    chat?: string
    bucket?: 'dm' | 'group' | 'open' | 'square'
    author?: string
  },
): MatchRule {
  const rule: MatchRule = { kind: 'channel', platform }
  if (parts.workspace !== undefined) rule.workspace = parts.workspace
  if (parts.chat !== undefined) rule.chat = parts.chat
  if (parts.bucket !== undefined) rule.bucket = parts.bucket
  if (parts.author !== undefined) rule.author = parts.author
  return rule
}

type ParsedQualifiers = { author?: string }
function parseQualifiers(qualifiers: string[]): { ok: true; value: ParsedQualifiers } | { ok: false; error: string } {
  const out: ParsedQualifiers = {}
  for (const token of qualifiers) {
    const eq = token.indexOf(':')
    if (eq === -1) {
      return { ok: false, error: `qualifier '${token}' must have form '<name>:<value>'` }
    }
    const name = token.slice(0, eq)
    const value = token.slice(eq + 1)
    if (value.length === 0) {
      return { ok: false, error: `qualifier '${name}:' must have a value` }
    }
    if (name === 'author') {
      if (out.author !== undefined) {
        return { ok: false, error: `qualifier 'author:' may not appear more than once in a single rule` }
      }
      out.author = value
      continue
    }
    return { ok: false, error: `unknown qualifier '${name}:'.${suggestQualifier(name)}` }
  }
  return { ok: true, value: out }
}

// Empirical typo distance: ed1 on the scope keyword catches `tem:` → `team:`
// (which is itself a legacy form), `slak:` → `slack:`, etc.
function suggestUnknownScope(scope: string): string {
  const head = scope.split(':')[0] ?? scope
  const candidates = ['tui', 'cron', 'subagent', ...PLATFORMS, '*']
  const hit = closestEd1(head, candidates)
  if (hit !== null) {
    return `unknown scope '${scope}'; did you mean '${hit}'?`
  }
  return `unknown scope '${scope}'; expected one of: tui, cron, subagent, *, ${PLATFORMS.join(', ')}`
}

function suggestQualifier(name: string): string {
  const hit = closestEd1(name, ['author'])
  return hit !== null ? ` Did you mean '${hit}:'?` : ''
}

function closestEd1(input: string, candidates: readonly string[]): string | null {
  for (const c of candidates) {
    if (editDistanceAtMost1(input, c)) return c
  }
  return null
}

function editDistanceAtMost1(a: string, b: string): boolean {
  if (a === b) return true
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    edits++
    if (edits > 1) return false
    if (la === lb) {
      i++
      j++
    } else if (la > lb) {
      i++
    } else {
      j++
    }
  }
  if (i < la || j < lb) edits++
  return edits <= 1
}

const LEGACY_PREFIXES: { from: string; to: string }[] = [
  { from: 'team', to: 'slack' },
  { from: 'guild', to: 'discord' },
  { from: 'tg', to: 'telegram' },
]
