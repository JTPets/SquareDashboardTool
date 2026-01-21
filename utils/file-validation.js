/**
 * File Validation Utilities
 * Validates file content using magic numbers (file signatures)
 *
 * Addresses V005: MIME-only file validation vulnerability
 */

/**
 * Known file signatures (magic numbers)
 * Maps hex signatures to MIME types
 */
const FILE_SIGNATURES = {
    // JPEG: FFD8FFE0, FFD8FFE1, FFD8FFE2, FFD8FFE3, FFD8FFE8, FFD8FFDB
    'ffd8ffe0': 'image/jpeg',
    'ffd8ffe1': 'image/jpeg',
    'ffd8ffe2': 'image/jpeg',
    'ffd8ffe3': 'image/jpeg',
    'ffd8ffe8': 'image/jpeg',
    'ffd8ffdb': 'image/jpeg',
    // PNG: 89504E47
    '89504e47': 'image/png',
    // GIF: 47494638 (GIF89a or GIF87a)
    '47494638': 'image/gif',
    // WebP: 52494646 (RIFF header, need to check for WEBP)
    '52494646': 'image/webp',  // Additional check for WEBP needed
    // BMP: 424D
    '424d': 'image/bmp',
    // TIFF: 49492A00 (little endian) or 4D4D002A (big endian)
    '49492a00': 'image/tiff',
    '4d4d002a': 'image/tiff',
    // HEIC/HEIF: Various, starts with ftyp
    '00000018': 'image/heic',  // ftyp at offset 4
    '0000001c': 'image/heic',
    '00000020': 'image/heic',
};

/**
 * Allowed image MIME types
 */
const ALLOWED_IMAGE_TYPES = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/bmp',
    'image/tiff',
];

/**
 * Validate file content using magic numbers
 * @param {Buffer} buffer - File content as Buffer
 * @param {string} expectedMimeType - MIME type claimed by client (optional)
 * @returns {{valid: boolean, detectedType: string|null, error: string|null}}
 */
function validateFileSignature(buffer, expectedMimeType = null) {
    if (!buffer || buffer.length < 4) {
        return {
            valid: false,
            detectedType: null,
            error: 'File is empty or too small'
        };
    }

    // Get first 8 bytes as hex string
    const headerHex = buffer.slice(0, 8).toString('hex').toLowerCase();

    // Check against known signatures
    let detectedType = null;

    // Check 4-byte signatures first
    const fourByteHeader = headerHex.slice(0, 8);  // 4 bytes = 8 hex chars

    // Check 2-byte signatures (BMP)
    const twoByteHeader = headerHex.slice(0, 4);  // 2 bytes = 4 hex chars

    // JPEG check (multiple possible signatures)
    if (fourByteHeader.startsWith('ffd8ff')) {
        detectedType = 'image/jpeg';
    }
    // PNG check
    else if (fourByteHeader === '89504e47') {
        detectedType = 'image/png';
    }
    // GIF check
    else if (fourByteHeader === '47494638') {
        detectedType = 'image/gif';
    }
    // WebP check (RIFF header + WEBP)
    else if (fourByteHeader === '52494646' && buffer.length >= 12) {
        const webpSignature = buffer.slice(8, 12).toString('ascii');
        if (webpSignature === 'WEBP') {
            detectedType = 'image/webp';
        }
    }
    // BMP check
    else if (twoByteHeader === '424d') {
        detectedType = 'image/bmp';
    }
    // TIFF check
    else if (fourByteHeader === '49492a00' || fourByteHeader === '4d4d002a') {
        detectedType = 'image/tiff';
    }

    // If we couldn't detect the type
    if (!detectedType) {
        return {
            valid: false,
            detectedType: null,
            error: `Unrecognized file format (header: ${fourByteHeader})`
        };
    }

    // Check if detected type is in allowed list
    if (!ALLOWED_IMAGE_TYPES.includes(detectedType)) {
        return {
            valid: false,
            detectedType,
            error: `File type ${detectedType} is not allowed`
        };
    }

    // If expectedMimeType provided, verify it matches (with flexibility for JPEG)
    if (expectedMimeType) {
        const normalizedExpected = expectedMimeType.toLowerCase();
        const normalizedDetected = detectedType.toLowerCase();

        // Allow image/jpg as alias for image/jpeg
        const isMatch = normalizedExpected === normalizedDetected ||
            (normalizedExpected === 'image/jpg' && normalizedDetected === 'image/jpeg') ||
            (normalizedExpected === 'image/jpeg' && normalizedDetected === 'image/jpeg');

        if (!isMatch && !normalizedExpected.startsWith('image/')) {
            return {
                valid: false,
                detectedType,
                error: `MIME type mismatch: claimed ${expectedMimeType}, detected ${detectedType}`
            };
        }
    }

    return {
        valid: true,
        detectedType,
        error: null
    };
}

/**
 * Middleware factory for validating uploaded image files
 * @param {string} fieldName - Name of the file field to validate
 * @returns {Function} Express middleware
 */
function validateUploadedImage(fieldName = 'file') {
    return (req, res, next) => {
        // Check if file exists
        const file = req.file || (req.files && req.files[fieldName]);

        if (!file) {
            // No file uploaded, continue (let other middleware handle required check)
            return next();
        }

        // Get the buffer
        const buffer = file.buffer;
        if (!buffer) {
            return res.status(400).json({
                success: false,
                error: 'File upload error: no file content'
            });
        }

        // Validate the file signature
        const validation = validateFileSignature(buffer, file.mimetype);

        if (!validation.valid) {
            return res.status(400).json({
                success: false,
                error: `Invalid file: ${validation.error}`,
                details: {
                    claimedType: file.mimetype,
                    detectedType: validation.detectedType
                }
            });
        }

        // Attach validated type to file object
        file.validatedMimeType = validation.detectedType;

        next();
    };
}

module.exports = {
    validateFileSignature,
    validateUploadedImage,
    ALLOWED_IMAGE_TYPES,
    FILE_SIGNATURES
};
