# Pestr: new features (tiered by difficulty)

I could not read the shared chat link (the page is rendered by JavaScript and returned no text), so this is built from your six project files. Everything was typechecked with `tsc` and run against a local Worker + D1: all 8 new MCP tools, every new page, CSV export, link rotation, and a `javascript:` payment link being rejected.

**Files:** `index.ts` (replaces yours), `migrations/0002_features.sql` (new), `wrangler.jsonc` (adds a cron trigger and a `FROM_EMAIL` var; keep your own `database_id`).

## Upgrade steps

```bash
# put 0002_features.sql in your migrations/ folder next to 0001_init.sql
npm run db:local     # try it locally
npm run db:remote    # then production
npm run deploy
```

Existing plans and accounts keep working. You do not need to reconnect Claude, but start a new chat so it sees the new tools.

---

## Tier 1: easy, big everyday value

| # | Feature | Where it lives |
|---|---|---|
| 1 | **Dashboard totals and filters**: outstanding amount per currency, overdue count, tabs for all / open / overdue / paid, "N days late" on each row | `dashboardPage`, `GET /?show=overdue` |
| 2 | **Mark as sent, Copy text, Open in mail app** on every email. Pestr does not send mail yet, so this covers the step between "Claude wrote it" and "client got it" | `msgCard`, `POST /plans/:id/messages/:step/sent` |
| 3 | **Stop the chase when paid**: marking paid cancels scheduled emails; reopening restores them | `setPaid()` |
| 4 | **Rotate MCP link**: one button if the link leaks; the old link stops working immediately | `POST /connect/rotate` |
| 5 | **CSV export**, with spreadsheet-formula protection (cells starting with `=`, `+`, `-`, `@` are neutralised) | `GET /export.csv`, `csvCell()` |
| 6 | **Pay-now link** per invoice, shown on the client's status page. Only `http(s)` links are stored, so a `javascript:` link can never reach an `href` | `safeUrl()`, `publicPage` |

## Tier 2: medium, makes Claude smarter without any AI inside the app

| # | Feature | MCP tool |
|---|---|---|
| 7 | **Business profile**: business name, sign-off and payment instructions in Settings. Claude reads it before writing, so every email is signed and says how to pay | `get_profile`, `set_profile` |
| 8 | **"What should I send today?"** Scheduled emails that have come due on open invoices | `get_due_messages` |
| 9 | **Partial payments**: record any amount; when the total covers the invoice it flips to paid by itself; balance shows on the dashboard and status page | `record_payment` |
| 10 | **Timeline per plan**: created, sent, payment, paid, plus free notes ("client said Friday") | `log_activity` |
| 11 | **Client memory**: past invoices for a client, average days late when they paid, recent notes. Claude uses it to choose the tone | `get_client_history` |
| 12 | **Late fee calculator**: simple interest plus a flat fee with a grace period. Arithmetic only | `calculate_late_fee` |

The server instructions now tell Claude to call `get_profile` and `get_client_history` before writing a plan, without you asking.

## Tier 3: harder, opt-in

| # | Feature | Notes |
|---|---|---|
| 13 | **Automatic sending** by a daily Cron Trigger | Off by default. A plan is only touched if you tick "email the client automatically" on that plan (Claude cannot switch this on) and it has a client email. Rows are claimed before sending so overlapping runs cannot double-send, and failures are logged on the timeline. |

To enable it:

```bash
npx wrangler secret put RESEND_API_KEY
# set FROM_EMAIL in wrangler.jsonc "vars", e.g. "Acme Billing <billing@yourdomain.com>"
npm run deploy
```

I used Resend because it is one `fetch` call with no dependency; the sending domain has to be verified with them. Replies go to the account owner's email through `reply_to`. Any provider with an HTTP API can replace the `fetch` in `sendDueEmails()`.

---

## Worked examples (what to say to Claude)

1. *"Acme Co is 47 days late on invoice #104 for $3,200. Set up a chase plan."* Claude reads your profile and Acme's history, writes 3 emails, saves them.
2. *"What should I send today?"* calls `get_due_messages`.
3. *"I sent the first Acme email."* calls `mark_message_sent`.
4. *"Acme paid $1,200 today."* calls `record_payment`; balance becomes $2,000 and the plan stays open.
5. *"What late fee could I charge Acme at 12% a year, $25 flat, 7 days grace?"* gives $42.08 interest + $25 = **$3,267.08** (checked in the test run). Check your contract and local law before charging it.

## Not built, and why

- **OAuth for the MCP link**: the right next security step, but a large piece on its own (authorization server, consent screen, token storage).
- **Reminders to you** when a send date arrives: easy on the same cron once you pick a provider; I kept to one external service.
- **Teams / shared plans**: needs a schema change from `user_id` to an organisation model.
- **Login rate limiting and CSRF tokens**: worth adding before real customers. A Cloudflare rate-limiting rule covers `/login` without code.

## Behaviour notes

- Reopening a paid plan reschedules its cancelled emails; any whose date has already passed will show as due straight away.
- Some mail apps cut off very long `mailto:` bodies, which is why Copy text sits next to it.
- Email statuses: `scheduled`, `sent`, `cancelled`, `sending`, `failed`.
