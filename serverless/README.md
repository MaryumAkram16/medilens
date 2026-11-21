# MediLens serverless backend

TypeScript serverless functions (Vercel) that replace Maryum Akram's MediLens n8n modules. The n8n exports in the repository root stay as the design record.

**This PR: department-based complaint management.** The Retell voice agent's endpoints (booking, rescheduling, cancellation, complaint status by phone) and voice complaints follow in the next PRs.

> **Demo system.** Use synthetic data only. It is not a medical service and gives no medical advice. In an emergency, call **1122**.

## What changed from the n8n workflow

| n8n `Complaint_Management.json` | This backend |
|---|---|
| Patient picks High, Medium or Low | **The AI decides** the priority. The patient's choice is kept as a hint, and the audit log records when the AI disagreed. |
| Gemini returns sentiment and suggested action | Gemini returns **priority, department, category, sentiment, suggested action and confidence** in a strict JSON schema, checked again with zod |
| No routing | **Routed to the department** that must act, and that department gets the alert email |
| — | **Emergency rule in code**: danger words (English and Roman Urdu) force High priority, the Emergency department and an emergency notice, whatever the AI says |
| — | **Low AI confidence** (< 0.6) goes to the Patient Relations triage desk for a person to route |
| — | **Gemini down or invalid**: keyword rules route it, flagged for review, so a complaint is never lost |
| Duplicate check by query | Same, plus a **database unique constraint**, so two identical submissions at once can't both save |
| In-memory rate limit, 10/min | Same limit, per IP |
| Slack high-priority alert | Department alert email, tagged `[HIGH]` or `[EMERGENCY]` |
| — | `spoken_message` in every answer, phrased to be read aloud (voice agent, text-to-speech) |

## API

Base URL: your Vercel deployment. Every response is JSON, with `cache-control: no-store` and an `x-request-id` header. Errors look like `{ "success": false, "error_code": "...", "error": "..." }`.

Browsers may call these endpoints only from origins listed in `ALLOWED_ORIGINS`. Each IP is limited to 10 requests per minute (`429` with `Retry-After`).

### `POST /api/complaints`

Files a complaint. Field names are case-insensitive.

```json
{
  "name": "Test Patient",
  "email": "patient@example.test",
  "phone": "+92 300 1234567",
  "details": "The pharmacy gave me the wrong medicine, the label had another patient's name.",
  "type": "Pharmacy",
  "priority": "Medium",
  "channel": "web"
}
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | up to 100 characters |
| `email` | yes | valid email |
| `phone` | yes | 7–20 digits, spaces, dashes, optional `+` |
| `details` | yes | 10–4000 characters |
| `type` | no | the patient's category guess, kept as a hint |
| `priority` | no | `High`, `Medium` or `Low`, kept as a hint |
| `channel` | no | `web` (default) or `voice` |

`201 Created`:

```json
{
  "success": true,
  "message": "Your complaint has been submitted. Your complaint code is CMP-6TFQNX",
  "complaint_code": "CMP-6TFQNX",
  "priority": "High",
  "department": "pharmacy",
  "department_name": "Pharmacy",
  "expected_response_hours": 24,
  "needs_review": false,
  "emergency": false,
  "emergency_notice": null,
  "spoken_message": "Your complaint has been submitted and sent to Pharmacy. Your complaint code is C M P, 6 T F Q N X. They aim to respond within 24 hours."
}
```

When `emergency` is `true`, show `emergency_notice` prominently. It is also the first sentence of `spoken_message`.

Other responses:
- `400 VALIDATION_ERROR`: names the field, never echoes the value
- `409 DUPLICATE_COMPLAINT`: the same email already filed the same text
- `403`, `405`, `413`, `415`, `429`
- `503 SERVER_ERROR`: the database is unreachable

### `POST /api/complaint-status`

```json
{ "complaint_code": "CMP-6TFQNX", "email": "patient@example.test" }
```

Send `phone` instead of `email` if you prefer.
- **`200`:** `{ success, complaint_code, status, priority, department_name, submitted_at, spoken_message }`
- **`404`:** the same answer for an unknown code and a wrong contact, so codes can't be probed.

### `GET /api/complaints-summary` (admin)

Requires the `x-admin-key: <ADMIN_API_KEY>` header. It returns patient data, so never call it from a public page. The response has the same shape as the n8n summary node:
- `summary`: `total`, `pending`, `resolved`, `lowPriority`, `mediumPriority`, `highPriority`, `needsReview`, `emergency`, `byCategory`, `byDepartment`
- `data`, `timestamp`, `recordCount`

### `GET /api/health`

`{ status, data_source, ai_triage: "gemini" | "keywords_only", email: "smtp" | "log", time }`. It never shows a secret.

## Departments

| Code | Department | Target response |
|---|---|---|
| `emergency` | Emergency Department | 1 h |
| `clinical_care` | Doctor & Clinical Care | 24 h |
| `nursing` | Nursing & Ward Care | 24 h |
| `pharmacy` | Pharmacy | 24 h |
| `laboratory` | Laboratory & Diagnostics | 48 h |
| `appointments` | Appointments & Scheduling | 48 h |
| `billing` | Billing & Insurance | 72 h |
| `facilities` | Facilities & Cleanliness | 72 h |
| `patient_relations` | Patient Relations (triage desk) | 48 h |

## Setup

1. **Database (Supabase):** run [`db/001_complaints.sql`](db/001_complaints.sql) in the SQL editor. It's idempotent, and [`db/001_rollback.sql`](db/001_rollback.sql) undoes it. RLS is on with no policies, so only the service-role key used by these functions can read or write.
2. **Vercel:** import the repository with **Root Directory = `serverless`**, then add the environment variables below.
3. **Check:** `GET /api/health` should show `data_source: "supabase"` and `ai_triage: "gemini"`.

| Variable | Needed | Purpose |
|---|---|---|
| `DATA_SOURCE` | yes in production | `supabase`, or `demo` for in-memory synthetic data |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | with `supabase` | server only, never sent to a browser |
| `GEMINI_API_KEY` | recommended | AI triage. Without it, keyword rules triage everything and flag it for review. |
| `GEMINI_MODEL` | no | default `gemini-3.6-flash` |
| `SMTP_USER`, `SMTP_APP_PASSWORD`, `MAIL_FROM` | no | Gmail SMTP. Without them, emails are logged instead of sent. |
| `ALLOWED_ORIGINS` | for a browser frontend | comma-separated origins, such as your demo page |
| `ADMIN_API_KEY` | for the summary | the summary endpoint is off without it |
| `ALERT_EMAIL_OVERRIDE` | no | demo setting: every department alert goes to this inbox |

## Tests

```bash
npm ci
npm test                 # 89 tests, plus 7 migration tests when TEST_DATABASE_URL is set
npm run typecheck
npm run eval:triage      # offline triage evaluation (no AI)
```

CI runs the type check, all 96 tests (the migration tests against a Postgres 16 service), the offline evaluation and `npm audit` on every pull request.

## Triage evaluation

[`evals/triage/dataset.json`](evals/triage/dataset.json) holds 50 synthetic complaints, each labelled with the department that must act and the priority a triage nurse would give. It includes emergencies, Roman Urdu, mixed problems, praise, a prompt-injection attempt, and a billing complaint that mentions a past symptom.

**Without AI** (keyword rules plus the emergency rule; recorded, with a regression floor in CI):

| Metric | Result |
|---|---|
| Department correct | 44/50 (88%) |
| Priority correct | 37/50 (74%) |
| Both correct | 36/50 (72%) |
| Emergencies caught | 6/6 (100%) |
| False emergency alarms | 1 (C39: a billing complaint mentioning a past chest pain) |
| Sent to human review | 50/50 (every keyword-only decision) |

**With Gemini:** `npm run eval:triage:live` (needs `GEMINI_API_KEY`), or the manual *Triage live evaluation* workflow. Results will be recorded here after the first run.

**Limits:**
- The keyword rules were written before this set and **not tuned to it**, so the offline score is honest but modest.
- The emergency rule is deliberately broad, so it flags past symptoms too (C39). A false alarm costs a person a minute; a missed emergency could cost much more.
- The set is small and synthetic, and only one person labelled it.
- The rate limit is per warm instance, like the n8n original.
