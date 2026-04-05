const express = require('express');
const router = express.Router();

router.use('/', require('./public'));
router.use('/', require('./plans'));
router.use('/', require('./merchant'));
router.use('/', require('./admin'));
router.use('/', require('./webhooks'));

module.exports = router;
