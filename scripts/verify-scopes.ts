import 'dotenv/config'
import { makeGmailClient } from '../src/integrations/gmail/client.js'

const gmail = makeGmailClient()
const r = await gmail.users.settings.filters.list({ userId: 'me' })
console.log('Aktuelle Gmail-Filter (Anzahl):', r.data.filter?.length ?? 0)
console.log('✅ gmail.settings.basic Scope funktioniert')
