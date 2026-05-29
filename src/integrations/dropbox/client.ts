import { Dropbox } from 'dropbox'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} env var not set`)
  return value
}

export function makeDropboxClient(): Dropbox {
  return new Dropbox({
    clientId: requireEnv('DROPBOX_APP_KEY'),
    clientSecret: requireEnv('DROPBOX_APP_SECRET'),
    refreshToken: requireEnv('DROPBOX_REFRESH_TOKEN'),
  })
}

export function getDropboxRoot(): string {
  return process.env.DROPBOX_ROOT ?? '/fritzai'
}

/**
 * Upload a file under the configured Dropbox root.
 * `relativePath` should start with `/` and be relative to the root.
 * Example: `/StayFritz Spain/Anke/2026-05-29 - foo.pdf`
 * Returns the final stored path (Dropbox may autorename on conflict).
 */
export async function uploadFile(
  client: Dropbox,
  relativePath: string,
  contents: Buffer,
): Promise<string> {
  const fullPath = getDropboxRoot() + relativePath

  const result = await client.filesUpload({
    path: fullPath,
    contents,
    mode: { '.tag': 'add' },
    autorename: true,
    mute: true,
  })

  return result.result.path_display ?? fullPath
}

/**
 * Idempotently ensure a folder exists under the root.
 * Treats path-already-exists errors as success.
 */
export async function ensureFolder(
  client: Dropbox,
  relativePath: string,
): Promise<void> {
  const fullPath = getDropboxRoot() + relativePath
  try {
    await client.filesCreateFolderV2({ path: fullPath, autorename: false })
  } catch (err) {
    if (isFolderConflict(err)) return
    throw err
  }
}

function isFolderConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { status?: number; error?: { error_summary?: string } }
  if (e.status === 409) return true
  const summary = e.error?.error_summary ?? ''
  return summary.includes('path/conflict') || summary.includes('folder')
}
