/**
 * Run the agent locally with a question. Useful to test tool-use before deploy.
 *
 * Usage: pnpm exec tsx scripts/agent-test.ts "Welche Tasks habe ich?"
 *
 * Safety: tools will execute against real Gmail / Postgres if Claude decides
 * to call them. Use read-only questions for safe testing.
 */
import 'dotenv/config'
import { answerQuery } from '../src/core/query.js'

async function main(): Promise<void> {
  const question =
    process.argv.slice(2).join(' ') ||
    'Welche pending Tasks habe ich gerade? Antworte kurz.'

  console.log(`Q: ${question}\n`)
  const answer = await answerQuery(question, { userId: 0 })
  console.log(`A: ${answer}`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
