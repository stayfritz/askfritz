import { Bot } from 'grammy'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} env var not set`)
  return value
}

export function isTelegramConfigured(): boolean {
  return Boolean(
    process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ALLOWED_USER_ID,
  )
}

export function makeBot(): Bot {
  return new Bot(requireEnv('TELEGRAM_BOT_TOKEN'))
}

export function getAllowedUserId(): number {
  const raw = requireEnv('TELEGRAM_ALLOWED_USER_ID')
  const num = Number(raw)
  if (!Number.isFinite(num)) {
    throw new Error('TELEGRAM_ALLOWED_USER_ID must be a numeric user id')
  }
  return num
}
