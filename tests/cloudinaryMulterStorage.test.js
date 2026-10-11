const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Readable } = require('node:stream');
const { createCloudinaryStorage } = require('../utils/cloudinaryMulterStorage');

test('Cloudinary Multer storage returns the URL and public ID consumed by current controllers', async () => {
  let receivedOptions;
  const cloudinary = {
    uploader: {
      upload_stream(options, callback) {
        receivedOptions = options;
        const stream = new PassThrough();
        stream.on('finish', () => callback(null, {
          public_id: 'catalog/test-image',
          secure_url: 'https://res.cloudinary.com/example/image/upload/test.jpg',
          bytes: 123,
        }));
        return stream;
      },
      destroy(_publicId, callback) { callback(null, { result: 'ok' }); },
    },
  };
  const storage = createCloudinaryStorage(cloudinary, { folder: 'catalog', allowedFormats: ['JPG', '.webp', 'jpg'] });
  const file = { stream: Readable.from(Buffer.from('image bytes')) };

  const storedFile = await new Promise((resolve, reject) => {
    storage._handleFile({}, file, (error, result) => error ? reject(error) : resolve(result));
  });

  assert.deepEqual(receivedOptions, { folder: 'catalog', allowed_formats: ['jpg', 'webp'], resource_type: 'image' });
  assert.equal(storedFile.path, 'https://res.cloudinary.com/example/image/upload/test.jpg');
  assert.equal(storedFile.filename, 'catalog/test-image');
  assert.equal(storedFile.size, 123);
});

test('Cloudinary Multer storage removes files by their public ID', async () => {
  let removedId;
  const cloudinary = { uploader: {
    upload_stream() { return new PassThrough(); },
    destroy(id, callback) { removedId = id; callback(null); },
  } };
  const storage = createCloudinaryStorage(cloudinary);
  await new Promise((resolve, reject) => {
    storage._removeFile({}, { filename: 'catalog/remove-me' }, (error) => error ? reject(error) : resolve());
  });
  assert.equal(removedId, 'catalog/remove-me');
});
