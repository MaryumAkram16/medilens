# MediLens serverless backend

TypeScript serverless functions (Vercel) that replace Maryum Akram's MediLens n8n modules. The n8n exports in the repository root stay as the design record.

**What's here:**
- **Complaint management with AI triage and routing**, typed or spoken
- **The Retell voice agent's tools:** doctor availability, booking, rescheduling, cancellation, complaint status, and filing a complaint by voice
- **The browser side of the voice agent:** a "Start call" endpoint, speech-to-text for spoken complaints, and an after-call summary on the page and by email

[How to build the frontend page](#building-the-frontend-page) shows how the pieces fit together.

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

`{ status, data_source, ai_triage, email, voice, web_call, voice_input, time }`. It shows which features are on (`gemini` or `keywords_only`, `smtp` or `log`, `on`, `off` or `on_with_passcode`), and never a secret.

### `POST /api/transcribe`

Turns a recorded complaint into text. The patient then **checks and edits the text** before submitting it to `/api/complaints` with `"channel": "voice"`.

```json
{ "audio_base64": "<base64 of the recording>", "mime_type": "audio/webm;codecs=opus" }
```

- **Accepted types:** `audio/webm`, `audio/ogg`, `audio/mp4`, `audio/mpeg`, `audio/wav`, `audio/aac`. The file's first bytes must match the declared type.
- **Size:** up to 3 MB of audio, which is a few minutes of Opus.
- **Limit:** 5 recordings per minute per IP.
- **`200`:** `{ success, transcript, language: "english" | "urdu" | "mixed" | "other" }`. Urdu speech is written in Roman Urdu, so the triage keywords still match.
- **Errors:** `422 NO_SPEECH`, `502 TRANSCRIBE_FAILED`, and `503` when no Gemini key is set (ask the patient to type instead).
- **Privacy:** the audio is sent to Gemini once and discarded. It is never stored or logged.

### `POST /api/create-web-call`

Starts a browser voice call with your Retell agent (`RETELL_AGENT_ID`). The body is `{}`, or `{ "passcode": "..." }` when `WEB_CALL_PASSCODE` is set.

- **`201`:** `{ success, call_id, access_token, summary_token }`
  - Pass `access_token` to the Retell web client to join the call. It is short-lived, and the API key never leaves the server.
  - Keep `call_id` and `summary_token` for the after-call summary.
- **Limits, because calls cost Retell minutes:**
  - 3 calls per IP per 10 minutes, and 30 per hour overall (`WEB_CALL_MAX_PER_IP`, `WEB_CALL_MAX_PER_HOUR`)
  - wrong passcodes limited to 10 per 10 minutes
- **Errors:** `401 PASSCODE_REQUIRED`, `429`, `502` (Retell failed), `503` (not configured)

### `GET /api/call-summary?call_id=…&token=…`

What the call did, for the page to show once it ends. Only the `summary_token` from `create-web-call` opens it, so call ids can't be used to browse other people's calls.

```json
{
  "success": true,
  "call_id": "call_…",
  "actions": [{ "action": "booked", "reference": "APT-7K2QXM", "text": "Booked APT-7K2QXM with Dr. Sara Malik (Cardiology) on 2026-11-24 at 10:00." }],
  "text": "• Booked APT-7K2QXM with …"
}
```

### `POST /api/retell-webhook`

Set this as the agent's webhook URL in Retell. It verifies Retell's signature. When a call ends, it emails the summary to the address given during the call, **once per call**, even if Retell sends the event twice. The transcript in the event is not stored.

## Voice agent tools (Retell)

Each tool is a Retell **custom function** that POSTs `{ name, call, args }` here. Every request must carry a valid `x-retell-signature`, checked with `RETELL_API_KEY` over the exact body. Signatures older than five minutes are refused, so a captured request can't be replayed. The n8n flow only checked that the header existed.

Every answer is JSON with `success` and a `message` written for the agent to **say**. A taken slot, a wrong code or a missing detail returns `200` with `success: false` and a sentence the agent can use to recover. Only a bad signature (`401`), too many requests in one call (`429`, 30 per minute) or an outage (`503`) are errors.

| Retell tool | URL | `args` |
|---|---|---|
| `doctor_availibility` | `/api/doctor-availability` | `department` (spoken is fine: "heart", "bachon ka doctor"), optional `date` YYYY-MM-DD |
| `book_appointment` | `/api/book-appointment` | `name`, `phone_no`, optional `email`, `schedule_id` (from availability) |
| `appointment_check` | `/api/appointment-check` | `appointment_id`, `phone_no` |
| `check_slot` | `/api/confirm-reschedule` | `appointment_id`, `phone_no`, and `schedule_id` **or** `appointment_date` + `slot_start_time` |
| `cancel-appointment-` | `/api/cancel-status` | `appointment_id`, `phone_no` |
| `confirm_cancellation` | `/api/confirm-cancellation` | `appointment_id`, `phone_no` |
| `complaint_check` | `/api/complaint-check` | `complaint_id`, plus `phone_no` or `email` |
| `submit_complaint` (new) | `/api/submit-complaint` | `name`, `phone_no`, `details`, optional `email` |

`submit_complaint` runs the same AI triage as the web form, and the agent reads back the department and the complaint code. If the caller describes an emergency, the reply **starts with the emergency notice**. Email is optional by voice, because spelling an email over the phone is unreliable. Duplicates are then detected by phone number.

**Changes to make in the Retell agent:**
1. Point each tool's URL at your deployment.
2. Add a `phone_no` parameter to the check, cancel and reschedule tools. On phone calls the caller's number is used automatically if the agent doesn't collect one.
3. Add the `submit_complaint` tool.
4. Set the agent's **webhook URL** to `/api/retell-webhook`, for the after-call email.
5. Appointment IDs are now codes like `APT-7K2QXM`, and the agent reads them back letter by letter. Callers can say them with or without spaces.
6. In Retell's settings for this agent, turn off storing recordings, since this is a demo with synthetic data.

## Building the frontend page

The page you build (like Lumina's) talks only to these endpoints. It never holds a key.

**Voice agent (talk to MediLens):**
1. "Start call" → `POST /api/create-web-call`. Ask for the demo code first if you set one.
2. Join with the [Retell web client](https://docs.retellai.com/), using `access_token`. The caller hears the agent, and the client gives you the live transcript to show as text.
3. When the call ends → `GET /api/call-summary?call_id=…&token=<summary_token>`, and show `text` or `actions` as the written summary.

**Complaint form (typed or spoken):**
1. **Typed:** `POST /api/complaints`.
2. **Spoken:** record with the browser's `MediaRecorder` (ask for microphone consent and say the audio isn't stored) → `POST /api/transcribe` → put `transcript` in the text box for the patient to check and edit → `POST /api/complaints` with `"channel": "voice"`.
3. **Show the answer:** `message`, `department_name` and `expected_response_hours`. If `emergency_notice` is set, show it first and prominently.
4. **Read it aloud:** speak `spoken_message` with the browser's `speechSynthesis`. It's free, with no extra key.

**Status lookup:** `POST /api/complaint-status` with the code plus the email or phone used.

Add your page's address to `ALLOWED_ORIGINS`, or the browser will be refused.

### What changed from the n8n booking workflow

| n8n | Here |
|---|---|
| Booking set a slot to `Booked` without checking it was free, so two callers could get the same slot | Booking is one database function, and **a unique index allows one active booking per slot**. Tested with two simultaneous bookings against real Postgres. |
| Appointment ID = the slot number, and cancel/reschedule checked only that number | Appointments get their own code (`APT-XXXXXX`), and **every lookup or change also needs the phone number**. A wrong phone and an unknown code get the same answer. |
| Reschedule's "free old slot" query was inverted, so the old slot was never released | Reschedule is one update: the old slot is freed in the same step |
| `booked` vs `Booked`, so cancelled slots stayed unbookable | No slot status to keep in sync: a slot is free when it has no active booking |
| "Next slot" used `time >= X AND date >= Y`, which skipped earlier times on later days | The next opening is ordered by date, then time |
| The new slot was found by date and time only, so it could be another doctor's | Same specialty only, preferring the same doctor |
| Retell retries could book twice | A retried call (same `call_id`) gets the original booking back |
| — | Past and blocked slots are refused. "Today" is Pakistan time. |

Demo doctors and specialties are synthetic, and slots are topped up for the next 14 days automatically (09:00–13:00, Monday to Saturday).

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

1. **Database (Supabase):** run [`db/001_complaints.sql`](db/001_complaints.sql), [`db/002_appointments.sql`](db/002_appointments.sql) and [`db/003_voice.sql`](db/003_voice.sql), in that order, in the SQL editor. Each is idempotent and has a rollback file. RLS is on with no policies, so only the service-role key used by these functions can read or write.
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
| `RETELL_API_KEY` | for the voice tools | verifies Retell's signatures and starts web calls. The voice endpoints are off without it. |
| `RETELL_AGENT_ID` | for "Start call" | the agent browser calls connect to |
| `WEB_CALL_PASSCODE` | no | visitors must enter this code to start a call |
| `WEB_CALL_MAX_PER_IP`, `WEB_CALL_MAX_PER_HOUR` | no | call caps, default 3 per IP per 10 minutes and 30 per hour |
| `SUMMARY_SECRET` | no | signs summary links. It defaults to a key derived from `RETELL_API_KEY`. |

## Tests

```bash
npm ci
npm test                 # 178 tests, plus 21 database tests when TEST_DATABASE_URL is set
npm run typecheck
npm run eval:triage      # offline triage evaluation (no AI)
```

CI runs the type check, all 199 tests (the database tests against a Postgres 16 service, including a two-connection double-booking race), the offline evaluation and `npm audit` on every pull request.

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
