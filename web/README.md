# MediLens website

**Live: [medilens-web-theta.vercel.app](https://medilens-web-theta.vercel.app)** (voice calls need a demo code, available on request).

The patient- and staff-facing site for the MediLens API (`../serverless`). It uses the original MediLens look: teal, Playfair Display headings and Poppins body text.

| Page | Hash | What it does |
| --- | --- | --- |
| Voice Agent | `#/` | "Tap to call agent" browser call to the Retell agent: live transcript, mute, and a summary of what was booked or filed when the call ends |
| Complaint Center | `#/complaints` | Type or **speak** a complaint (recorded, then transcribed by Gemini, then editable). The answer shows the AI-chosen department, priority and response time, and can be read aloud. Emergencies show the 1122 notice first |
| Track | `#/status` | Status by complaint code plus the email or phone that was used |
| Staff Desk | `#/staff` | KPIs, the complaints table, confirming or correcting the AI's department, priority and status, and live AI accuracy with recent corrections |

No secrets live in the site. The Retell and Gemini keys stay on the API. Staff type the `ADMIN_API_KEY`, and it is kept only in that browser tab (sessionStorage).

## Run it

```bash
npm ci
npm run dev        # http://localhost:5173, talks to VITE_API_URL
npm test           # 33 tests (Vitest + Testing Library)
npm run build
```

`VITE_API_URL` defaults to `https://medilens-api.vercel.app`. The site's origin has to be listed in the API's `ALLOWED_ORIGINS`, otherwise the browser blocks the calls.

## Deploy (Vercel)

Create a project from this repo with **Root Directory `web`**. The framework is Vite, which Vercel detects. Optionally set `VITE_API_URL`.
