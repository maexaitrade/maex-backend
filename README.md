# MAEX Trade — Backend (College Project)

A member investment platform API built with **Node.js + Express + MySQL**.
Members buy a package, earn a fixed daily ROI, and earn referral / booster /
rank income by building a downline. Each account earns up to **2× its package**,
then must repurchase.

> **Academic project.** This simulates a HYIP/MLM compensation model for
> coursework. Such fixed-return + recruitment schemes are financially
> unsustainable and, with real public deposits, illegal in many places
> (e.g. India's BUDS Act, 2019). Use only mock/test deposits. See
> [PROJECT_PLAN.md](PROJECT_PLAN.md) for the full design.

## Requirements
- Node.js 18+ (tested on 22)
- MySQL 8 (local, XAMPP, or Docker)

## Setup

```bash
# 1. install dependencies
npm install

# 2. configure environment
cp .env.example .env      # then edit DB_* and JWT_SECRET

# 3. create the database, tables and seed data
npm run db:init

# 4. create an admin login
node scripts/createAdmin.js "Admin" admin@maex.test admin123

# 5. run the API
npm run dev               # or: npm start
# -> http://localhost:4000/health
```

If you don't have MySQL locally, start one with Docker:

```bash
docker run --name maex-mysql -e MYSQL_ROOT_PASSWORD=root -p 3306:3306 -d mysql:8
```

## How the money flows
1. Member **registers** with `?ref=<sponsorId>` (recorded in the referral tree).
2. Member submits a **deposit** (pending) → **admin confirms** it → wallet is
   credited, **referral** L1/L2/L3 is paid, and up-line **ranks** are recomputed.
3. Member **buys a package** from wallet balance → an **investment** is created
   with a 2× cap → the sponsor's **booster** is checked.
4. The **daily ROI job** credits ROI to every active investment, respecting the cap.
5. Member **requests a withdrawal** (min $50, 6% fee) → **admin pays** it.

## Running the jobs manually (for demos)
```bash
npm run job:roi            # credit today's ROI to all active investments
npm run job:roi 2026-09-21 # credit ROI for a specific date
npm run job:rank           # recompute everyone's rank
```
Set `ENABLE_CRON=true` in `.env` to run the ROI + rank jobs automatically each day.

## API reference

Auth is via `Authorization: Bearer <token>` from register/login.

### Public
| Method | Route | Body |
|---|---|---|
| POST | `/api/auth/register` | `{ name, email, password, phone?, sponsorId? }` |
| POST | `/api/auth/login` | `{ email, password }` |

### Member (Bearer token)
| Method | Route | Purpose |
|---|---|---|
| GET | `/api/me/dashboard` | wallet, investments, cap progress, income, rank |
| GET | `/api/me/team` | levels 1–3 + team business |
| GET | `/api/me/income?type=roi&page=1` | ledger history |
| PATCH | `/api/me/profile` | `{ wallet_address }` |
| GET | `/api/packages` | list packages |
| POST | `/api/packages/buy` | `{ amount }` |
| POST | `/api/deposits` | `{ amount, tx_hash?, from_address? }` |
| GET | `/api/deposits` | my deposits |
| POST | `/api/withdrawals` | `{ amount }` |
| GET | `/api/withdrawals` | my withdrawals |

### Admin (Bearer token, role=admin)
| Method | Route | Purpose |
|---|---|---|
| GET | `/api/admin/deposits?status=pending` | review queue |
| PATCH | `/api/admin/deposits/:id` | `{ action: 'confirm' \| 'reject' }` |
| GET | `/api/admin/withdrawals?status=pending` | review queue |
| PATCH | `/api/admin/withdrawals/:id` | `{ action: 'pay' \| 'reject', tx_hash? }` |
| POST | `/api/admin/packages` | create/update package |
| POST | `/api/admin/ranks` | create/update rank |
| POST | `/api/admin/settings` | `{ key, value }` |
| GET | `/api/admin/users` | list users |
| GET | `/api/admin/reports` | totals & payout summary |

## Quick demo (curl)
```bash
# register a sponsor (id 2 here, after the admin at id 1)
curl -s localhost:4000/api/auth/register -H 'content-type: application/json' \
  -d '{"name":"Alice","email":"alice@test.com","password":"secret1"}'

# login, then deposit -> admin confirms -> buy package -> run ROI
```

## Tests
Automated integration tests (Jest + supertest) run against an **isolated
`maex_trade_test` database**, so your dev data is never touched. They rebuild
the schema before each suite, drive the real HTTP API, and assert against MySQL.

```bash
npm test
```

21 tests across 4 suites cover:
- **money utils** — rounding and percentage math (ROI, referral, charge).
- **auth + genealogy** — register/login, duplicate email, short password,
  protected routes, and the closure-tree levels 1–3.
- **flow** — deposit confirm → referral payout, inactive up-line earns nothing,
  rejected deposits don't credit, 2× cap on purchase, Premium rate above $5000,
  ROI credit + **idempotency**, ROI **cap-trimming**, and the full withdrawal
  lifecycle (min/charge/pay/reject-refund).
- **rank + booster** — 7-direct booster (paid once), sub-threshold no-payout,
  Star-1 reward on $5000 team business, and member-blocked-from-admin (403).

Requires a running MySQL (same server as dev is fine). Override the test DB name
with `TEST_DB_NAME` if needed.

## Project structure
```
src/
  config/      env, db pool + withTransaction
  middleware/  auth (JWT + role), error handling
  services/    settings, wallet(ledger), investment(cap), genealogy,
               referral, booster, rank, roi
  controllers/ auth, member, deposit, package, withdrawal, admin
  routes/      auth, member, admin
  jobs/        scheduler (node-cron)
  app.js, server.js
scripts/       initDb, createAdmin, runRoi, runRank
sql/schema.sql 14 core tables + seed (packages, ranks, settings)
```

## Key design points
- **Ledger-first:** every money move writes a `transactions` row; wallet
  balance is always reconcilable.
- **Idempotent ROI:** `UNIQUE(investment_id, roi_date)` means the daily job is
  safe to run twice.
- **2× cap:** all incomes (ROI + referral + booster + reward) are funneled
  through `creditWithCap`, which never lets an investment exceed 2× its amount.
- **Transactions everywhere:** financial mutations run inside a single DB
  transaction with row locks (`SELECT ... FOR UPDATE`).
- **Active-package rule:** referral / booster / reward income only accrues to an
  up-line member who currently has an **active package**, because working income
  is funneled through that package's 2× cap. A member with no active package
  earns nothing until they (re)purchase — this is what keeps "2x then
  repurchase" coherent.

## Verified end-to-end
`bash scripts/demo.sh` (with the server running) reproduces a full run:
register a referral chain, fund + buy packages, pay L1/L2 referral, run daily
ROI, and hit the 2× cap. A 210-day ROI fast-forward caps every investment at
exactly 2× and a repeated-date run credits nothing (idempotent).
