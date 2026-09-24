// PM2 process config for the MAEX Trade backend.
// IMPORTANT: exactly ONE instance in fork mode — the app runs cron jobs
// (daily ROI + 10-min deposit expiry) and an ROI catch-up on boot, so running
// multiple instances would double-credit. Do NOT switch to cluster mode.
//
// Usage on the server:
//   pm2 start deploy/ecosystem.config.js
//   pm2 save && pm2 startup   (to auto-start on reboot)
module.exports = {
  apps: [
    {
      name: 'maex-backend',
      script: 'src/server.js',
      cwd: '/var/www/metrix-plan',   // <-- change to where you cloned the repo
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
      },
      // App reads the rest of its config from the .env file in `cwd`.
    },
  ],
};
