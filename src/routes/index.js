const router = require('express').Router();
const { asyncHandler } = require('../middleware/error');
const { nowpaymentsIpn } = require('../controllers/webhook.controller');

// Webhook — public, no auth, must come before member routes
router.post('/webhooks/nowpayments', asyncHandler(nowpaymentsIpn));

router.use('/auth', require('./auth.routes'));
router.use('/', require('./member.routes'));
router.use('/admin', require('./admin.routes'));

module.exports = router;
