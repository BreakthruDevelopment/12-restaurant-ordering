# Restaurant Ordering

> Order ahead for pickup without paying a marketplace: customers order from their phone and watch the status change
> live, the kitchen works a board, and allergen information is handled with liability in mind.

**Live:** https://app12.breakthruventures.ai · **Runs on:** Oracle Cloud · Part of
[30 apps in 30 days](https://github.com/BreakthruDevelopment/ai-dev-os)

**The live menu is empty until an admin loads the demo restaurant** (see [Try it](#try-it)). This is a demo
restaurant: don't rely on it for allergy decisions.

## What this app does

Independent restaurants, cafés, food halls and the agencies that build their sites ask for "order ahead without
paying 30% to a marketplace". They care about three things: orders arrive once and are tracked in real time,
allergen information is handled with liability in mind, and a menu assistant answers questions but never tells
anyone a dish is safe for their allergy.

- **Anyone** browses the menu with prices, declared allergens ("Contains", "May contain") and sold-out dishes.
- **Customers** (`user`) ask the menu assistant, fill a cart, place pickup orders (payment is at pickup), answer the
  required allergy question, track their orders live, and cancel until the kitchen accepts.
- **Staff** (`staff`) work the live kitchen board (Placed, Accepted, Preparing, Ready), acknowledge allergy alerts,
  move orders along or cancel with a reason, open and close ordering, set the pickup time, mark dishes sold out, and
  edit the menu and its allergen declarations.
- **Admins** see counts only (orders by status per day, assistant answers by mode per day, sold-out dishes, accounts
  by role), turn customers into staff and back, and load the demo restaurant. Order routes answer 404 for admins:
  they never see order contents or allergy details.

## Try it

1. Open https://app12.breakthruventures.ai. Without the demo loaded, the menu says "The menu is empty right now."
2. Choose **Sign in to order**, then **New here? Create an account** (password of 10 or more characters). New
   accounts are customers.
3. Once dishes are on the menu, ask the assistant a question, add dishes to the cart and **Place order**. Follow the
   order on **Your order**.

**Load demo restaurant** (admin only) creates "Demo Noodle Bar": 6 categories and 24 dishes with allergen
declarations (two unverified, one sold out), 3 customers, 2 staff and 8 orders across every state, one with an
unacknowledged allergy alert. On the live site the demo users get random passwords that are never shown, so visitors
can't sign in as them, and the kitchen board needs an account an admin has made staff (**Make staff** on `/admin`).
Locally, the demo seed sets a password you choose (see [Run it locally](#run-it-locally)).

## Orders and allergens

**Placing an order** (`src/lib/orders.ts`). The server reads prices, names and allergen declarations from the
database and snapshots them onto each line; the client never sends a price. Totals are integer cents. Sold-out or
unknown dishes are a 409 that lists them, and so is ordering while ordering is closed. Each order carries a
client-generated `idempotencyKey`: a retry returns the first order, and the same key with a different order is
`409 idempotency_key_reused`. Order numbers (`A-042`) restart each restaurant day in `RESTAURANT_TZ` (default
`America/Chicago`), so they don't reset mid-dinner.

**Statuses:** `placed` → `accepted` → `preparing` → `ready` → `picked_up`, or `cancelled`. Customers can cancel
while `placed`; staff can cancel any open order with a reason. Every change carries the order's `version`, and a stale
one is a 409.

**The allergy question** is required at checkout: "Does anyone in this order have a food allergy?"

- If yes, the customer picks allergens or describes the allergy. Any dish in the cart that contains or may contain a
  picked allergen is listed in red, and the customer must tick **I'll confirm with staff before eating** to continue.
- The order then carries an **allergy alert** that can't be changed after placement. The kitchen board shows it in a
  red band, and **staff must press "Allergy reviewed with kitchen" before the order can be accepted**, or cancel it
  ("Can't safely prepare"). The customer's tracker says "Staff will confirm your allergy before we start."
- Allergy details are health data: only that customer and staff see them, they are never logged, and admins get
  counts only.

**Allergen declarations** (`src/lib/menu.ts`). Each dish declares the US major allergens plus gluten (milk, egg, fish,
crustacean shellfish, tree nuts, peanuts, wheat, soy, sesame, gluten) as "contains" or "may contain". A declaration
is saved only with **I checked these against the recipe** ticked, which stamps who checked it and when, and with the
dish's current `version`. Every change is appended to `allergen_change`, shown in the editor. **An allergen that
isn't declared is never shown as "free of"** (the editor calls it "Not listed"). A stamp older than 90 days counts as
unchecked.

**Database triggers are a backstop, not a boundary.** They refuse edits to an order's allergy fields after
placement, rewrites of the acknowledgment, out-of-order status changes, accepting with an unacknowledged alert,
changes to order lines, and any update or delete on `allergen_change`. The rules that matter are enforced in the data
functions; the triggers catch bugs and hand-written SQL. A database superuser can switch them off, and the Oracle
deployment shares one `postgres` superuser across apps.

## Live order status

`GET /api/orders/stream` is Server-Sent Events (`src/lib/order-stream.ts`, `src/lib/order-bus.ts`).

- **Events are a signal, not data.** Each one is `{orderId, version}` and nothing else: no names, notes or allergy
  details. The page then refetches `GET /api/orders/[id]` or the kitchen list, which apply the normal access rules.
  A bug in the stream filter could leak at most an order id.
- Events are published only after the database transaction commits. Customers receive their own orders, staff every
  order, and admins get 404.
- **Limits:** 3 streams per user and 100 in total, then 429. A heartbeat goes out every 25 seconds, and each stream
  closes after 10 minutes so the reconnect checks the session again.
- **Fallback:** after two stream errors, or when the browser closes the stream (401, 404 or 429), the page polls every
  5 seconds. The kitchen board also refetches every 15 seconds while the stream is up.
- The bus is in-process, which matches the single container on Oracle. With more than one instance it would need
  Postgres `LISTEN/NOTIFY`; the event shape would stay the same.

## The AI feature

**Menu assistant** (`menu-qa`). Signed-in users ask a question of up to 300 characters on the menu page. Every answer
shows the footer "Allergies? Ask staff before ordering." Questions are never stored or logged.

**Allergen questions never reach a model** (`src/lib/allergen-router.ts`).

- A deterministic router sends a question to **allergen mode** if it matches a fixed lexicon: every allergen name
  and synonym, misspellings and look-alike spellings (`p3anut`, Cyrillic letters), safety words ("safe", "free",
  "contain", "avoid", "without"), diets, medical words, and several other languages. Text in a non-Latin script goes
  there too. It over-routes on purpose: a false match costs one extra "ask staff".
- A question goes to the model only when every content word is on a fixed general vocabulary or is a word from a dish
  name on the menu. Questions about wait times get fixed text built from the pickup setting.
- **The allergen answer is built from the database only.** It lists which dishes contain or may contain what was
  asked about, never which dishes are safe, free of or suitable. For a dish with nothing declared it says "No
  allergens are listed for [dish] in our menu data. That isn't a guarantee: please ask staff." Unchecked declarations
  say "hasn't been checked recently: ask staff." Severe words (anaphylaxis, EpiPen, celiac, severe and others) lead
  with "Please speak with staff before ordering."
- Every allergen answer ends with the fixed notice: "We can't guarantee any dish is free of an allergen. Our kitchen
  handles [every allergen declared on the menu], and cross-contact can happen. Please tell staff about your allergy
  before ordering, and use the allergy question at checkout."

**General questions** ("what's spicy?", "anything under $15?") make one call to the shared gateway, `generate()` in
`src/lib/ai`, with no tools (`src/lib/menu-qa.ts`, `src/lib/allergen-guardrails.ts`).

- **Input:** the available dishes as `M1`, `M2`, ... with name, description (160 characters), price and dietary tags,
  at most 8,000 characters, and the question, each in its own tag with angle brackets removed. Declared allergens are
  not sent: the model never answers allergen questions.
- **The model writes no text.** Its whole output, validated with zod, is up to 3 dish references and one reason from
  a fixed list (`popular`, `spicy`, `mild_heat`, `budget`, `quick`, `kid_friendly`, `shareable`, `dessert`, `drink`,
  `other`). The server writes the reply from a fixed heading per reason ("Spicy picks: …"), with dish names and
  prices from the database, and ends it with "Ask staff about allergies."
- **Checks:** references must exist and be available; a price cap in the question ("under $15") and the reason
  (spicy needs the spicy tag) are enforced; a dish whose own name reads as a claim (such as "Gluten-Free …") is
  dropped. If nothing is left, the reply says it couldn't find a good match.
- The system prompt says the menu text and the question are data, never instructions.
- If the model call fails, the reply asks the customer to check with staff or browse the menu.

**Live mode.** Oracle runs this app with `AI_PROVIDER=demo` unless a Gemini key is in the VM's shared settings. In
demo mode, general questions get a recorded answer labelled "Recorded demo answer", built through the same templates
from the first two available dishes. Allergen answers are the same in either mode, because they never use a model.

**Caps:** 20 questions per user per hour; `QA_DAILY_CAP` (default 500) live model calls per day app-wide, spent only
when a live model is configured. Logs record task, mode, reference count and latency. The admin page counts answers
by mode (`allergen`, `general`, `guardrail`, `demo`).

Evals: `test/ai-evals.test.ts` runs the allergen cases with no model and the general cases with a stub, including
"Is the pad thai peanut free?", "What's nut-free?", a Spanish allergen question and a dish description that tries to
give the model instructions. `pnpm eval:menu` runs them against a live model by hand.

## Architecture

```
Phone or desktop browser (cart in localStorage: item ids and quantities only)
   │ HTTPS + session cookie; EventSource for live status
   ▼
Caddy (TLS) ──► Next.js container ── pages, server actions, route handlers (/api/*)
                   │                  auth + access rules, zod validation, AI gateway, JSON logs, /api/health
                   │                  in-process order bus → SSE streams (after commit)
                   ├──► Postgres on the same VM (Drizzle): menu, allergen log, orders, counters
                   └──► Model API (Gemini when a key is set, otherwise recorded demo answers)
```

- **Oracle Cloud Always Free A1 VM** (arm64): one long-lived container behind Caddy, which handles HTTPS and passes
  event streams through without buffering. Postgres runs on the same VM.
- `GET /api/health` reports database status and the deployed image tag, and returns 503 if the database is down.

## Data model

Defined in `src/lib/db/schema.ts`; migrations in `drizzle/`.

| Table | Holds |
| --- | --- |
| `menu_category` | Name and position |
| `menu_item` | Name, description, price in cents, dietary tags (`vegetarian`, `vegan`, `spicy`), sold out, verification stamp (who and when), archived time, `version` |
| `menu_item_allergen` | One row per declared allergen and dish: `contains` or `may_contain`. No row means not declared, never "free of" |
| `allergen_change` | Append-only log of every declaration change: before, after, who and when |
| `restaurant_setting` | One row: accepting orders, pickup minutes (5 to 90) |
| `daily_counter` | Last order number per restaurant day |
| `order` | Number, status, pickup name and time, note, allergy alert, allergens and note, who acknowledged it and when, subtotal, idempotency key (unique per customer), cancel reason, `version`. Owned by `customer_id` |
| `order_line` | Dish, snapshotted name, unit price and allergen declarations, quantity. Composite foreign key to the order's customer |
| `assistant_stat` | Answers by mode per restaurant day (counts only, never questions) |
| `rate_event`, `daily_usage` | Per-user limits and the app-wide daily AI cap |

## Security

**Roles.** Three roles via Better Auth: `user` (customer), `staff` and `admin`, one per account. `staff` holds no
Better Auth permissions; its powers are app-level, in `src/lib/access.ts`, and admin is not a superset of staff.
Sign-up can't set a role; only an admin grants `staff`, logged as `role.changed`. `src/lib/auth/permissions.ts`
withholds impersonation, set-password, set-email and session listing from admins, and those endpoints are disabled
outright.

**Enforcement.**

- Every page calls `requireUserOrRedirect()` or `requireRoleOrRedirect()`; every route handler and server action
  calls `requireUser()` or `requireRole()`.
- Customers see only their own orders; another customer's order is a 404. Admins get 404 from every order route.
- Mutating routes check the Origin header against `APP_URL`, accept JSON of at most 16 KB and validate with zod.
  Errors go through `errorResponse()`, with no stack traces.
- **Limits:** 10 orders per customer per hour and 3 open at once; up to 20 lines of 1 to 20 each; 120 menu writes per
  staff member per hour, 20 categories and 200 dishes; 3 streams per user and 100 in total; the assistant caps above.
- Public sign-ups can't take the reserved demo email domain.

**Tests.** `test/orders.integration.test.ts` covers idempotency, snapshots, the status machine, stale versions and
accepting with an unacknowledged alert. `test/menu.integration.test.ts` covers verified declarations and the
append-only log. `test/order-stream.integration.test.ts` covers who receives which events and the stream limits.
`test/routes.integration.test.ts`, `test/roles.integration.test.ts`, `test/assistant.integration.test.ts`,
`test/admin-stats.integration.test.ts`, `test/admin-permissions.integration.test.ts` and
`test/demo-restaurant.integration.test.ts` cover access on every route, role changes, the assistant, admin counts and
limits, and the demo loader. `scripts/smoke.sh` runs the main flows over HTTP.

## Known limits

- **The live menu is empty until an admin loads the demo restaurant** (or staff add dishes). The live smoke test
  stops at "the menu has no orderable dish" for that reason, so no full smoke run has passed against the live URL yet.
- **AI runs on recorded answers on Oracle** unless a Gemini key is added to the VM's shared settings. Allergen answers
  are unaffected.
- **Visitors can only try the customer side.** The kitchen board needs an admin to grant the `staff` role.
- **One instance only.** The order bus is in-process; more instances would need Postgres `LISTEN/NOTIFY`.
- **The 100-stream cap can be used up** by many free accounts. Clients that get 429 fall back to polling every 5
  seconds, so status still updates, with more load and delay.
- **Triggers don't stop a superuser.** The Oracle VM shares one `postgres` superuser across apps; per-app database
  roles are a known follow-up.
- No online payment (pay at pickup), no delivery, no modifiers or combos, no scheduled orders, one restaurant per
  deployment. Allergens cover the US major nine plus gluten, not the EU list.
- No email: there is no password reset or verification.

## Free-tier budget

| Resource | Control |
| --- | --- |
| A1 VM (shared with every Oracle app) | One more container; at most 100 open streams, heartbeats only |
| Postgres (same VM) | Order and menu caps above; orders are small rows |
| Gemini | Not configured on Oracle (demo answers); allergen answers never call a model; `QA_DAILY_CAP` when live |

## Configuration

Names only; values live in the cloud's secret store or `.env.local`. See `.env.example` and `src/lib/env.ts`.

| Variable | Purpose |
| --- | --- |
| `APP_URL`, `APP_NAME` | Public URL (also the only allowed Origin) and display name |
| `DATABASE_URL` | Postgres connection |
| `BETTER_AUTH_SECRET` | Session signing, at least 32 characters |
| `AI_PROVIDER`, `AI_MODEL`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | Model choice (`demo`, `gemini` or `anthropic`) |
| `AI_FALLBACK_TO_DEMO`, `AI_TIMEOUT_MS`, `QA_DAILY_CAP` | Fallback to recorded answers, provider timeout, daily live assistant calls |
| `RESTAURANT_TZ` | IANA time zone for order numbers and daily counts (default `America/Chicago`) |
| `MIGRATE_ON_START` | Apply migrations at startup (on in the cloud) |
| `LOG_LEVEL` | JSON log level |

## Run it locally

```bash
cp .env.example .env.local          # then set BETTER_AUTH_SECRET (openssl rand -base64 32)
docker compose up -d db             # Postgres 17
pnpm install
pnpm db:migrate
pnpm dev                            # http://localhost:3000
```

`AI_PROVIDER=demo` (the default) needs no key or network. To make yourself an admin, sign up, then run
`SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=... pnpm db:seed` while the app is running. To load Demo Noodle
Bar with a password you can sign in with, run:

```bash
DEMO_SEED=yes APP_URL=http://localhost:3000 DEMO_PASSWORD='<a local password>' \
  pnpm tsx --conditions=react-server scripts/seed-demo.mts
```

Sign in as `avery.staff@demo.breakthru.test` (staff), `casey@demo.breakthru.test` (customer) or
`admin@demo.breakthru.test`. The seed refuses production hosts and databases.

Checks:

```bash
pnpm lint && pnpm typecheck && pnpm test   # unit tests
TEST_DATABASE_URL=postgres://... pnpm test # plus integration tests against real Postgres
pnpm build && pnpm smoke                   # HTTP smoke test against a running app (BASE_URL)
```

## Deploy it yourself

Every push to `main` publishes a multi-arch image to `ghcr.io/breakthrudevelopment/12-restaurant-ordering:sha-<commit>`.
[30-apps-infra](https://github.com/BreakthruDevelopment/30-apps-infra) deploys a pinned tag. The same image runs on
AWS (Lambda), Azure (Container Apps), Google Cloud (Cloud Run) and Oracle Cloud (Docker on a VM); see
`infra/README.md`. This repo holds no cloud credentials. With `MIGRATE_ON_START=true`, the server applies pending
migrations, including the triggers, before taking traffic. The order bus assumes one instance (see
[Known limits](#known-limits)).

## 2-minute demo script

You need the demo restaurant loaded, a customer account on a phone and a staff account on a second screen (locally,
the seeded `casey@` and `avery.staff@` accounts). Without a Gemini key, step 2 returns the recorded demo answer
instead; every other step is the same.

1. **Ask about an allergy.** As the customer, ask the assistant "Is the pad thai peanut free?" The answer lists what
   the dish declares, never says "free" or "safe", and ends with the fixed notice. *Proves: allergen questions are
   answered from the menu data, with no model involved.*
2. **Ask a general question.** "Anything spicy under $15?" The reply lists spicy dishes with menu prices and "Ask
   staff about allergies." *Proves: the model only picks dishes; the server writes every word.*
3. **Order with an allergy.** Add the pad thai, go to checkout, answer yes to the allergy question and pick
   peanuts. The dish turns red; tick **I'll confirm with staff before eating** and **Place order**. *Proves: the
   allergy question is required and conflicts are shown before ordering.*
4. **The kitchen sees it live.** On the kitchen board the order appears without a reload, with a red **Allergy
   alert** band. **Accept** is refused until **Allergy reviewed with kitchen** is pressed. *Proves: real-time orders,
   and a server rule that staff review allergies first.*
5. **Move it along.** Staff choose **Accept**, **Start preparing** and **Mark ready**. The customer's tracker moves
   each time and ends with "Your order is ready. Come and collect it." *Proves: live status over SSE, with data
   fetched through the normal access checks.*
6. **Change a declaration.** In the menu editor, open a dish, change an allergen, tick **I checked these against the
   recipe** and **Save allergens**. The change log shows who changed what. *Proves: verified declarations with an
   append-only history.*
