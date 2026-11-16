# Pestr - Invoice Chaser

**Chase late invoices with your own Claude. No AI inside the app.**

Tell Claude about an overdue invoice. Claude writes a polite-to-firm sequence of follow-up emails, tailored to the client. Pestr saves them as a chase plan you can edit, track and share through a live status page.

> Pestr contains no AI models and no AI API keys. Claude does the thinking and writing, using the customer's own Claude subscription. The app only saves, edits and serves the result.

## How it works

1. You connect Claude to Pestr using a private MCP link.
2. You type something like: *"Acme Co is 21 days late on invoice #104 for $3,200. Set up a chase plan."*
3. Claude writes the emails and calls Pestr's tools to save them.
4. You open Pestr, review and edit every message and date, and mark the invoice paid when it clears.
5. Your client can open a public status page that always shows the current state.

## Features

- Chase plans with a multi-step email sequence (friendly, firm, final)
- Edit any subject, message or send date in the web app
- Mark invoices paid or reopen them
- Public, read-only status page per invoice (shows no email text)
- Email and password accounts, each with its own private MCP link
- Light and dark mode, mobile friendly

## MCP tools

| Tool | What it does |
|---|---|
| `create_chase_plan` | Saves a plan and the emails Claude wrote, and returns an edit link |
| `list_plans` | Lists plans, filtered by open, paid or all |
| `get_plan` | Returns one plan with all its messages |
| `update_message` | Changes the subject, body or date of one message |
| `mark_paid` | Marks an invoice paid and stops the chase |

Every tool only reads and writes data. None of them calls an AI service.

## Tech

- Cloudflare Workers, written in TypeScript with [Hono](https://hono.dev)
- Cloudflare D1 (SQLite) for storage
- MCP over Streamable HTTP, implemented directly (stateless, JSON responses), so there are no runtime dependencies besides Hono
- Server-rendered HTML, with no front-end build step
- One file: `src/index.ts`

## Run it locally

```bash
npm install
cp .dev.vars.example .dev.vars   # local secrets
npm run db:local                 # create the local D1 tables
npm run dev
```

Open http://localhost:8787. With `DEMO_PASSWORD` set in `.dev.vars`, a demo account is created automatically:

- Email: `demo@pestr.app`
- Password: whatever you set as `DEMO_PASSWORD` (`demo1234` in the example file)

## Deploy to Cloudflare

D1 and Workers both have free tiers, so there is no paid plan or persistent disk to buy.

```bash
npm install
npx wrangler login

# 1. Create the database, then paste the printed database_id into wrangler.jsonc
npx wrangler d1 create pestr

# 2. Create the tables in the remote database
npm run db:remote

# 3. Set the session-signing secret (use a long random string)
npx wrangler secret put SECRET_KEY

# 4. Deploy
npm run deploy
```

Wrangler prints your address (for example `https://pestr.<your-subdomain>.workers.dev`). There is no second deploy step: Pestr builds its links from the address each request arrives on. To use a custom domain, add it in the Cloudflare dashboard under the Worker's **Settings, then Domains & Routes**.

### Settings

| Name | Type | Purpose |
|---|---|---|
| `SECRET_KEY` | Secret (required) | Signs login sessions. The Worker refuses to run without it. |
| `DEMO_PASSWORD` | Secret (optional) | If set, creates the `demo@pestr.app` account with this password. Leave it unset in production. |
| `BASE_URL` | Variable (optional) | Public address, no trailing slash. Only needed to force a specific address in the links Claude returns. |
| `DB` | D1 binding | The database. Configured in `wrangler.jsonc`. |

## Connect to Claude

1. Log in to Pestr and open **Connect Claude**. Copy your private link.
2. In Claude, go to **Settings, then Connectors, then Add custom connector**.
3. Paste the link and save.
4. Start a new chat and describe an overdue invoice.
5. Open Pestr. The plan is there to edit.

## Moving from the Render version

The Render version stored data in a SQLite file. Accounts do not carry over, because password hashing was changed to fit Workers' limit of 100,000 PBKDF2 iterations (the old version used 200,000). Create a new account and a new MCP link. If you need old plans, export them from the old `pestr.db` and import the rows into D1 with `wrangler d1 execute`.

## Security notes

- The MCP link contains a secret token. Anyone who has it can read and write that account's plans, so treat it like a password.
- This is a first version. A proper OAuth sign-in flow is the next step so no secret lives in a link.
- Passwords are hashed with PBKDF2-SHA256 (100,000 iterations). Sessions are signed, HttpOnly cookies.
- There is no email sending yet: Pestr stores the messages and dates, and you send them.

## Roadmap

- OAuth sign-in for the MCP connection
- Sending the scheduled emails from the app (a Cron Trigger plus Cloudflare Email Service fits well here)
- Reminders when a send date arrives

## Proof there is no AI inside

Search the code for AI providers or keys. It finds nothing:

```bash
grep -i -E "openai|anthropic|api_key" src/index.ts
```
