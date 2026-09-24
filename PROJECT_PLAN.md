# MAEX Trade — Project Plan

**Course project. Backend:** Node.js + Express. **Database:** MySQL.
**Status:** Planning (before coding).

> Academic note: The compensation model in this project (fixed daily ROI plus
> multi-level referral income) mirrors real-world HYIP/MLM schemes, which are
> financially unsustainable and, when run with real public deposits, illegal in
> many jurisdictions (e.g. India's BUDS Act, 2019). This project is built as a
> **simulation for coursework** — it uses test/mock deposits, not real money.

---

## 1. Overview

MAEX Trade is a member investment platform where users buy a package, earn a
fixed **daily return (ROI)**, and earn **referral, booster, and rank rewards**
by building a downline team. Each account can earn up to **2× its package**,
after which it must repurchase.

The project has three parts:
1. **Member portal** — register, deposit, buy package, dashboard, team tree, withdraw.
2. **Admin panel** — approve deposits/withdrawals, manage packages/ranks/settings, reports.
3. **Scheduler** — daily jobs that credit ROI and evaluate ranks.

---

## 2. Assumptions & design decisions

The source plan left three things ambiguous. For this project we fix them as
below. Each is a single config value, so they can be changed later.

| # | Decision | Choice for this project | Why |
|---|----------|-------------------------|-----|
| A | Referral income base | Paid **once**, on the downline's **deposit amount** | Simplest to compute and audit |
| B | 1.5% ROI threshold | Applies **strictly above** $5,000 ($5,000 itself = 1%) | Removes the overlap in the table |
| C | 2× cap scope | **All** incomes (ROI + referral + booster + reward) count toward the cap | Matches "investment and working income all about 2x then repurchase" |
| — | Rank "team business" | **Cumulative total deposits of the whole downline** (all levels); reward paid **once per rank** | Common convention, easy to explain |
| — | ROI schedule | Credited **every day**, including weekends | Plan does not exclude weekends |

**Plan constants (stored in `settings`):**

| Key | Value |
|-----|-------|
| roi_rate_low | 1.0 % (package $100–$5,000) |
| roi_rate_high | 1.5 % (package > $5,000) |
| referral_l1 / l2 / l3 | 3% / 1.5% / 1.5% |
| booster_days | 15 |
| booster_directs | 7 |
| booster_percent | 20 % |
| cap_multiplier | 2× |
| min_withdraw | $50 |
| withdraw_charge | 6 % |
| deposit_network | TRC-20 (USDT) |

---

## 3. Functional requirements

### Member
- FR1 — Register via a sponsor referral link; system records the sponsor.
- FR2 — Login, profile, set TRC-20 wallet address.
- FR3 — Record a deposit (amount + tx hash); pending until admin confirms.
- FR4 — Buy a package from confirmed balance; creates an active investment with a 2× cap.
- FR5 — Dashboard: active package, total earned, **cap progress bar**, wallet balance, income breakup.
- FR6 — Genealogy view: direct referrals and levels 1–3, team size, team business.
- FR7 — Withdraw request: min $50, 6% charge shown, net amount computed.
- FR8 — Income history (ROI / referral / booster / reward) with dates.

### System (automated)
- FR9 — **Daily ROI job**: credit ROI to every active, un-capped investment.
- FR10 — **Referral payout**: on a confirmed deposit, pay sponsor L1/L2/L3.
- FR11 — **Booster check**: 7 directs (same-or-higher package) within 15 days → 20% of own package, once.
- FR12 — **Rank engine**: recompute team business, award reward on crossing a rank threshold.
- FR13 — **Cap enforcement**: when an investment's total earnings reach 2×, mark it capped and stop all further credits tied to it.

### Admin
- FR14 — Approve/reject deposits and withdrawals (records tx hash).
- FR15 — CRUD packages, ranks, and settings.
- FR16 — User list, ledger view, income & payout reports.
- FR17 — Role-based access (admin vs member).

---

## 4. Non-functional requirements
- NFR1 — Money stored as `DECIMAL(18,2)` (or 8 dp for USDT); **never float**.
- NFR2 — Every credit/debit writes one row to the `transactions` ledger; wallet balance is reconcilable from it.
- NFR3 — Daily jobs are **idempotent** (a `roi_earnings` unique key on `investment_id + roi_date` prevents double-pay).
- NFR4 — Passwords hashed (bcrypt); JWT-based sessions; admin routes protected.
- NFR5 — All financial mutations wrapped in DB transactions.
- NFR6 — `audit_logs` for every admin action.

---

## 5. Tech stack & architecture

- **Backend:** Node.js + Express (REST API)
- **DB:** MySQL 8 (via `mysql2` or Sequelize/Prisma ORM)
- **Auth:** JWT + bcrypt, role middleware
- **Scheduler:** `node-cron` (daily ROI + rank recompute)
- **Frontend:** React (or server-rendered EJS/Bootstrap for a simpler build)
- **Validation:** `zod` or `express-validator`

```
maex-trade/
├─ src/
│  ├─ config/        # db, env
│  ├─ models/        # table models
│  ├─ routes/        # auth, member, admin
│  ├─ controllers/
│  ├─ services/      # roi, referral, booster, rank, wallet (business logic)
│  ├─ middleware/    # auth, role, error
│  ├─ jobs/          # cron: dailyRoi.js, rankEngine.js
│  └─ app.js
├─ sql/schema.sql
└─ PROJECT_PLAN.md
```

---

## 6. Database schema (14 core + 3 optional tables)

Legend: PK = primary key, FK = foreign key.

**1. users**
| col | type | notes |
|---|---|---|
| id | BIGINT PK AI | |
| sponsor_id | BIGINT FK→users.id NULL | self-reference (direct parent) |
| name, email, phone | VARCHAR | email unique |
| password_hash | VARCHAR | |
| wallet_address | VARCHAR NULL | TRC-20 |
| current_rank_id | INT FK→ranks.id NULL | |
| role | ENUM('member','admin') | default member |
| status | ENUM('active','blocked') | |
| created_at | DATETIME | |

**2. genealogy** (closure table for fast level queries)
| ancestor_id | BIGINT FK→users.id |
| descendant_id | BIGINT FK→users.id |
| depth | INT | 1,2,3… ; PK(ancestor_id, descendant_id) |

**3. packages**
| id PK | name | min_amount DECIMAL | max_amount DECIMAL NULL | daily_roi_percent DECIMAL |

**4. investments**
| id PK | user_id FK | package_id FK | amount DECIMAL | daily_roi_rate DECIMAL | cap_amount DECIMAL (=2×amount) | total_earned DECIMAL default 0 | status ENUM('active','capped') | purchased_at DATETIME |

**5. deposits**
| id PK | user_id FK | amount DECIMAL | tx_hash VARCHAR | from_address VARCHAR | status ENUM('pending','confirmed','rejected') | confirmed_at DATETIME NULL |

**6. withdrawals**
| id PK | user_id FK | amount DECIMAL | charge DECIMAL | net_amount DECIMAL | wallet_address VARCHAR | tx_hash VARCHAR NULL | status ENUM('pending','paid','rejected') | requested_at, processed_at |

**7. wallets** (one per user, running summary)
| user_id PK FK | balance DECIMAL | total_deposit DECIMAL | total_withdraw DECIMAL | total_earned DECIMAL |

**8. transactions** (master ledger — every money move)
| id PK | user_id FK | type ENUM('deposit','roi','referral','booster','reward','withdrawal','purchase') | direction ENUM('credit','debit') | amount DECIMAL | reference_table VARCHAR | reference_id BIGINT | balance_after DECIMAL | created_at |

**9. roi_earnings**
| id PK | investment_id FK | user_id FK | roi_date DATE | amount DECIMAL | UNIQUE(investment_id, roi_date) |

**10. referral_earnings**
| id PK | user_id FK (earner) | from_user_id FK | level TINYINT(1–3) | source_amount DECIMAL | percent DECIMAL | amount DECIMAL | created_at |

**11. booster_earnings**
| id PK | user_id FK | investment_id FK | directs_count INT | amount DECIMAL | qualified_at DATETIME | UNIQUE(investment_id) |

**12. ranks**
| id PK | name | business_required DECIMAL | reward_amount DECIMAL |

**13. user_rewards**
| id PK | user_id FK | rank_id FK | business_at_qualification DECIMAL | reward_amount DECIMAL | achieved_at DATETIME | UNIQUE(user_id, rank_id) |

**14. settings**
| key VARCHAR PK | value VARCHAR |

**Optional:** `admins`/`roles` (if separated from users), `kyc_documents`, `audit_logs`.

### Seed data — ranks
| name | business_required | reward |
|---|---|---|
| Star 1 | 5,000 | 100 |
| Star 2 | 15,000 | 300 |
| Star 3 | 45,000 | 1,000 |
| Star 4 | 100,000 | 2,000 |
| Star 5 | 250,000 | 3,500 |

### Seed data — packages
| name | min | max | daily_roi |
|---|---|---|---|
| Starter | 100 | 5,000 | 1.0% |
| Premium | 5,000.01 | (null) | 1.5% |

---

## 7. Business-logic rules (pseudocode)

**Daily ROI (cron, once/day):**
```
for each investment where status='active':
    if already has roi_earnings for today: skip        # idempotent
    roi = investment.amount * investment.daily_roi_rate
    roi = min(roi, investment.cap_amount - investment.total_earned)  # respect cap
    if roi <= 0: mark capped; continue
    credit wallet; write roi_earnings + transaction
    investment.total_earned += roi
    if total_earned >= cap_amount: status='capped'
```

**Referral (on deposit confirm):**
```
walk up sponsors L1..L3
pay percent[level] * deposit_amount to each up-line
each payout also checks that earner's active investment cap
```

**Booster (after each new direct's package):**
```
count directs of user with package >= user's package, joined within 15 days of user
if count >= 7 and no booster yet for this investment:
    pay 20% * user.package_amount (once)
```

**Rank engine (cron / on deposit):**
```
business = sum of confirmed deposits of entire downline (genealogy depth>=1)
for each rank ordered by requirement:
    if business >= required and not already awarded: award reward once
```

**Withdrawal:**
```
require amount >= 50 and amount <= wallet.balance
charge = amount * 6%; net = amount - charge
debit wallet; create withdrawal(pending); admin marks paid with tx_hash
```

---

## 8. API endpoints (draft)

| Method | Route | Purpose |
|---|---|---|
| POST | /auth/register | register with `?ref=` sponsor |
| POST | /auth/login | JWT |
| GET | /me/dashboard | package, earnings, cap progress |
| GET | /me/team | genealogy levels 1–3 |
| POST | /deposits | submit deposit + tx hash |
| POST | /packages/buy | activate investment |
| POST | /withdrawals | request payout |
| GET | /me/income | ledger by type |
| GET | /admin/deposits?status=pending | review queue |
| PATCH | /admin/deposits/:id | confirm/reject |
| PATCH | /admin/withdrawals/:id | mark paid/reject |
| CRUD | /admin/packages, /admin/ranks, /admin/settings | config |

---

## 9. Development phases

1. **Setup** — repo, Express skeleton, MySQL connection, `schema.sql`, seed data.
2. **Auth & users** — register with sponsor, login, JWT, roles, genealogy insert on register.
3. **Deposits & packages** — deposit flow, admin confirm, buy package → investment.
4. **Wallet & ledger** — wallets + transactions, balance from ledger.
5. **ROI job** — node-cron daily ROI with cap enforcement (idempotent).
6. **Referral + booster** — payout on deposit confirm; booster check.
7. **Rank engine** — team business + reward.
8. **Withdrawals** — request + admin payout.
9. **Frontend** — member dashboard, team tree, admin panel.
10. **Reports & polish** — income reports, audit logs, validation, README.

---

## 10. Worked example ($1,000 Starter package)
- Daily ROI: 1% × $1,000 = **$10/day**; reaches 2× cap ($2,000) from ROI alone in ~200 days.
- Direct joins with $1,000 → sponsor L1 referral = 3% × $1,000 = **$30** (one-time).
- 7 qualifying directs in 15 days → booster = 20% × $1,000 = **$200** (one-time).
- All of the above count toward the $2,000 cap; after that, repurchase to continue.
- Withdraw $100 → 6% charge $6 → **net $94**, instant.
