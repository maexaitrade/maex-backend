-- Holds a registration until its email OTP is verified. The real user row in
-- `users` is created only after the OTP is confirmed.
CREATE TABLE IF NOT EXISTS pending_registrations (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email         VARCHAR(160) NOT NULL UNIQUE,
  name          VARCHAR(120) NOT NULL,
  phone         VARCHAR(30) NULL,
  password_hash VARCHAR(255) NOT NULL,
  sponsor_id    BIGINT UNSIGNED NULL,
  otp           VARCHAR(6) NOT NULL,
  expires_at    DATETIME NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB;
