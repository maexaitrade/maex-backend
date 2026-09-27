const router = require('express').Router();
const { asyncHandler } = require('../middleware/error');
const auth = require('../controllers/auth.controller');

router.post('/register', asyncHandler(auth.register));
router.post('/login', asyncHandler(auth.login));
router.post('/create-admin', asyncHandler(auth.createAdmin));

module.exports = router;
