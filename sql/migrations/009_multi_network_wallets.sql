-- Admin-managed deposit addresses with exactly one globally active crypto network.
INSERT INTO settings (`key`, `value`)
SELECT 'deposit_address_trc20', COALESCE(
  (SELECT `value` FROM (SELECT `key`, `value` FROM settings) AS old_settings WHERE `key` = 'admin_deposit_address' LIMIT 1),
  ''
)
ON DUPLICATE KEY UPDATE `value` = `value`;

INSERT INTO settings (`key`, `value`) VALUES
  ('deposit_address_bep20', ''),
  ('deposit_address_spl', '')
ON DUPLICATE KEY UPDATE `value` = `value`;

INSERT INTO settings (`key`, `value`)
SELECT 'active_crypto_network', CASE UPPER(COALESCE(
  (SELECT `value` FROM (SELECT `key`, `value` FROM settings) AS old_settings WHERE `key` = 'deposit_network' LIMIT 1),
  'TRC20'
))
  WHEN 'BEP20' THEN 'BEP20'
  WHEN 'BEP-20' THEN 'BEP20'
  WHEN 'SPL' THEN 'SPL'
  WHEN 'SOLANA' THEN 'SPL'
  ELSE 'TRC20'
END
ON DUPLICATE KEY UPDATE `value` = `value`;

ALTER TABLE deposits
  ADD COLUMN deposit_network VARCHAR(20) NULL AFTER from_address,
  ADD COLUMN deposit_address VARCHAR(120) NULL AFTER deposit_network;

ALTER TABLE withdrawals
  ADD COLUMN withdrawal_network VARCHAR(20) NULL AFTER wallet_address;

-- Existing direct deposits/withdrawals were TRC20-only before this migration.
UPDATE deposits
SET deposit_network = 'TRC20',
    deposit_address = COALESCE(pay_address, (
      SELECT `value` FROM settings WHERE `key` = 'deposit_address_trc20' LIMIT 1
    ))
WHERE deposit_network IS NULL;

UPDATE withdrawals
SET withdrawal_network = 'TRC20'
WHERE withdrawal_network IS NULL;
