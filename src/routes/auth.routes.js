const router = require('express').Router();
const { asyncHandler } = require('../middleware/error');
const auth = require('../controllers/auth.controller');

router.post('/register', asyncHandler(auth.register));
router.post('/login', asyncHandler(auth.login));
router.post('/create-admin', asyncHandler(auth.createAdmin));
router.post('/verify-otp', asyncHandler(auth.verifyOtp));
router.post('/resend-otp', asyncHandler(auth.resendOtp));
router.post('/forgot-password', asyncHandler(auth.forgotPassword));
router.post('/reset-password', asyncHandler(auth.resetPassword));

module.exports = router;
