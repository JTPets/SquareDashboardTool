// Delivery feature routes — mounts sub-routers for orders, pod, route, settings, and sync.
// Services: services/delivery (orders, routes, settings, sync, pod, audit), services/delivery/delivery-stats
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');
const { requireMerchant } = require('../../middleware/merchant');

router.use(requireAuth, requireMerchant);

router.use('/', require('./orders'));
router.use('/', require('./pod'));
router.use('/', require('./routes'));
router.use('/', require('./settings'));
router.use('/', require('./sync'));

module.exports = router;
