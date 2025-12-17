
Medilens Full Feature Documentation


---

Admin Dashboard Features


---

Feature 1: Complaint Management

Overview:
Automates customer complaint management from submission to resolution, providing real-time visibility for support teams.

Problem:
Manual complaint tracking is messy. Complaints get lost in emails, spreadsheets become outdated, and it’s hard to see status or responsibility. Leads to slow responses, frustrated customers, and low team visibility.

Solution:

Receives complaints from a web form

Adds/updates in a central Google Sheet

Assigns team members

Marks complaints as “solved”

Provides a real-time dashboard view


Workflow Steps:

Step	Action

1	New Complaint Submission → triggers webhook
2	Parse complaint details into structured format
3	Add complaint as new row in “Complaints” sheet
4	Fetch all complaints for dashboard
5	Update “Assignee” when assigned
6	Update “Status” to “Solved”
7	Send confirmation to frontend


Tools Used:

Tool	Purpose

n8n	Workflow automation
Webhook Nodes	Receive complaint data
Google Sheets Nodes	Read/add/update complaints
Code Nodes	Parse/format data
Respond to Webhook	Send confirmation to frontend


Setup / Integration:

1. Import & activate workflow JSON


2. Copy webhook URLs: /complaint?query=submit & /management?query=assign/solve


3. Frontend POST requests for submission, assignment, resolution



Credentials:

Google Sheets API (service account + JSON key)
⚠️ Never expose webhooks publicly


Estimated Monthly Cost:

Google Sheets API → $0

n8n Self-hosted → $0

n8n Cloud → $20+



---


Feature 2: Command Center

Overview

An AI-powered command center that centralizes hospital CRM and ERP operational data, analyzes risks, and generates actionable AI suggestions for admin review and approval—while keeping the dashboard and hospital overview fully updated in real time.


---

Problem

Operational data such as patient risk, doctor workload, bed availability, and appointments is scattered across multiple sources. This leads to reactive decisions, inefficiencies, staff burnout, and compromised patient care.


---

Solution

Aggregates data from multiple Google Sheets into a single system

Uses AI to analyze risks and operational gaps

Generates structured AI suggestions in a central sheet

Sends both AI suggestions and live operational data to the command center

Enables instant admin approval or rejection with real-time system updates



---

Workflow Steps

Step	Action

1	Trigger via Smarter Alert Webhook
2	Retrieve data from 7 connected Google Sheets
3	Merge node consolidates all operational data
4	AI analysis (LangChain + Gemini) generates JSON-based suggestions
5	Code node parses and appends results to “AI Suggestions” sheet
6	Respond to webhook with AI suggestions and aggregated data
7	Admin Approval Webhook updates status and notes across the system



---

Tools Used

Tool	Purpose

n8n	Workflow orchestration
Google Sheets (x7)	Data storage and retrieval
Webhook Nodes	Trigger analysis and approvals
Google Gemini Chat Model	AI risk analysis and insights
LangChain AI Agent	Structured AI output
Merge & Code Nodes	Data consolidation and parsing
Respond to Webhook	Send data and suggestions to dashboard



Setup / Integration

1. Import and activate the workflow JSON in n8n


2. Prepare 7 Google Sheets and share them with the service account


3. Copy Smarter Alert and Admin Approval webhook URLs


4. Trigger workflows via frontend or backend POST requests



Credentials

Google Sheets API (service account + JSON key)

Google Gemini API (API key)
⚠️ Webhooks should be called securely from the backend.


Estimated Monthly Cost

Google Gemini API: $5–$20

Google Sheets API: $0

n8n Self-hosted: $0

n8n Cloud: $20+


✅ Key Outcome

This workflow not only generates AI suggestions but also fetches and synchronizes all operational data, keeping the command center and hospital overview continuously updated in real time.


Patient-Facing Features


---

Feature 3: Lab Reports & Prescription Analyzer

Overview:
Converts medical reports and prescriptions into simple, easy-to-understand explanations.

Problem:
Lab reports and prescriptions are full of confusing terms and numbers; patients feel lost and anxious.

Solution:

Reads reports/prescriptions

Explains each test/medicine in plain language

Highlights normal vs attention-needed items

Sends structured explanation to frontend


Workflow Steps:

Step	Action

1	User uploads image → OCR converts to text
2	Text sent to n8n webhook
3	AI agent analyzes text using medical system prompt
4	Output formatted: summary, detailed explanation, important notes
5	Response sent back to frontend


Tools Used:

Tool	Purpose

n8n	Workflow orchestration
Webhook Node	Receive extracted text
Google Gemini Chat Model	Medical text understanding
LangChain AI Agent	Structured analysis & explanation
Memory Buffer	Optional session continuity
Respond to Webhook	Send response to frontend


Setup / Integration:

1. Import workflow JSON into n8n


2. Activate workflow → copy webhook POST URL


3. Send extracted text + optional sessionId from frontend


4. Display AI response



Credentials:

Google Gemini API (API key)
⚠️ Keep credentials backend-only


Estimated Monthly Cost:

Google Gemini API → $5–$15

n8n Cloud → $20+

OCR → depends on provider



---

Feature 4: RAG Agent with Memory & Complaint Handling

Overview:
AI chatbot providing fact-grounded hospital assistance with session memory and complaint escalation.

Problem:
Normal chatbots hallucinate, forget conversations, and cannot escalate complaints.

Solution:

Answers from hospital knowledge base

Stores full chat history

Detects complaints → escalates to human support


Workflow Steps:

Step	Action

1	Knowledge base → PDFs → embeddings → Supabase Vector Store
2	User sends chat → webhook
3	RAG Agent responds using vector DB & session memory
4	Complaint detection → Google Sheets logs + Gmail alerts
5	Human support notified if needed


Tools Used:

Tool	Purpose

n8n	Workflow orchestration
Google Gemini Chat Model	AI responses
Google Gemini Embeddings	Vector creation
Supabase Vector Store	Knowledge base
Postgres	Chat memory
Google Drive	PDF source
Google Sheets	Complaint logging
Gmail	Complaint alert emails


Setup / Integration:

1. Upload PDFs → run ingestion workflow → Supabase


2. Configure frontend webhook


3. Send chatInput + sessionId


4. Display chatbot response



Credentials:

Google Gemini API

Supabase API + DB URL

Postgres DB

Google Drive OAuth

Google Sheets OAuth

Gmail OAuth


Estimated Monthly Cost:

Google Gemini → $10–$20

Supabase → free–$25

n8n Cloud → $20+



---

Feature 5: Symptom Checker & Triage

Overview:
AI-powered system for analyzing symptoms, selecting specialists, and detecting emergencies.

Problem:
Patients don’t know which doctor to see or how serious their symptoms are; hospitals need fast triage.

Solution:

Accepts text/voice/image input

Selects correct specialist automatically

Provides structured diagnosis & care guidance

Detects emergencies → sends alert emails


Workflow Steps:

Step	Action

1	Frontend sends symptom text → webhook
2	Configure patient email, doctor email, booking URL
3	AI Specialist Selector → chooses 1 specialist
4	Route to corresponding specialist agent
5	Specialist outputs structured JSON → diagnosis, severity, remedies, first aid, lifestyle
6	JSON cleanup & normalization
7	Emergency detection → send email alerts & booking link if needed


Tools Used:

Tool	Purpose

n8n Cloud	Workflow orchestration
Google Gemini	AI reasoning
LangChain Agents	Specialist behavior control
Webhook API	Frontend → backend
Gmail OAuth	Emergency notifications
JavaScript Node	JSON cleanup
Memory Buffer	Session-based context


Setup / Integration:

1. Deploy n8n → import workflow JSON → create webhook


2. Connect frontend → webhook


3. Add Google Gemini API keys


4. Configure Gmail OAuth → set patient/doctor emails


5. Test mild + emergency cases → go live



Estimated Monthly Cost:

AI calls → ~$0.001–$0.003 per user

n8n Cloud → $20–50

Gmail → free


> Example: 1,000 users/month → ~$3–$5 AI cost




---

Feature 6: Webcalling – AI Voice Appointment System

Overview:
Automated AI voice agent for handling appointment calls.

Problem:
Manual appointment calls cause missed calls, double bookings, staff overload, and poor patient experience.

Solution:

Answers calls → transcribes with Retell AI

Extracts patient, doctor, date, intent using Gemini

Checks doctor availability → books/cancels in Calendar

Updates Sheets + sends confirmation email


Workflow Steps:

Step	Action

1	Patient calls → Retell AI
2	Transcript sent to n8n webhook
3	Gemini extracts patient, doctor, date, intent
4	Check availability → update Google Calendar
5	Update Google Sheets + send email confirmation
6	Success response returned to Retell AI


Tools Used:

Tool	Purpose

Retell AI	Voice calling + speech-to-text
n8n	Workflow orchestration
Google Gemini	Intent extraction
Google Calendar API	Appointment scheduling
Google Sheets API	Patient records
Gmail API	Confirmation emails


Setup / Integration:

1. Create Retell AI agent → connect to n8n webhook


2. Import workflow JSON → n8n


3. Add Gemini API key → connect nodes


4. Connect Calendar, Sheets, Gmail via OAuth


5. Test call → verify booking, sheet entry, email



Estimated Monthly Cost:

Retell AI → $0.10–0.30/minute (e.g., 1,000 calls × 2 min ≈ $200–$600)

Google Gemini → $5–$20

n8n Self-hosted → $5–$10 / Cloud → $20+

Google APIs → mostly free

