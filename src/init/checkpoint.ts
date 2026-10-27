import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  KNOWN_PROVIDERS,
  listKnownModelRefs,
  listKnownProviderVendorIds,
  providerIdsForVendor,
  type KnownProviderId,
  type KnownProviderVendorId,
  type ModelRef,
} from '@/config/providers'

// In-folder scratch for an in-progress `typeclaw init`, co-located with the
// agent it describes. Lives under the agent's `.typeclaw/` (the same gitignored
// local-scratch dir that may contain orphaned legacy runtime-HOME credentials),
// so it self-cleans when the half-init folder is deleted, survives a folder
// rename mid-init, and is inspectable right next to the thing being resumed.
// Gitignored via `TRULY_IGNORED_PATTERNS`; never committed.
export const INIT_CHECKPOINT_PATH = join('.typeclaw', 'init-progress.json')

export const WIZARD_CHECKPOINT_VERSION = 1

export type WizardChannelChoice =
  | 'slack'
  | 'discord'
  | 'telegram'
  | 'webex'
  | 'teams'
  | 'kakaotalk'
  | 'github'
  | 'sentry'
  | 'none'

export type AuthMethod = 'api-key' | 'oauth'

// Only stable selection IDs — never `llmAuth`, tokens, OAuth data, channel
// secrets, the volatile models.dev catalog, or full `ModelOption` objects. The
// projection in `checkpointFromSelections` is the single seam that enforces
// this, so a secret can never leak into host state by accident.
export interface WizardAnswerCheckpointV1 {
  version: typeof WIZARD_CHECKPOINT_VERSION
  cwd: string
  updatedAt: string
  vendorId?: KnownProviderVendorId
  providerId?: KnownProviderId
  modelRef?: ModelRef | string
  authMethod?: AuthMethod
  visionVendorId?: KnownProviderVendorId
  visionProviderId?: KnownProviderId
  visionModelRef?: ModelRef | string
  visionAuthMethod?: AuthMethod
  channelChoice?: WizardChannelChoice
}

export interface WizardCheckpointStore {
  load(cwd: string): Promise<WizardAnswerCheckpointV1 | undefined>
  save(cwd: string, checkpoint: WizardAnswerCheckpointV1): Promise<void>
  clear(cwd: string): Promise<void>
}

// Selections the wizard already holds, projected to the persisted shape. Keep
// this the ONLY place that reads `WizardState` so secret fields are physically
// unable to reach the checkpoint file.
export interface WizardCheckpointSelections {
  cwd: string
  vendorId?: KnownProviderVendorId
  providerId?: KnownProviderId
  modelRef?: ModelRef | string
  authMethod?: AuthMethod
  visionVendorId?: KnownProviderVendorId
  visionProviderId?: KnownProviderId
  visionModelRef?: ModelRef | string
  visionAuthMethod?: AuthMethod
  channelChoice?: WizardChannelChoice
}

export function checkpointFromSelections(selections: WizardCheckpointSelections): WizardAnswerCheckpointV1 {
  return {
    version: WIZARD_CHECKPOINT_VERSION,
    cwd: selections.cwd,
    updatedAt: new Date().toISOString(),
    ...(selections.vendorId !== undefined ? { vendorId: selections.vendorId } : {}),
    ...(selections.providerId !== undefined ? { providerId: selections.providerId } : {}),
    ...(selections.modelRef !== undefined ? { modelRef: selections.modelRef } : {}),
    ...(selections.authMethod !== undefined ? { authMethod: selections.authMethod } : {}),
    ...(selections.visionVendorId !== undefined ? { visionVendorId: selections.visionVendorId } : {}),
    ...(selections.visionProviderId !== undefined ? { visionProviderId: selections.visionProviderId } : {}),
    ...(selections.visionModelRef !== undefined ? { visionModelRef: selections.visionModelRef } : {}),
    ...(selections.visionAuthMethod !== undefined ? { visionAuthMethod: selections.visionAuthMethod } : {}),
    ...(selections.channelChoice !== undefined ? { channelChoice: selections.channelChoice } : {}),
  }
}

// Drop any saved field that no longer references a real vendor/provider/model.
// Stale values cascade downward: an unknown provider invalidates its model and
// auth-method too, since those were chosen for a provider that no longer
// exists. Returns a sanitized copy; never throws on drift.
export function sanitizeCheckpointAgainstCatalog(
  checkpoint: WizardAnswerCheckpointV1,
  validModelRefs: ReadonlySet<string> = new Set(listKnownModelRefs()),
): WizardAnswerCheckpointV1 {
  const sanitized: WizardAnswerCheckpointV1 = {
    version: WIZARD_CHECKPOINT_VERSION,
    cwd: checkpoint.cwd,
    updatedAt: checkpoint.updatedAt,
  }

  const vendor = pruneVendor(checkpoint.vendorId)
  const provider = pruneProvider(vendor, checkpoint.providerId)
  if (vendor !== undefined) sanitized.vendorId = vendor
  if (provider !== undefined) {
    sanitized.providerId = provider
    if (checkpoint.modelRef !== undefined && validModelRefs.has(checkpoint.modelRef)) {
      sanitized.modelRef = checkpoint.modelRef
    }
    if (checkpoint.authMethod !== undefined) sanitized.authMethod = checkpoint.authMethod
  }

  const visionVendor = pruneVendor(checkpoint.visionVendorId)
  const visionProvider = pruneProvider(visionVendor, checkpoint.visionProviderId)
  if (visionVendor !== undefined) sanitized.visionVendorId = visionVendor
  if (visionProvider !== undefined) {
    sanitized.visionProviderId = visionProvider
    if (checkpoint.visionModelRef !== undefined && validModelRefs.has(checkpoint.visionModelRef)) {
      sanitized.visionModelRef = checkpoint.visionModelRef
    }
    if (checkpoint.visionAuthMethod !== undefined) sanitized.visionAuthMethod = checkpoint.visionAuthMethod
  }

  if (checkpoint.channelChoice !== undefined) sanitized.channelChoice = checkpoint.channelChoice

  return sanitized
}

function pruneVendor(vendorId: KnownProviderVendorId | undefined): KnownProviderVendorId | undefined {
  if (vendorId === undefined) return undefined
  return listKnownProviderVendorIds().includes(vendorId) ? vendorId : undefined
}

function pruneProvider(
  vendorId: KnownProviderVendorId | undefined,
  providerId: KnownProviderId | undefined,
): KnownProviderId | undefined {
  if (vendorId === undefined || providerId === undefined) return undefined
  if (!(providerId in KNOWN_PROVIDERS)) return undefined
  return providerIdsForVendor(vendorId).includes(providerId) ? providerId : undefined
}

function checkpointFilePath(cwd: string): string {
  return join(cwd, INIT_CHECKPOINT_PATH)
}

export function createLocalWizardCheckpointStore(): WizardCheckpointStore {
  return {
    async load(cwd) {
      const path = checkpointFilePath(cwd)
      let parsed: unknown
      try {
        parsed = JSON.parse(await readFile(path, 'utf8'))
      } catch {
        return undefined
      }
      if (!isValidCheckpoint(parsed)) return undefined
      return parsed
    },

    // Atomic write: temp + rename within the agent's .typeclaw/ so a crash
    // mid-write never leaves a half-written file that `load` would misparse and
    // discard.
    async save(cwd, checkpoint) {
      const final = checkpointFilePath(cwd)
      const tmp = `${final}.${process.pid}.tmp`
      await mkdir(dirname(final), { recursive: true })
      await writeFile(tmp, JSON.stringify(checkpoint), { mode: 0o600 })
      await rename(tmp, final)
    },

    async clear(cwd) {
      try {
        await unlink(checkpointFilePath(cwd))
      } catch {}
    },
  }
}

function isValidCheckpoint(value: unknown): value is WizardAnswerCheckpointV1 {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.version !== WIZARD_CHECKPOINT_VERSION) return false
  if (typeof v.cwd !== 'string') return false
  if (typeof v.updatedAt !== 'string') return false
  // Every optional selection field must be a string when present. Membership
  // (is this a real provider/model?) is the sanitizer's job, but a non-string
  // here is structurally corrupt and would later index KNOWN_PROVIDERS or join
  // into prompt text with a wrong shape — reject it at load.
  return OPTIONAL_STRING_FIELDS.every((field) => v[field] === undefined || typeof v[field] === 'string')
}

const OPTIONAL_STRING_FIELDS = [
  'vendorId',
  'providerId',
  'modelRef',
  'authMethod',
  'visionVendorId',
  'visionProviderId',
  'visionModelRef',
  'visionAuthMethod',
  'channelChoice',
] as const satisfies ReadonlyArray<keyof WizardAnswerCheckpointV1>
