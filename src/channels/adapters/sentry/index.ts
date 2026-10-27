import type { ChannelRouter } from '@/channels/router'
import type { SentryAdapterConfig } from '@/channels/schema'
import type { ChannelSelfIdentityResolver } from '@/channels/types'
import { resolveSecret } from '@/secrets/resolve'
import type { SentrySecretsBlock } from '@/secrets/schema'

import { SentryClient, type SentrySelf } from './client'
import { createSentryHistoryCallback } from './history'
import { createSentryWebhookHandler } from './inbound'
import { createSentryOutboundCallback } from './outbound'
import { createSentryRecoveryCallbacks } from './recovery'
import { registerSentryWebhook } from './webhook-register'

export type SentryAdapterOptions = {
  router: ChannelRouter
  configRef: () => SentryAdapterConfig
  secrets: SentrySecretsBlock
  logger?: { info: (message: string) => void; warn: (message: string) => void; error: (message: string) => void }
  client?: SentryClient
  tunnelUrl?: () => string | null
  tunnelConfiguredForChannel?: () => boolean
}

export type SentryAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
}

export function createSentryAdapter(options: SentryAdapterOptions): SentryAdapter {
  const logger = options.logger ?? console
  const token = resolveSecret(options.secrets.auth.token, undefined, process.env)
  const webhookSecret = resolveSecret(options.secrets.webhookSecret, undefined, process.env)
  if (!token || !webhookSecret) throw new Error('Sentry token과 webhookSecret이 필요합니다')
  const client =
    options.client ?? new SentryClient({ token, baseUrl: `${options.configRef().apiUrl.replace(/\/$/, '')}/api/0` })
  let self: SentrySelf | null = null
  const recovery = createSentryRecoveryCallbacks(client, options.configRef, () =>
    self === null ? undefined : `sentry:${self.id}`,
  )
  const outbound = createSentryOutboundCallback(client, options.configRef)
  const history = createSentryHistoryCallback(client, options.configRef)
  const selfIdentity: ChannelSelfIdentityResolver = () =>
    self === null ? null : { id: self.id, username: self.username }
  const handler = createSentryWebhookHandler({
    webhookSecret,
    configRef: options.configRef,
    logger,
    route: (message) =>
      options.router.route({ ...message, accountIdentity: self === null ? undefined : `sentry:${self.id}` }),
  })
  let server: ReturnType<typeof Bun.serve> | null = null
  return {
    async start() {
      if (server !== null) return
      const authenticated = await client.getSelf()
      if (!authenticated.ok) throw new Error(`${authenticated.error}. Sentry 인증 토큰을 확인하세요`)
      self = authenticated.value
      options.router.registerOutbound('sentry', outbound)
      options.router.registerHistory('sentry', history)
      options.router.registerSelfIdentity('sentry', selfIdentity)
      options.router.registerRecoveryAdapter('sentry', recovery)
      try {
        server = Bun.serve({ port: options.configRef().webhookPort, fetch: handler })
      } catch (error) {
        options.router.unregisterOutbound('sentry', outbound)
        options.router.unregisterHistory('sentry', history)
        options.router.unregisterSelfIdentity('sentry', selfIdentity)
        options.router.unregisterRecoveryAdapter('sentry', recovery)
        self = null
        throw error
      }
      logger.info(`[sentry] 웹훅 수신 포트: ${server.port}`)
      const config = options.configRef()
      const tunnelUrl = options.tunnelUrl?.() ?? null
      if (config.webhookUrl !== undefined && tunnelUrl !== null)
        logger.warn('[sentry] webhookUrl 설정을 터널 URL보다 우선합니다')
      const webhookUrl = config.webhookUrl ?? tunnelUrl
      if (webhookUrl === null) {
        logger.warn(
          options.tunnelConfiguredForChannel?.()
            ? '[sentry] 터널 URL을 기다립니다. tunnel status로 연결 상태를 확인하세요'
            : '[sentry] 웹훅 등록 생략: channels.sentry.webhookUrl 또는 Sentry 채널 터널을 설정하세요',
        )
        return
      }
      if (options.secrets.auth.type === 'app') {
        logger.info(
          `[sentry] 앱 인증: Sentry 통합 설정에 고정 웹훅 주소 ${webhookUrl}를 직접 등록하고 Issues 웹훅을 선택하세요`,
        )
        return
      }
      const registration = await registerSentryWebhook(client, {
        integration: config.integration,
        organization: config.organization,
        webhookUrl,
      })
      if (registration.ok) logger.info(`[sentry] 웹훅 주소 갱신 완료: ${registration.value.webhookUrl}`)
      else
        logger.error(
          `[sentry] 웹훅 등록 실패: ${registration.error}. 조직 구성원의 org:write 토큰과 통합 설정을 확인하고 재시작하세요`,
        )
    },
    async stop() {
      if (server === null) return
      options.router.unregisterOutbound('sentry', outbound)
      options.router.unregisterHistory('sentry', history)
      options.router.unregisterSelfIdentity('sentry', selfIdentity)
      options.router.unregisterRecoveryAdapter('sentry', recovery)
      await server.stop(true)
      server = null
      self = null
    },
    isConnected: () => server !== null,
  }
}
