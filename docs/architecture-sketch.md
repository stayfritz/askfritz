# askfritz — Architektur-Skizze v0

**Datum:** 2026-05-29
**Status:** Konzept · alle technischen Entscheidungen getroffen · DNS-Klärung für `fritz@stayfritz.ai` ausstehend

---

## Vision

Ein persönlicher AI-Stabschef, der dich kennt, mitdenkt, organisiert, ausführt — und nur bei Entscheidungen rückfragt.

Eine Schnittstelle (initial: Email an `fritz@stayfritz.ai`, später: 2× WhatsApp — DE privat + ES mobil), die deine Lebensbereiche kennt (StayFritz Spain, Privat, Familie, ...), Kontakte zuordnet, Dokumente ablegt, Status verfolgt, und Aktionen mit deiner Freigabe ausführt.

**Kernprinzip:** Der Agent sortiert, organisiert, führt aus. Du triffst die Entscheidungen.

---

## 1. Entschieden 2026-05-29

| Punkt | Wert |
|---|---|
| Repo-Name | `askfritz` |
| Email-Adresse | `fritz@stayfritz.ai` |
| Dropbox-Root | `/fritzai/` |
| Postgres-Hosting | dedicated Coolify-Service auf fritz-comms Server (178.104.71.45) |
| Repo-Sichtbarkeit | GitHub privat zu Start, später public |

### Tech-Stack

| Layer | Wahl | Warum |
|---|---|---|
| Runtime | Node.js 22 + TypeScript | Production-Standard für agentic Systeme in 2026, OSS-deployment-freundlich, konsistent mit deinen anderen Projekten |
| Web-Server | Hono | Modern, schnell, minimal (leichter als Express/Fastify in 2026) |
| ORM | Drizzle | Type-safe Postgres, lean, modern |
| LLM | Anthropic SDK (+ optional Claude Agent SDK) | Claude direkt; Agent SDK liefert Tool-Use-Orchestrierung + Memory-Patterns (gleiche Basis wie Claude Code) |
| Database | Postgres 16+ mit `pgvector` Extension | Standard; pgvector für spätere Embedding-basierte Suche im Life State |
| Validation | Zod | Tool-Schemas, Config-Validation, runtime safety |
| Deployment | Coolify auf fritz-comms Server | Konsistent mit Infra |

---

## 2. Datenmodell: Life State

Strukturiertes Gedächtnis deines Lebens. Postgres.

### Kern-Tabellen

```sql
domains
  id (text)         -- "stayfritz_spain", "privat", "familie"
  name (text)       -- "StayFritz Spain", "Privat"
  description (text)
  default_language  -- "de"

persons
  id (text)         -- "anke", "stb_garcia", "mario_dkb"
  domain_id
  name              -- "Anke Svenester"
  role              -- "service_provider:insurance_admin"
  emails (text[])
  phones (text[])
  language          -- "de"
  notes

topics
  id (text)         -- "krankenversicherung_es_2026"
  domain_id
  name              -- "Krankenversicherung Spanien (Familie)"
  status            -- in_progress | blocked | done
  priority          -- low | med | high
  due_date
  owner_person_id   -- wer treibt das (oft Anke o.ä.)

topic_items                  -- granulare Sub-Status
  id
  topic_id
  name              -- "KV Kind 2 (Anna)"
  status            -- registered | pending | blocked | missing
  last_update_at
  source_doc_id
  notes

documents
  id
  topic_id
  source            -- gmail | dropbox | upload
  source_id         -- gmail msg id
  sender_person_id
  received_at
  summary           -- LLM-generiert
  dropbox_path      -- "/fritzai/StayFritz Spain/Anke/KV/2026-04-14 - ..."
  original_subject

tasks
  id
  topic_id
  description
  status            -- pending_user | approved | executing | done | snoozed
  draft_content     -- vorbereiteter Entwurf
  requires_decision -- bool
  created_at
  due_at

threads                      -- email-konversationen
  id
  domain_id
  topic_id
  participants
  status            -- open | waiting_user | waiting_partner | closed
  last_message_at
  summary
```

### Konkretes Beispiel (StayFritz Spain)

```yaml
domain: stayfritz_spain
  persons:
    - anke        (Anke Svenester, role: insurance_admin, lang: de)
    - stb_garcia  (María García, role: tax_advisor, lang: es)
    - mario_dkb   (Mario Schulz, role: banker:dkb, lang: de)

  topics:
    - krankenversicherung_es_2026
        status: in_progress
        owner: anke
        items:
          - kind1_anna : registered  ✅  (Mail Anke 14.4.)
          - kind2_max  : pending     ⏳  (wartet auf NIE-Nummer)
          - kind3_lena : missing     ❌  (noch nichts eingereicht)

    - steuererklaerung_es_2025
        status: in_progress
        owner: stb_garcia
        due: 2026-06-30

    - geschaeftskonto_setup
        status: blocked
        owner: mario_dkb
        notes: "wartet auf NIE-Nummer (Cross-ref → krankenversicherung_es)"
```

---

## 3. Ingestion-Flow

```
[Gmail Push Notification @ fritz@stayfritz.ai]
        ↓
[Webhook → fetch full message]
        ↓
[LLM Classifier]
   In:  from, subject, body
   Out: { domain_id, topic_id?, person_id?, intent, urgency, language }
        ↓
[Life State Update]
   - Sender → person (anlegen falls neu → flag for review)
   - Match topic (fuzzy: subject keywords + sender + recent context)
   - Status update falls aus Content ableitbar
        ↓
[Attachment Handling] (falls vorhanden)
   - LLM: classify each attachment (doc type, key info)
   - Normalize filename: "YYYY-MM-DD - <sender> - <topic> - <doctype>.pdf"
   - Upload Dropbox: /fritzai/<Domain>/<Person|Topic>/<Year>/<filename>
   - Document-Record in Life State, verlinkt mit topic_item
        ↓
[Action Decision]
   - Pure Update (FYI) → silent log, optional Mini-Notification
   - Decision needed → task (status: pending_user) + draft response
   - Auto-action allowed (per policy.yaml) → execute, log
```

### Beispiel: Mail von Anke

```
From: anke@svenester.de
Subject: KV Anna - alles erledigt
Body: "Hi Thomas, Anna ist jetzt offiziell registriert.
       Anbei die Bestätigung. Bei Max fehlt noch die NIE-Nummer..."
Attachments: bestaetigung_kv_anna.pdf
```

**Ingestion:**
1. Classifier → domain=stayfritz_spain, topic=krankenversicherung_es_2026, sender=anke
2. State-Updates:
   - `topic_items.kind1_anna.status`: pending → **registered**
   - `topic_items.kind2_max.notes`: "wartet auf NIE-Nummer" (bestätigt)
3. Attachment → `/fritzai/StayFritz Spain/Anke/KV/2026-04-14 - Anke - KV Anna Bestätigung.pdf`
4. Action: kein Entscheidungsbedarf → silent. Optional kurze Nachricht: "Anke meldet: Anna KV bestätigt ✅"

---

## 4. Konversations-Loop

**User-Frage:** *"Haben wir alle Kinder in der spanischen Krankenversicherung angemeldet?"*

Schritt für Schritt:

1. **Empfang** an `fritz@stayfritz.ai`
2. **Intent-Erkennung** (LLM): query, domain=stayfritz_spain|privat, topic=krankenversicherung_es
3. **Life State Query:**
   ```sql
   SELECT * FROM topic_items WHERE topic_id = 'krankenversicherung_es_2026'
   ```
4. **Antwort-Komposition** (LLM mit Life State als Context):
   ```
   Stand heute (29.5., Quelle: Mail Anke vom 23.5.):

   ✅ Anna (Kind 1) — angemeldet (Bestätigung 14.4.)
   ⏳ Max  (Kind 2) — wartend auf NIE-Nummer
   ❌ Lena (Kind 3) — noch nicht eingereicht, kein offener Vorgang

   Soll ich Anke fragen, wie der Stand bei Lena ist und ob Max'
   NIE-Nummer inzwischen da ist?
   ```
5. **User:** "ja, bitte"
6. **Draft:**
   - LLM erstellt Mail-Entwurf an Anke (DE, höflich, knapp, konkret)
   - Status: `pending_user_approval`
7. **Freigabe-Loop:**
   - Entwurf wird dir per Email gezeigt (in v2: WhatsApp inline-button)
   - Du: "passt" / "ändere X" / "nein, ich antworte selbst"
   - Bei "passt" → senden, Task → `executing`, Thread → `waiting_partner`
8. **Follow-up:**
   - 3 Tage keine Antwort → automatischer Reminder-Vorschlag
   - Antwort kommt → zurück zu Ingestion-Flow

---

## 5. Repo-Struktur

```
/askfritz
├── README.md
├── LICENSE                      # MIT
├── docker-compose.yml           # Postgres + App
├── package.json
├── tsconfig.json
│
├── src/
│   ├── core/                    # Generischer Kern
│   │   ├── life-state.ts        # CRUD über Domains/Persons/Topics
│   │   ├── classifier.ts        # LLM-Klassifikation eingehender Nachrichten
│   │   ├── ingestion.ts         # Pipeline Mail → State + Docs
│   │   ├── conversation.ts      # Query-Beantwortung
│   │   ├── action.ts            # Draft + Approval + Execute
│   │   └── policy.ts            # Welche Aktionen brauchen Freigabe?
│   │
│   ├── integrations/
│   │   ├── gmail/               # OAuth, push notifications, send
│   │   ├── dropbox/             # OAuth, upload, folder management
│   │   ├── postgres/            # Drizzle DB layer
│   │   ├── llm/                 # Anthropic SDK (cache-aware)
│   │   └── whatsapp/            # v2
│   │
│   ├── prompts/                 # Generisch, mit Config-Templating
│   │   ├── classifier.md
│   │   ├── ingestion.md
│   │   ├── conversation.md
│   │   └── draft.md
│   │
│   └── server.ts                # Hono, Webhook-Endpoints
│
├── config/                      # ← User-spezifisch, NICHT im OSS-Repo
│   ├── domains.yaml             # Lebensbereiche
│   ├── persons.yaml             # Kontakte
│   ├── policies.yaml            # Approval-Regeln pro Domain
│   ├── routing.yaml             # Email/WhatsApp-Channels → Domain
│   └── system.yaml              # Sprache default, Zeitzone, Dropbox-Root
│
├── migrations/                  # Drizzle Migrations
├── tests/
└── docs/
    ├── setup.md
    ├── architecture.md
    └── self-hosting.md
```

### Trennung Code / Config / Daten

| Was | Wo | Wer sieht's |
|---|---|---|
| Generischer Code | `src/` (Git, OSS) | alle |
| Deine Kontakte/Domains | `config/*.yaml` | nur du |
| Secrets | `.env` (gitignored) | nur du |
| Life State | deine Postgres | nur du |
| Dokumente | deine Dropbox (`/fritzai/`) | nur du |
| LLM-Calls | Anthropic API | Logs ephemer |

→ Andere Nutzer klonen `askfritz`, schreiben eigene `config/`, verbinden eigene Gmail + Dropbox + Postgres, fertig.

---

## v0 Scope (~4 Wochen)

**In:**
- Gmail Push + Webhook Ingestion
- Classifier + Life State Updates
- Dropbox Attachment Ablage unter `/fritzai/`
- Konversations-Endpoint (Email → Email)
- Approval-Flow per Email (Draft → Reply → Send)
- 1 Domain (StayFritz Spain), 3 Personen, 3 Topics
- Postgres + Drizzle-Migrations
- Self-host auf deinem Coolify

**Out (kommt später):**
- WhatsApp (v2)
- Calendar Integration (v3)
- Proaktive Morgen-Briefings (v3)
- Web-UI für Life State Inspektion (v2)
- Weitere Domains (sobald Patterns validiert)

---

## Offene Punkte

**Vor dem Start zu klären:**
- **DNS für `fritz@stayfritz.ai`** — liegt `stayfritz.ai` DNS-mäßig bei dir? Gibt es schon einen Mailserver (Google Workspace o.ä.)? Davon hängt das Setup ab (neuer Workspace-User, Alias, oder eigene MX-Records).

**Schritt 1 (nach DNS-Klärung, ~1 Woche):**
1. GitHub Repo `askfritz` (privat) anlegen
2. Scaffold: Node 22 + TS + Hono + Drizzle + Zod + Anthropic SDK
3. Postgres-Schema (domains, persons, topics, topic_items, documents, tasks, threads)
4. Migrations auf Coolify-Postgres-Instanz
5. Gmail OAuth + Push-Subscription für `fritz@stayfritz.ai`
6. Leere Ingestion-Pipeline (Webhook empfangen + ins Log schreiben — noch kein Classifier)
7. Erstes Lebenszeichen: eingehende Mail erscheint im Log, normalisiert

**Danach (Woche 2-4):**
- LLM Classifier + Life State Updates
- Dropbox-Integration + Attachment-Ablage unter `/fritzai/`
- Konversations-Endpoint (Mail an `fritz@stayfritz.ai` → Antwort)
- Approval-Flow per Email (Draft → Bestätigung → Send)
- Erste Domain-Config: StayFritz Spain (mit Anke, Stb, Bankberater)
