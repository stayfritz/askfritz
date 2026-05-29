import 'dotenv/config'
import { ask } from '../src/integrations/llm/client.js'
import { makeGmailClient } from '../src/integrations/gmail/client.js'
import {
  getDropboxRoot,
  makeDropboxClient,
} from '../src/integrations/dropbox/client.js'

async function testAnthropic(): Promise<void> {
  process.stdout.write('🧪 Anthropic ... ')
  const reply = await ask('Reply with just the word OK.', {
    tier: 'classifier',
    maxTokens: 16,
  })
  console.log(`✅ ${reply.trim()}`)
}

async function testGmail(): Promise<void> {
  process.stdout.write('🧪 Gmail ...     ')
  const gmail = makeGmailClient()
  const { data } = await gmail.users.getProfile({ userId: 'me' })
  console.log(
    `✅ ${data.emailAddress} (${data.messagesTotal} msgs / ${data.threadsTotal} threads)`,
  )
}

async function testDropbox(): Promise<void> {
  process.stdout.write('🧪 Dropbox ...   ')
  const dbx = makeDropboxClient()
  const account = await dbx.usersGetCurrentAccount()
  console.log(
    `✅ ${account.result.email} (root: ${getDropboxRoot()})`,
  )
}

async function main(): Promise<void> {
  await testAnthropic()
  await testGmail()
  await testDropbox()
  console.log('\nAll three integrations alive.')
}

main().catch((err) => {
  console.error('\n❌ Smoke test failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
