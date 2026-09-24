-- Add NOWPayments payment fields to deposits table
ALTER TABLE deposits
  ADD COLUMN pay_address      VARCHAR(120) NULL AFTER from_address,
  ADD COLUMN pay_amount_crypto DECIMAL(18,8) NULL AFTER pay_address;
