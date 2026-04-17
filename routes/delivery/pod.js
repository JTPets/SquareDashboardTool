// Delivery POD (proof of delivery) sub-router: upload and serve photos.
const express = require('express');
const router = express.Router();
const multer = require('multer');
const deliveryApi = require('../../services/delivery');
const asyncHandler = require('../../middleware/async-handler');
const { configureDeliveryRateLimit } = require('../../middleware/security');
const { validateUploadedImage } = require('../../utils/file-validation');
const validators = require('../../middleware/validators/delivery');
const { requireWriteAccess } = require('../../middleware/auth');
const { sendSuccess, sendError } = require('../../utils/response-helper');

const deliveryRateLimit = configureDeliveryRateLimit();

const podUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image files are allowed'), false);
    }
});

router.post('/orders/:id/pod', deliveryRateLimit, requireWriteAccess, podUpload.single('photo'), validateUploadedImage('photo'), validators.uploadPod, asyncHandler(async (req, res) => {
    const merchantId = req.merchantContext.id;
    if (!req.file) return sendError(res, 'No photo uploaded', 400);
    const pod = await deliveryApi.savePodPhoto(merchantId, req.params.id, req.file.buffer, {
        originalFilename: req.file.originalname,
        mimeType: req.file.mimetype,
        latitude: req.body.latitude ? parseFloat(req.body.latitude) : null,
        longitude: req.body.longitude ? parseFloat(req.body.longitude) : null
    });
    await deliveryApi.logAuditEvent(merchantId, req.session.user.id, 'pod_uploaded', req.params.id, null,
        { podId: pod.id, hasGps: !!(req.body.latitude && req.body.longitude) }, req.ip, req.get('user-agent'));
    sendSuccess(res, { pod }, 201);
}));

router.get('/pod/:id', validators.getPod, asyncHandler(async (req, res) => {
    const pod = await deliveryApi.getPodPhoto(req.merchantContext.id, req.params.id);
    if (!pod) return sendError(res, 'POD not found', 404);
    res.setHeader('Content-Type', pod.mime_type || 'image/jpeg');
    res.setHeader('Content-Disposition', `inline; filename="${pod.original_filename || 'pod.jpg'}"`);
    res.sendFile(pod.full_path);
}));

module.exports = router;
