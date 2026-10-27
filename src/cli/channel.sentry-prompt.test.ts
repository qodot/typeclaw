import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

import { runAddChannel, scaffold, type SentryInitCredentials } from '@/init'
import { isWindows } from '@/shared/platform'

test.skipIf(isWindows())('앱 인증을 기본으로 권장하고 고정 공개 주소를 입력받는다', async () => {
  const result = await runPrompt([
    { prompt: 'Sentry 인증 방식', input: '\r' },
    ...credentialInputs('Internal Integration 앱 토큰'),
    { prompt: 'Sentry 웹훅 터널', input: '\x1b[B\r' },
    { prompt: '공개 웹훅 URL', input: 'https://sentry.example.com/webhook\r' },
    { prompt: '컨테이너 내부 웹훅 수신 포트', input: '\r' },
  ])
  expect(result.value).toEqual({
    organization: 'acme',
    integration: 'typeclaw',
    projects: ['backend', 'web'],
    auth: { type: 'app', token: 'trial-token' },
    webhookSecret: 'trial-secret',
    apiUrl: 'https://sentry.io',
    tunnelProvider: 'external',
    webhookUrl: 'https://sentry.example.com/webhook',
    webhookPort: 8976,
  })
  expect(result.output).toContain('Internal Integration 앱 토큰 (권장)')
  expect(result.output).toContain('Cloudflare Named Tunnel (고정 주소)')
  expect(result.output).not.toContain('Cloudflare Quick Tunnel')
  expect(result.output).toContain('https://sentry.example.com/webhook를 직접 등록하세요')
})

test.skipIf(isWindows())('개인 인증을 선택하면 퀵 터널을 기본으로 사용한다', async () => {
  const result = await runPrompt([
    { prompt: 'Sentry 인증 방식', input: '\x1b[A\r' },
    ...credentialInputs('개인 인증 토큰'),
    { prompt: 'Sentry 웹훅 터널', input: '\r' },
    { prompt: '컨테이너 내부 웹훅 수신 포트', input: '\r' },
  ])
  expect(result.value).toEqual({
    organization: 'acme',
    integration: 'typeclaw',
    projects: ['backend', 'web'],
    auth: { type: 'pat', token: 'trial-token' },
    webhookSecret: 'trial-secret',
    apiUrl: 'https://sentry.io',
    tunnelProvider: 'cloudflare-quick',
    webhookPort: 8976,
  })
  expect(result.output).toContain('Cloudflare Quick Tunnel (계정 불필요, 재시작 시 주소 변경)')
})

test.skipIf(isWindows())('인증 선택을 취소하면 설정 없이 종료한다', async () => {
  const result = await runPrompt([{ prompt: 'Sentry 인증 방식', input: '\x1b' }])
  expect(result.value).toBeNull()
  expect(result.output).not.toContain('Sentry 조직 slug')
})

test.skipIf(isWindows())('개인 인증에서 앱 인증으로 전환하면 고정 웹훅 주소와 새 토큰을 함께 저장한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-sentry-switch-'))
  try {
    await scaffold(dir)
    await runAddChannel({
      cwd: dir,
      channel: 'sentry',
      organization: 'acme',
      integration: 'typeclaw',
      projects: ['backend'],
      auth: { type: 'pat', token: 'previous-token' },
      webhookSecret: 'preserved-secret',
      tunnelProvider: 'cloudflare-quick',
    })
    await runAddChannel({ cwd: dir, channel: 'telegram-bot', telegramBotToken: 'sibling-token' })
    const beforeConfig = JSON.parse(await readFile(join(dir, 'typeclaw.json'), 'utf8'))
    const beforeSecrets = JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8'))
    const result = await runTerminal(
      dir,
      [process.execPath, fileURLToPath(new URL('./index.ts', import.meta.url)), 'channel', 'set', 'sentry'],
      [
        { prompt: '변경할 Sentry 인증 정보', input: '\r' },
        { prompt: 'Sentry 인증 변경 방식', input: '\x1b[B\r' },
        { prompt: 'Sentry Internal Integration 앱 토큰', input: 'new-app-token\r' },
        { prompt: 'Sentry에 직접 등록할 고정 공개 웹훅 URL', input: 'https://fixed.example.com/sentry\r' },
      ],
    )
    expect(result.exitCode, result.output).toBe(0)
    expect(result.output).toContain('https://fixed.example.com/sentry를 직접 등록하세요')
    const afterConfig = JSON.parse(await readFile(join(dir, 'typeclaw.json'), 'utf8'))
    const afterSecrets = JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8'))
    expect(afterConfig).toEqual({
      ...beforeConfig,
      channels: {
        ...beforeConfig.channels,
        sentry: { ...beforeConfig.channels.sentry, webhookUrl: 'https://fixed.example.com/sentry' },
      },
    })
    expect(afterSecrets).toEqual({
      ...beforeSecrets,
      channels: {
        ...beforeSecrets.channels,
        sentry: {
          auth: { type: 'app', token: { value: 'new-app-token' } },
          webhookSecret: { value: 'preserved-secret' },
        },
      },
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

function credentialInputs(tokenPrompt: string): { prompt: string; input: string }[] {
  return [
    { prompt: 'Sentry 조직 slug', input: 'acme\r' },
    { prompt: 'Custom Integration slug', input: 'typeclaw\r' },
    { prompt: '수신할 프로젝트 slug', input: 'backend, web\r' },
    { prompt: tokenPrompt, input: 'trial-token\r' },
    { prompt: 'Custom Integration의 Client Secret', input: 'trial-secret\r' },
    { prompt: 'Sentry API 서버 주소', input: '\r' },
  ]
}

async function runPrompt(steps: { prompt: string; input: string }[]): Promise<{
  value: SentryInitCredentials | null
  output: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-sentry-prompt-'))
  const source = `import { promptSentryCredentials } from ${JSON.stringify(new URL('./channel.ts', import.meta.url).href)}; const result = await promptSentryCredentials(${JSON.stringify(dir)}); console.log('TYPECLAW_PROMPT_RESULT=' + JSON.stringify(result));`
  try {
    const result = await runTerminal(
      fileURLToPath(new URL('../../', import.meta.url)),
      [process.execPath, '--eval', source],
      steps,
      dir,
    )
    expect(result.exitCode, result.output).toBe(0)
    const value = /TYPECLAW_PROMPT_RESULT=([^\r\n]+)/.exec(result.output)?.[1]
    if (value === undefined) throw new Error(`프롬프트 결과가 없습니다:\n${result.output}`)
    return { value: JSON.parse(value) as SentryInitCredentials | null, output: result.output }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function runTerminal(
  cwd: string,
  command: string[],
  steps: { prompt: string; input: string }[],
  stateDir = cwd,
): Promise<{ output: string; exitCode: number }> {
  let output = ''
  const decoder = new TextDecoder()
  let step = 0
  let consumed = 0
  let fail: (reason: Error) => void = () => {}
  const expired = new Promise<never>((_, reject) => {
    fail = reject
  })
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, TYPECLAW_HOME: stateDir, TERM: 'xterm-256color' },
    terminal: {
      cols: 160,
      rows: 40,
      data(terminal, data) {
        output += stripVTControlCharacters(decoder.decode(data, { stream: true }))
        const next = steps[step]
        if (next && output.slice(consumed).includes(next.prompt)) {
          consumed = output.length
          step++
          terminal.write(next.input)
        }
      },
    },
  })
  const deadline = setTimeout(() => fail(new Error(`프롬프트 ${step + 1} 대기 시간 초과:\n${output}`)), 10000)
  try {
    const exitCode = await Promise.race([child.exited, expired])
    return { output, exitCode }
  } finally {
    clearTimeout(deadline)
    child.kill()
    await child.exited
    child.terminal?.close()
  }
}
