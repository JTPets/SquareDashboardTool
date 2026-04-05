// GMC routes — mounts feed, brands, taxonomy, and settings sub-routers
const router = require('express').Router();
router.use('/', require('./feed'));
router.use('/', require('./brands'));
router.use('/', require('./taxonomy'));
router.use('/', require('./settings'));
module.exports = router;
