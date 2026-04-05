'use strict';

// Auth routes — session, password, and user management
const router = require('express').Router();
router.use('/', require('./session'));
router.use('/', require('./password'));
router.use('/', require('./users'));
module.exports = router;
