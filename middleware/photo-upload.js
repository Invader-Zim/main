// Parses multipart score reports: the photo arrives as raw bytes in the
// "photo" field (kept in memory as req.file.buffer), other fields in req.body.
// Must run before middleware/postlog.js, which picks up req.file.
// Requests that aren't multipart (e.g. URL-encoded) pass through untouched.

const multer = require('multer')
const { PHOTO_MAX_BYTES } = require('../lib/photos')

const HTTP_BAD_REQUEST = 400
const HTTP_PAYLOAD_TOO_LARGE = 413
const PHOTO_FIELD = 'photo'
const MAX_PHOTOS = 1

const upload = multer({
   storage: multer.memoryStorage(),
   limits: { fileSize: PHOTO_MAX_BYTES, files: MAX_PHOTOS }
}).single(PHOTO_FIELD)


function photoUpload(req, res, next) {
   upload(req, res, function(err) {
      if (!err) return next()
      if (err instanceof multer.MulterError) {
         console.log('photo upload rejected:', err.code)
         if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(HTTP_PAYLOAD_TOO_LARGE).send('The photo is too large to upload.')
         }
         return res.status(HTTP_BAD_REQUEST).send('The photo upload was not accepted (' + err.code + ').')
      }
      next(err)
   })
}

module.exports = photoUpload
