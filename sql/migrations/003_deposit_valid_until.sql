-- Add a payment-validity deadline to NOWPayments deposits.
-- A pending deposit past this timestamp is treated as expired (app-enforced,
-- because NOWPayments keeps unpaid payments in "waiting" indefinitely).
ALTER TABLE deposits
  ADD COLUMN pay_valid_until DATETIME NULL AFTER pay_amount_crypto;
