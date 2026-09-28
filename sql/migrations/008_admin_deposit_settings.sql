INSERT INTO settings (`key`, `value`) VALUES ('admin_deposit_address', '')
  ON DUPLICATE KEY UPDATE `value` = `value`;

INSERT INTO settings (`key`, `value`) VALUES ('deposit_via', 'admin')
  ON DUPLICATE KEY UPDATE `value` = `value`;
