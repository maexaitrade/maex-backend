-- Add 'adjustment' as a valid transaction type for admin wallet adjustments
ALTER TABLE transactions
MODIFY COLUMN type ENUM('deposit','roi','referral','booster','reward','withdrawal','purchase','adjustment') NOT NULL;
