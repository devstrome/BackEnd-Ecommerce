const multer = require('multer');
const cloudinary = require('./coudinaryconfig')
const { createCloudinaryStorage } = require('../utils/cloudinaryMulterStorage');

const storage = createCloudinaryStorage(cloudinary, {
  folder: 'BackEnd-Test',
  allowedFormats: ['jpg', 'jpeg', 'png', 'webp', 'heic'],
});

// Cloudinary streams uploads, while Multer enforces a per-file ceiling before
// oversized requests can consume provider bandwidth or application resources.
const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);
const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 51,
    fields: 100,
    parts: 151,
  },
  fileFilter(_req, file, callback) {
    if (!allowedImageTypes.has(String(file.mimetype || '').toLowerCase())) {
      const error = new Error('Only JPEG, PNG, WebP, and HEIC image uploads are accepted');
      error.status = 415;
      return callback(error);
    }
    return callback(null, true);
  },
});


module.exports = upload;
