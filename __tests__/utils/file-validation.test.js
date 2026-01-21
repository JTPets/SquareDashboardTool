/**
 * Tests for file-validation.js
 * V005 fix: Magic number validation for file uploads
 */

const { validateFileSignature, validateUploadedImage, ALLOWED_IMAGE_TYPES } = require('../../utils/file-validation');

describe('File Validation Utilities', () => {
    describe('validateFileSignature', () => {
        describe('JPEG validation', () => {
            it('should validate JPEG with FFD8FFE0 signature', () => {
                const jpegBuffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]);
                const result = validateFileSignature(jpegBuffer);
                expect(result.valid).toBe(true);
                expect(result.detectedType).toBe('image/jpeg');
                expect(result.error).toBeNull();
            });

            it('should validate JPEG with FFD8FFE1 signature (EXIF)', () => {
                const jpegBuffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x10, 0x45, 0x78]);
                const result = validateFileSignature(jpegBuffer);
                expect(result.valid).toBe(true);
                expect(result.detectedType).toBe('image/jpeg');
            });

            it('should validate JPEG with FFD8FFDB signature', () => {
                const jpegBuffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x10, 0x00, 0x00]);
                const result = validateFileSignature(jpegBuffer);
                expect(result.valid).toBe(true);
                expect(result.detectedType).toBe('image/jpeg');
            });
        });

        describe('PNG validation', () => {
            it('should validate PNG with correct signature', () => {
                const pngBuffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
                const result = validateFileSignature(pngBuffer);
                expect(result.valid).toBe(true);
                expect(result.detectedType).toBe('image/png');
                expect(result.error).toBeNull();
            });
        });

        describe('GIF validation', () => {
            it('should validate GIF89a', () => {
                const gifBuffer = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]);
                const result = validateFileSignature(gifBuffer);
                expect(result.valid).toBe(true);
                expect(result.detectedType).toBe('image/gif');
            });

            it('should validate GIF87a', () => {
                const gifBuffer = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x00, 0x00]);
                const result = validateFileSignature(gifBuffer);
                expect(result.valid).toBe(true);
                expect(result.detectedType).toBe('image/gif');
            });
        });

        describe('WebP validation', () => {
            it('should validate WebP with RIFF header', () => {
                // RIFF....WEBP
                const webpBuffer = Buffer.from([
                    0x52, 0x49, 0x46, 0x46,  // RIFF
                    0x00, 0x00, 0x00, 0x00,  // file size
                    0x57, 0x45, 0x42, 0x50   // WEBP
                ]);
                const result = validateFileSignature(webpBuffer);
                expect(result.valid).toBe(true);
                expect(result.detectedType).toBe('image/webp');
            });
        });

        describe('BMP validation', () => {
            it('should validate BMP with BM signature', () => {
                const bmpBuffer = Buffer.from([0x42, 0x4D, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
                const result = validateFileSignature(bmpBuffer);
                expect(result.valid).toBe(true);
                expect(result.detectedType).toBe('image/bmp');
            });
        });

        describe('TIFF validation', () => {
            it('should validate TIFF little endian', () => {
                const tiffBuffer = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x00, 0x00, 0x00, 0x00]);
                const result = validateFileSignature(tiffBuffer);
                expect(result.valid).toBe(true);
                expect(result.detectedType).toBe('image/tiff');
            });

            it('should validate TIFF big endian', () => {
                const tiffBuffer = Buffer.from([0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x00]);
                const result = validateFileSignature(tiffBuffer);
                expect(result.valid).toBe(true);
                expect(result.detectedType).toBe('image/tiff');
            });
        });

        describe('Invalid files', () => {
            it('should reject empty buffer', () => {
                const result = validateFileSignature(Buffer.from([]));
                expect(result.valid).toBe(false);
                expect(result.error).toBe('File is empty or too small');
            });

            it('should reject null buffer', () => {
                const result = validateFileSignature(null);
                expect(result.valid).toBe(false);
                expect(result.error).toBe('File is empty or too small');
            });

            it('should reject buffer smaller than 4 bytes', () => {
                const result = validateFileSignature(Buffer.from([0x00, 0x01]));
                expect(result.valid).toBe(false);
                expect(result.error).toBe('File is empty or too small');
            });

            it('should reject unrecognized file format', () => {
                // Random bytes that don\'t match any known signature
                const unknownBuffer = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
                const result = validateFileSignature(unknownBuffer);
                expect(result.valid).toBe(false);
                expect(result.error).toMatch(/Unrecognized file format/);
            });

            it('should reject PDF files', () => {
                // PDF signature: %PDF
                const pdfBuffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34]);
                const result = validateFileSignature(pdfBuffer);
                expect(result.valid).toBe(false);
            });

            it('should reject executable files', () => {
                // MZ header for Windows executables
                const exeBuffer = Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
                const result = validateFileSignature(exeBuffer);
                expect(result.valid).toBe(false);
            });

            it('should reject ZIP files', () => {
                // ZIP signature: PK
                const zipBuffer = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
                const result = validateFileSignature(zipBuffer);
                expect(result.valid).toBe(false);
            });
        });

        describe('MIME type matching', () => {
            it('should accept matching MIME type', () => {
                const jpegBuffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]);
                const result = validateFileSignature(jpegBuffer, 'image/jpeg');
                expect(result.valid).toBe(true);
            });

            it('should accept image/jpg as alias for image/jpeg', () => {
                const jpegBuffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]);
                const result = validateFileSignature(jpegBuffer, 'image/jpg');
                expect(result.valid).toBe(true);
            });

            it('should reject mismatched MIME type from non-image', () => {
                const pngBuffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
                const result = validateFileSignature(pngBuffer, 'application/pdf');
                expect(result.valid).toBe(false);
                expect(result.error).toMatch(/MIME type mismatch/);
            });
        });
    });

    describe('validateUploadedImage middleware', () => {
        let mockReq, mockRes, mockNext;

        beforeEach(() => {
            mockReq = {
                file: null,
                files: {}
            };
            mockRes = {
                status: jest.fn().mockReturnThis(),
                json: jest.fn()
            };
            mockNext = jest.fn();
        });

        it('should call next() when no file is uploaded', () => {
            const middleware = validateUploadedImage('photo');
            middleware(mockReq, mockRes, mockNext);
            expect(mockNext).toHaveBeenCalled();
            expect(mockRes.status).not.toHaveBeenCalled();
        });

        it('should call next() for valid JPEG file', () => {
            mockReq.file = {
                buffer: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]),
                mimetype: 'image/jpeg'
            };
            const middleware = validateUploadedImage('photo');
            middleware(mockReq, mockRes, mockNext);
            expect(mockNext).toHaveBeenCalled();
            expect(mockReq.file.validatedMimeType).toBe('image/jpeg');
        });

        it('should call next() for valid PNG file', () => {
            mockReq.file = {
                buffer: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
                mimetype: 'image/png'
            };
            const middleware = validateUploadedImage('photo');
            middleware(mockReq, mockRes, mockNext);
            expect(mockNext).toHaveBeenCalled();
            expect(mockReq.file.validatedMimeType).toBe('image/png');
        });

        it('should reject file without buffer', () => {
            mockReq.file = {
                mimetype: 'image/jpeg'
                // no buffer
            };
            const middleware = validateUploadedImage('photo');
            middleware(mockReq, mockRes, mockNext);
            expect(mockRes.status).toHaveBeenCalledWith(400);
            expect(mockRes.json).toHaveBeenCalledWith({
                success: false,
                error: 'File upload error: no file content'
            });
            expect(mockNext).not.toHaveBeenCalled();
        });

        it('should reject file with invalid signature', () => {
            mockReq.file = {
                buffer: Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
                mimetype: 'image/jpeg'
            };
            const middleware = validateUploadedImage('photo');
            middleware(mockReq, mockRes, mockNext);
            expect(mockRes.status).toHaveBeenCalledWith(400);
            expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                error: expect.stringContaining('Invalid file')
            }));
            expect(mockNext).not.toHaveBeenCalled();
        });

        it('should detect spoofed MIME type', () => {
            // Claiming to be JPEG but actually PNG
            mockReq.file = {
                buffer: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
                mimetype: 'image/jpeg'
            };
            const middleware = validateUploadedImage('photo');
            middleware(mockReq, mockRes, mockNext);
            // This should still succeed because we detected it as a valid PNG
            expect(mockNext).toHaveBeenCalled();
            expect(mockReq.file.validatedMimeType).toBe('image/png');
        });

        it('should work with files in req.files object', () => {
            mockReq.files = {
                photo: {
                    buffer: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]),
                    mimetype: 'image/jpeg'
                }
            };
            const middleware = validateUploadedImage('photo');
            middleware(mockReq, mockRes, mockNext);
            expect(mockNext).toHaveBeenCalled();
        });
    });

    describe('ALLOWED_IMAGE_TYPES', () => {
        it('should include common image types', () => {
            expect(ALLOWED_IMAGE_TYPES).toContain('image/jpeg');
            expect(ALLOWED_IMAGE_TYPES).toContain('image/png');
            expect(ALLOWED_IMAGE_TYPES).toContain('image/gif');
            expect(ALLOWED_IMAGE_TYPES).toContain('image/webp');
        });

        it('should not include non-image types', () => {
            expect(ALLOWED_IMAGE_TYPES).not.toContain('application/pdf');
            expect(ALLOWED_IMAGE_TYPES).not.toContain('application/zip');
            expect(ALLOWED_IMAGE_TYPES).not.toContain('text/html');
        });
    });
});
