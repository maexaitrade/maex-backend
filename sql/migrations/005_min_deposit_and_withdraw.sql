-- Add configurable minimum deposit ($100) and lower minimum withdrawal to $10.
-- Both are admin-editable in the settings table afterwards.
INSERT INTO settings (`key`, `value`) VALUES ('min_deposit', '100')
  ON DUPLICATE KEY UPDATE `value` = `value`;

UPDATE settings SET `value` = '10' WHERE `key` = 'min_withdraw';
