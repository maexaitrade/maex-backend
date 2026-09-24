-- MAEX Trade — MySQL schema (college project)
-- Run: mysql -u root -p < sql/schema.sql   (or import via phpMyAdmin)
-- Money is stored as DECIMAL(18,2). USDT amounts assumed 2 dp for simplicity.

CREATE DATABASE IF NOT EXISTS maex_trade
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE maex_trade;

-- Drop in dependency order (safe re-run for development)
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS user_rewards;
DROP TABLE IF EXISTS booster_earnings;
DROP TABLE IF EXISTS referral_earnings;
DROP TABLE IF EXISTS roi_earnings;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS withdrawals;
DROP TABLE IF EXISTS deposits;
DROP TABLE IF EXISTS investments;
DROP TABLE IF EXISTS wallets;
DROP TABLE IF EXISTS genealogy;
DROP TABLE IF EXISTS user_rank_link;
DROP TABLE IF EXISTS ranks;
DROP TABLE IF EXISTS packages;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS users;
SET FOREIGN_KEY_CHECKS = 1;

-- 1. users -------------------------------------------------------------------
CREATE TABLE users (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sponsor_id      BIGINT UNSIGNED NULL,
  name            VARCHAR(120) NOT NULL,
  email           VARCHAR(160) NOT NULL,
  phone           VARCHAR(30) NULL,
  password_hash   VARCHAR(255) NOT NULL,
  wallet_address  VARCHAR(120) NULL,
  current_rank_id INT UNSIGNED NULL,
  role            ENUM('member','admin') NOT NULL DEFAULT 'member',
  status          ENUM('active','blocked') NOT NULL DEFAULT 'active',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_sponsor (sponsor_id),
  CONSTRAINT fk_users_sponsor FOREIGN KEY (sponsor_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 2. genealogy (closure table: every ancestor->descendant pair with depth) ---
CREATE TABLE genealogy (
  ancestor_id   BIGINT UNSIGNED NOT NULL,
  descendant_id BIGINT UNSIGNED NOT NULL,
  depth         INT UNSIGNED NOT NULL,
  PRIMARY KEY (ancestor_id, descendant_id),
  KEY idx_gen_descendant (descendant_id),
  KEY idx_gen_ancestor_depth (ancestor_id, depth),
  CONSTRAINT fk_gen_anc FOREIGN KEY (ancestor_id) REFERENCES users(id),
  CONSTRAINT fk_gen_desc FOREIGN KEY (descendant_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 3. packages ----------------------------------------------------------------
CREATE TABLE packages (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name              VARCHAR(60) NOT NULL,
  min_amount        DECIMAL(18,2) NOT NULL,
  max_amount        DECIMAL(18,2) NULL,          -- NULL = no upper limit
  daily_roi_percent DECIMAL(6,3) NOT NULL,       -- e.g. 1.000, 1.500
  is_active         TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

-- 4. investments -------------------------------------------------------------
CREATE TABLE investments (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  package_id     INT UNSIGNED NOT NULL,
  amount         DECIMAL(18,2) NOT NULL,
  daily_roi_rate DECIMAL(6,3) NOT NULL,          -- snapshot of percent at purchase
  cap_amount     DECIMAL(18,2) NOT NULL,         -- 2 x amount
  total_earned   DECIMAL(18,2) NOT NULL DEFAULT 0,
  status         ENUM('active','capped') NOT NULL DEFAULT 'active',
  purchased_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_inv_user (user_id),
  KEY idx_inv_status (status),
  CONSTRAINT fk_inv_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_inv_pkg FOREIGN KEY (package_id) REFERENCES packages(id)
) ENGINE=InnoDB;

-- 5. deposits ----------------------------------------------------------------
CREATE TABLE deposits (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      BIGINT UNSIGNED NOT NULL,
  amount       DECIMAL(18,2) NOT NULL,
  tx_hash          VARCHAR(120) NULL,
  from_address     VARCHAR(120) NULL,
  pay_address      VARCHAR(120) NULL,
  pay_amount_crypto DECIMAL(18,8) NULL,
  pay_valid_until  DATETIME NULL,           -- NOWPayments deposit expiry (app-enforced)
  status           ENUM('pending','confirmed','rejected','expired') NOT NULL DEFAULT 'pending',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_dep_user (user_id),
  KEY idx_dep_status (status),
  CONSTRAINT fk_dep_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 6. withdrawals -------------------------------------------------------------
CREATE TABLE withdrawals (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  amount         DECIMAL(18,2) NOT NULL,         -- gross requested
  charge         DECIMAL(18,2) NOT NULL,         -- 6% fee
  net_amount     DECIMAL(18,2) NOT NULL,         -- amount - charge
  wallet_address VARCHAR(120) NOT NULL,
  tx_hash        VARCHAR(120) NULL,
  status         ENUM('pending','paid','rejected') NOT NULL DEFAULT 'pending',
  requested_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at   DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_wd_user (user_id),
  KEY idx_wd_status (status),
  CONSTRAINT fk_wd_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 7. wallets (one row per user; running summary) -----------------------------
CREATE TABLE wallets (
  user_id        BIGINT UNSIGNED NOT NULL,
  balance        DECIMAL(18,2) NOT NULL DEFAULT 0,
  total_deposit  DECIMAL(18,2) NOT NULL DEFAULT 0,
  total_withdraw DECIMAL(18,2) NOT NULL DEFAULT 0,
  total_earned   DECIMAL(18,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_wallet_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 8. transactions (master ledger) --------------------------------------------
CREATE TABLE transactions (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  type            ENUM('deposit','roi','referral','booster','reward','withdrawal','purchase') NOT NULL,
  direction       ENUM('credit','debit') NOT NULL,
  amount          DECIMAL(18,2) NOT NULL,
  reference_table VARCHAR(40) NULL,
  reference_id    BIGINT UNSIGNED NULL,
  balance_after   DECIMAL(18,2) NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_tx_user (user_id),
  KEY idx_tx_type (type),
  CONSTRAINT fk_tx_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 9. roi_earnings (idempotent per investment per day) ------------------------
CREATE TABLE roi_earnings (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  investment_id BIGINT UNSIGNED NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  roi_date      DATE NOT NULL,
  amount        DECIMAL(18,2) NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_roi_inv_date (investment_id, roi_date),
  KEY idx_roi_user (user_id),
  CONSTRAINT fk_roi_inv FOREIGN KEY (investment_id) REFERENCES investments(id),
  CONSTRAINT fk_roi_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- 10. referral_earnings ------------------------------------------------------
CREATE TABLE referral_earnings (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       BIGINT UNSIGNED NOT NULL,        -- earner (up-line)
  from_user_id  BIGINT UNSIGNED NOT NULL,        -- down-line who deposited
  deposit_id    BIGINT UNSIGNED NOT NULL,
  level         TINYINT UNSIGNED NOT NULL,       -- 1, 2 or 3
  source_amount DECIMAL(18,2) NOT NULL,
  percent       DECIMAL(6,3) NOT NULL,
  amount        DECIMAL(18,2) NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ref_deposit_level (deposit_id, level),
  KEY idx_ref_user (user_id),
  CONSTRAINT fk_ref_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_ref_from FOREIGN KEY (from_user_id) REFERENCES users(id),
  CONSTRAINT fk_ref_dep FOREIGN KEY (deposit_id) REFERENCES deposits(id)
) ENGINE=InnoDB;

-- 11. booster_earnings (once per investment) ---------------------------------
CREATE TABLE booster_earnings (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       BIGINT UNSIGNED NOT NULL,
  investment_id BIGINT UNSIGNED NOT NULL,
  directs_count INT UNSIGNED NOT NULL,
  amount        DECIMAL(18,2) NOT NULL,
  qualified_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_booster_inv (investment_id),
  KEY idx_booster_user (user_id),
  CONSTRAINT fk_booster_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_booster_inv FOREIGN KEY (investment_id) REFERENCES investments(id)
) ENGINE=InnoDB;

-- 12. ranks ------------------------------------------------------------------
CREATE TABLE ranks (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name              VARCHAR(40) NOT NULL,
  business_required DECIMAL(18,2) NOT NULL,
  reward_amount     DECIMAL(18,2) NOT NULL,
  sort_order        INT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rank_order (sort_order)
) ENGINE=InnoDB;

-- 13. user_rewards (rank achieved, once each) --------------------------------
CREATE TABLE user_rewards (
  id                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id                   BIGINT UNSIGNED NOT NULL,
  rank_id                   INT UNSIGNED NOT NULL,
  business_at_qualification DECIMAL(18,2) NOT NULL,
  reward_amount             DECIMAL(18,2) NOT NULL,
  achieved_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reward_user_rank (user_id, rank_id),
  CONSTRAINT fk_reward_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_reward_rank FOREIGN KEY (rank_id) REFERENCES ranks(id)
) ENGINE=InnoDB;

-- 14. settings (key/value plan config) ---------------------------------------
CREATE TABLE settings (
  `key`   VARCHAR(60) NOT NULL,
  `value` VARCHAR(120) NOT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB;

-- Optional: audit_logs -------------------------------------------------------
CREATE TABLE audit_logs (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_id   BIGINT UNSIGNED NULL,
  action     VARCHAR(80) NOT NULL,
  detail     TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_actor (actor_id)
) ENGINE=InnoDB;

-- FK for users.current_rank_id (added after ranks exists) --------------------
ALTER TABLE users
  ADD CONSTRAINT fk_users_rank FOREIGN KEY (current_rank_id) REFERENCES ranks(id);

-- ============================ SEED DATA ====================================

INSERT INTO packages (name, min_amount, max_amount, daily_roi_percent) VALUES
  ('Starter', 100.00, 5000.00, 1.000),
  ('Premium', 5000.01, NULL,   1.500);

INSERT INTO ranks (name, business_required, reward_amount, sort_order) VALUES
  ('Star 1', 5000.00,   100.00,  1),
  ('Star 2', 15000.00,  300.00,  2),
  ('Star 3', 45000.00,  1000.00, 3),
  ('Star 4', 100000.00, 2000.00, 4),
  ('Star 5', 250000.00, 3500.00, 5);

INSERT INTO settings (`key`, `value`) VALUES
  ('roi_rate_low',    '1.0'),
  ('roi_rate_high',   '1.5'),
  ('roi_threshold',   '5000'),
  ('referral_l1',     '3'),
  ('referral_l2',     '1.5'),
  ('referral_l3',     '1.5'),
  ('booster_days',    '15'),
  ('booster_directs', '7'),
  ('booster_percent', '20'),
  ('cap_multiplier',  '2'),
  ('min_withdraw',    '50'),
  ('withdraw_charge', '6'),
  ('deposit_network', 'TRC-20');
