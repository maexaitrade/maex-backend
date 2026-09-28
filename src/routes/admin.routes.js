const router = require('express').Router();
const { asyncHandler } = require('../middleware/error');
const { authenticate, requireRole } = require('../middleware/auth');
const admin = require('../controllers/admin.controller');

router.use(authenticate, requireRole('admin'));

// Deposits
router.get('/deposits', asyncHandler(admin.listDeposits));
router.get('/deposits/:id/verify', asyncHandler(admin.verifyDepositTx));
router.patch('/deposits/:id', asyncHandler(admin.reviewDeposit));

// Withdrawals
router.get('/withdrawals', asyncHandler(admin.listWithdrawals));
router.patch('/withdrawals/:id', asyncHandler(admin.reviewWithdrawal));

// Config — write
router.post('/packages', asyncHandler(admin.upsertPackage));
router.post('/ranks', asyncHandler(admin.upsertRank));
router.post('/settings', asyncHandler(admin.updateSetting));

// Config — read
router.get('/packages', asyncHandler(admin.listPackages));
router.get('/ranks', asyncHandler(admin.listRanks));
router.get('/settings', asyncHandler(admin.listSettings));

// Users
router.get('/users', asyncHandler(admin.listUsers));
router.get('/users/:id', asyncHandler(admin.getUserDetail));
router.patch('/users/:id', asyncHandler(admin.updateUser));
router.post('/users/:id/reset-password', asyncHandler(admin.resetPassword));
router.post('/users/:id/adjust', asyncHandler(admin.adjustWallet));

// Audit & utilities
router.get('/audit', asyncHandler(admin.listAudit));
router.post('/roi/run', asyncHandler(admin.runRoi));

// Reports
router.get('/reports', asyncHandler(admin.reports));

module.exports = router;
