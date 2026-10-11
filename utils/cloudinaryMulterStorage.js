'use strict';

const DEFAULT_ALLOWED_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'heic'];

/**
 * Multer storage adapter for Cloudinary's upload_stream API. The returned file
 * keeps the path/filename fields used by the existing controllers.
 */
function createCloudinaryStorage(cloudinary, { folder = 'BackEnd-Test', allowedFormats = DEFAULT_ALLOWED_FORMATS } = {}) {
  if (!cloudinary?.uploader || typeof cloudinary.uploader.upload_stream !== 'function') {
    throw new TypeError('A configured Cloudinary uploader is required');
  }

  const formats = [...new Set(allowedFormats.map((format) => String(format).toLowerCase().replace(/^\./, '')))];

  return {
    _handleFile(_req, file, callback) {
      let completed = false;
      const finish = (error, result) => {
        if (completed) return;
        completed = true;
        if (error) return callback(error);
        if (!result?.secure_url && !result?.url) {
          return callback(new Error('Cloudinary did not return an image URL'));
        }
        return callback(null, {
          filename: result.public_id,
          path: result.secure_url || result.url,
          size: result.bytes,
          cloudinary: result,
        });
      };

      let uploadStream;
      try {
        uploadStream = cloudinary.uploader.upload_stream({
          folder,
          allowed_formats: formats,
          resource_type: 'image',
        }, finish);
      } catch (error) {
        finish(error);
        return;
      }

      uploadStream.once('error', (error) => finish(error));
      file.stream.once('error', (error) => uploadStream.destroy(error));
      file.stream.pipe(uploadStream);
    },

    _removeFile(_req, file, callback) {
      if (!file.filename) return callback(null);
      cloudinary.uploader.destroy(file.filename, (error) => callback(error || null));
    },
  };
}

module.exports = { createCloudinaryStorage };
