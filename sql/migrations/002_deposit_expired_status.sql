-- Add 'expired' as a distinct deposit status for unpaid NOWPayments orders
ALTER TABLE deposits
  MODIFY COLUMN status ENUM('pending','confirmed','rejected','expired') NOT NULL DEFAULT 'pending';
