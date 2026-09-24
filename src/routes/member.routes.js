const router = require('express').Router();
const { asyncHandler } = require('../middleware/error');
const { authenticate } = require('../middleware/auth');
const member = require('../controllers/member.controller');
const deposits = require('../controllers/deposit.controller');
const packages = require('../controllers/package.controller');
const withdrawals = require('../controllers/withdrawal.controller');

// Everything here requires a logged-in member.
router.use(authenticate);

// Profile / dashboard
router.get('/me/dashboard', asyncHandler(member.dashboard));
router.get('/me/team', asyncHandler(member.team));
router.get('/me/income', asyncHandler(member.income));
router.patch('/me/profile', asyncHandler(member.updateProfile));
router.delete('/me/profile/wallet', asyncHandler(member.deleteWallet));

// Packages
router.get('/packages', asyncHandler(packages.list));
router.post('/packages/buy', asyncHandler(packages.buy));

// Deposits
router.post('/deposits', asyncHandler(deposits.create));
router.post('/deposits/nowpayments', asyncHandler(deposits.initNowPayments));
router.get('/deposits', asyncHandler(deposits.listMine));

// Withdrawals
router.post('/withdrawals', asyncHandler(withdrawals.request));
router.get('/withdrawals', asyncHandler(withdrawals.listMine));

module.exports = router;
