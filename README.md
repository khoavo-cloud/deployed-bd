# Deployed BD

Reads inbound leads from one Notion database, researches and scores each one, and writes an enriched profile to a second Notion database.

```
Notion: Inbound Leads  →  research + score  →  Notion: Scored Profiles
```

**Score = legit business + relevant AI business + contact holds a real role + usage potential** (0–25 each, 100 total). When the inbound contact is wrong or too junior, the profile lists senior decision makers found during research.

## Setup

Requires Node 20+.

1. **Get access to the Notion integration.** Its token is in the team password store, not in this repo. If you are creating your own, make one at <https://www.notion.so/my-integrations> and share **both** databases with it (`•••` → Connections → your integration). Without that share the API returns 404 even with a valid token — it is the most common setup failure.
2. **Get a Google AI Studio key** from <https://aistudio.google.com/apikey>, on a project with **billing enabled**. Search grounding is not available on the free tier and fails with `429 RESOURCE_EXHAUSTED`.
3. Copy `.env.example` to `.env.local` and fill in the two keys plus both database ids.
4. Install and confirm your credentials reach both databases:

```bash
npm install && npm run discover:notion
```

You should see **Custom: Web Leads** and **BD Profiles**. "No databases visible" means step 1's share is missing.

5. Run it:

```bash
npm run dev     # http://localhost:3210
```

The field mapping in [lib/config.ts](lib/config.ts) already matches these two databases — you only need to touch it if someone renames a property in Notion. `npm run inspect:notion` prints the live schemas to compare against. Any target property that no longer matches is reported after a publish rather than failing the write, so drift is visible instead of silent.

## How it works

- [lib/triage.ts](lib/triage.ts) — offline classification, no API calls. Two thirds of submissions come from consumer mailboxes, so leads are first sorted by whether there is anything to research at all. A consumer address with no company name is marked Unresearchable and skipped rather than burning a full web-search pass to find nothing. `scripts/triage.ts` runs the same rules over a CSV export.
- [lib/notion.ts](lib/notion.ts) — reads leads, writes profiles. Submissions are collapsed to one lead per email. `publishProfile` checks the target database's real schema and sends only properties that exist with a matching type — and returns the ones it had to drop, so schema drift is visible instead of silent.
- [lib/enrich.ts](lib/enrich.ts) — two Gemini calls. The first researches the company with Google Search grounding (in local language as well as English) and writes up findings; the second converts those findings into the scored record via `responseSchema`. Splitting them keeps the scoring honest — it can only score what the research actually turned up — and it is also what makes citations work, since grounding metadata comes back empty when search and structured output are combined in one call. `evidenceUrls` is taken from that metadata rather than from the model's prose, so every URL is one a search really returned.
- [app/page.tsx](app/page.tsx) — pick a lead, review the generated profile and the raw research notes, then write it to Notion.

Nothing is written to Notion until you click **Write to Notion**.

**The inbound database is read-only to this app.** The web form owns it, so nothing is written back — a lead counts as processed when its email already appears in BD Profiles. That also makes the queue self-healing: delete a profile row and the lead returns to the queue.

## Two things worth knowing

**LinkedIn has no API for this and scraping it violates their terms.** Decision makers come from ordinary web search, and each one carries an `evidence` field saying where it was found. A LinkedIn URL appears only when a search result surfaced it directly — the model is instructed not to construct one. Treat an empty decision-maker list as a real answer rather than a failure.

**Research is inference, not fact.** The prompts ask the model to separate what it verified from what it inferred, and the summary carries that distinction through. Read the raw research notes before acting on a high score.

**The Gemini free tier is not private.** On the free tier Google may use prompts and responses, with human review, to improve its models — and these prompts carry lead names, emails, and company details belonging to other people. Linking a billing account is the documented boundary where that stops. Free tier is also Flash-only since April 2026.

## Deploying to Vercel

```bash
npx vercel          # preview
npx vercel --prod   # production
```

Set these in the Vercel project (Settings → Environment Variables), for Production **and** Preview — a preview deployment without them will refuse to serve:

| Variable | |
|---|---|
| `NOTION_TOKEN` | integration token, both databases shared with it |
| `NOTION_SOURCE_DB_ID` | Custom: Web Leads |
| `NOTION_TARGET_DB_ID` | BD Profiles |
| `GOOGLE_API_KEY` | AI Studio, billing enabled — grounding is not on the free tier |
| `BD_USER` / `BD_PASSWORD` | basic auth for the UI — omit if using `AUTH_MODE=vercel` |
| `AUTH_MODE` | set to `vercel` when Vercel Authentication protects the project |

**On a Vercel team, use Vercel Authentication** (Settings → Deployment Protection → All Deployments). It gates access by org identity rather than a shared password, so you can tell who published what. Set `AUTH_MODE=vercel` so [middleware.ts](middleware.ts) stands down — Deployment Protection runs before middleware, and leaving both on means signing in twice. Protecting the *production* domain needs Pro or Enterprise; on Hobby, Standard Protection covers preview URLs only and production stays public.

**Auth is not optional.** The UI lists every lead's name, email and company, and `/api/enrich` and `/api/publish` spend money and write to Notion with no rate limiting. [middleware.ts](middleware.ts) returns 500 rather than serving if `BD_PASSWORD` is missing, so a forgotten variable fails closed instead of publishing the queue.

**`/api/enrich` needs a Pro plan.** Research takes 16–96s per lead and `maxDuration` is set to 300s in [vercel.json](vercel.json). Hobby caps functions at 60s, so slower leads will time out mid-research. On Hobby, use the batch script locally instead and treat the deployment as read-only review.

The batch scripts in `scripts/` are CLI tools and don't run on Vercel — they read `.env.local` directly. Run them from a machine that has it.
