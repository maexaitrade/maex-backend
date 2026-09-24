# MAEX Trade — VPS Deployment Guide

Deploy **backend + MySQL + frontend** on a single Ubuntu VPS
(DigitalOcean / Hostinger / Contabo, ~₹350–500/month).

- Backend (Node/Express) runs under **pm2** on port 4000 (single instance — it runs cron).
- **MySQL** runs on the same server.
- **Nginx** serves the frontend build and reverse-proxies `/api` to the backend.
- **Let's Encrypt** gives free HTTPS (needed for the NOWPayments IPN callback).

A domain is recommended (needed for free SSL). You can start with the raw IP and add SSL later.

---

## 0. What you need
- A VPS with **Ubuntu 22.04/24.04** and its `root` (or sudo) SSH access.
- A domain pointed to the VPS IP (an `A` record). Optional at first, required for HTTPS.
- Your NOWPayments API key + IPN secret.

SSH in:
```bash
ssh root@YOUR_SERVER_IP
```

---

## 1. Install Node, MySQL, Nginx, pm2, git
```bash
sudo apt update && sudo apt upgrade -y

# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git nginx mysql-server

# pm2 (process manager, keeps backend + cron always-on)
sudo npm install -g pm2
```

---

## 2. Secure MySQL and create the database + user
```bash
sudo mysql_secure_installation      # set a root password, answer Y to the rest
```
Then open MySQL and create an app database + user (change the password!):
```bash
sudo mysql -u root -p
```
```sql
CREATE DATABASE maex_trade CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'maex'@'localhost' IDENTIFIED BY 'CHANGE_ME_STRONG_PASS';
GRANT ALL PRIVILEGES ON maex_trade.* TO 'maex'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

---

## 3. Get the code onto the server
```bash
sudo mkdir -p /var/www && cd /var/www

# clone both repos (use your own git URLs)
sudo git clone <BACKEND_REPO_URL> metrix-plan
sudo git clone <FRONTEND_REPO_URL> metrix-plan-ui
```
> No git remote yet? Push both folders to GitHub first, or `scp -r` them up.

---

## 4. Configure and start the BACKEND
```bash
cd /var/www/metrix-plan
npm ci --omit=dev        # install prod deps

# create the production .env
cp .env.example .env
nano .env
```
Set these in `.env`:
```
NODE_ENV=production
PORT=4000

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=maex
DB_PASSWORD=CHANGE_ME_STRONG_PASS
DB_NAME=maex_trade

JWT_SECRET=<paste a long random string>
JWT_EXPIRES_IN=7d

ENABLE_CRON=true          # REQUIRED — runs daily ROI + 10-min deposit expiry
DEPOSIT_VALID_HOURS=2

NOWPAYMENTS_API_KEY=<your key>
NOWPAYMENTS_IPN_SECRET=<your secret>
APP_URL=https://your-domain.com     # backend's public URL, used for the IPN callback
```

Create the schema (FIRST TIME ONLY — this wipes, so it's guarded behind --force):
```bash
npm run db:init -- --force
npm run db:migrate
node scripts/createAdmin.js "Admin" admin@maex.test admin123
```

Start under pm2 (edit `cwd` in the config first if your path differs):
```bash
pm2 start deploy/ecosystem.config.js
pm2 save
pm2 startup        # run the command it prints, so it survives reboots
pm2 logs maex-backend    # check it booted + "[cron] ... scheduled"
```

---

## 5. Build and place the FRONTEND
```bash
cd /var/www/metrix-plan-ui
npm ci

# point the UI at your backend API (note the /api suffix)
echo "VITE_API_URL=https://your-domain.com/api" > .env.production

npm run build      # outputs to dist/
```
Nginx will serve `/var/www/metrix-plan-ui/dist` (configured next).

---

## 6. Nginx
```bash
sudo cp /var/www/metrix-plan/deploy/nginx.conf /etc/nginx/sites-available/maex
sudo nano /etc/nginx/sites-available/maex     # set server_name to your domain
sudo ln -s /etc/nginx/sites-available/maex /etc/nginx/sites-enabled/maex
sudo rm -f /etc/nginx/sites-enabled/default    # remove the default welcome page
sudo nginx -t && sudo systemctl reload nginx
```
Now `http://your-domain.com` should load the app, and `/api` should reach the backend.

---

## 7. Free HTTPS (Let's Encrypt) — required for NOWPayments IPN
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```
Certbot rewrites the Nginx config to serve HTTPS and auto-renews. After this,
`https://your-domain.com` works.

> Make sure `APP_URL` in the backend `.env` uses **https://** — then restart:
> ```bash
> cd /var/www/metrix-plan && pm2 restart maex-backend
> ```

---

## 8. Firewall (optional but recommended)
```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

---

## 9. Point NOWPayments at the server
In the NOWPayments dashboard → **Settings → IPN / Instant Payment Notifications**,
set the callback URL to:
```
https://your-domain.com/api/webhooks/nowpayments
```
Use the **same IPN secret** you put in `.env`.

---

## Done. How to operate it afterwards

**Deploy a code update (NEVER re-run db:init):**
```bash
# backend
cd /var/www/metrix-plan && git pull && npm ci --omit=dev && npm run db:migrate && pm2 restart maex-backend
# frontend
cd /var/www/metrix-plan-ui && git pull && npm ci && npm run build
```

**Handy commands:**
```bash
pm2 status                 # is the backend up?
pm2 logs maex-backend      # live logs (cron, IPN, errors)
npm run job:expire         # manually expire stale deposits (cron also does this every 10 min)
```

**Backups (important — real data):**
```bash
mysqldump -u maex -p maex_trade > ~/maex_backup_$(date +%F).sql
```
Schedule this in `crontab -e` to run daily.

---

### Reminder
`db:init` is now guarded — it refuses to run when the DB has data or in
production. For every restart/update you only ever need `db:migrate` + `pm2 restart`.
Your data persists.
