# Deployed BD

Reads inbound leads from one Notion database, researches and scores each one, and writes an enriched profile to a second Notion database.

```
Notion: Inbound Leads  →  research + score  →  Notion: Scored Profiles
```

**Score = legit business + relevant AI business + contact holds a real role + usage potential** (0–25 each, 100 total). When the inbound contact is wrong or too junior, the profile lists senior decision makers found during research.

## Setup

1. **Create a Notion integration** at <https://www.notion.so/my-integrations> and copy the token.
2. **Share both databases with it** — open each database, `•••` → Connections → your integration. Without this the API returns 404 even with a valid token.
3. Copy `.env.example` to `.env.local` and fill it in.
4. Install and inspect your schemas:

```bash
npm install && npm run inspect:notion
```

5. Edit `SOURCE_FIELDS` and `TARGET_FIELDS` in [lib/config.ts](lib/config.ts) to match the property names that command printed. Any target property you leave out is simply skipped on write — a partial schema won't break the publish.

6. Run it:

```bash
npm run dev
```

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

## Deploying

Any Node host works. On Vercel, note that `/api/enrich` can run for minutes — `maxDuration` is set to 300s, which needs a Pro plan. On Hobby, run enrichment as a batch script instead of through the route.
