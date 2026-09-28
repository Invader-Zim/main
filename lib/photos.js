// Helpers for uploaded game photos.
//
// Photos are stored in UPLOADS_FOLDER named by the sha1 of their bytes, with no
// extension. New uploads are raw image bytes; older ones are base64 data-URL
// text ("data:image/png;base64,..."). The type is worked out from the first
// bytes of the file.

const PHOTO_MAX_BYTES = 10 * 1024 * 1024

// Enough of the file to recognize any format below.
const PHOTO_HEADER_BYTES = 32

const DATA_URL_PREFIX = 'data:'
const DATA_URL_PATTERN = /^data:([^;,]+)?(;base64)?,/

const MIME_JPEG = 'image/jpeg'
const MIME_PNG = 'image/png'
const MIME_GIF = 'image/gif'
const MIME_WEBP = 'image/webp'
const MIME_HEIC = 'image/heic'
const MIME_HEIF = 'image/heif'

// ISO base media "ftyp" box: size (4 bytes), "ftyp", then the major brand.
const FTYP_OFFSET = 4
const FTYP_BRAND_OFFSET = 8
const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs']
const HEIF_BRANDS = ['mif1', 'msf1']

// RIFF container: "RIFF", size (4 bytes), then the form type.
const RIFF_FORM_OFFSET = 8


function startsWith(buf, bytes, offset) {
   offset = offset || 0
   if (buf.length < offset + bytes.length) return false
   for (let i = 0; i < bytes.length; i++) {
      if (buf[offset + i] !== bytes[i]) return false
   }
   return true
}


function ascii(buf, start, end) {
   return buf.slice(start, end).toString('latin1')
}


// MIME type of an image from its first bytes, or null if unrecognized.
function detectImageType(buf) {
   if (!buf) return null
   if (startsWith(buf, [0xFF, 0xD8, 0xFF])) return MIME_JPEG
   if (startsWith(buf, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return MIME_PNG
   if (ascii(buf, 0, 4) === 'GIF8') return MIME_GIF
   if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, RIFF_FORM_OFFSET, RIFF_FORM_OFFSET + 4) === 'WEBP') return MIME_WEBP
   if (ascii(buf, FTYP_OFFSET, FTYP_OFFSET + 4) === 'ftyp') {
      const brand = ascii(buf, FTYP_BRAND_OFFSET, FTYP_BRAND_OFFSET + 4)
      if (HEIC_BRANDS.includes(brand)) return MIME_HEIC
      if (HEIF_BRANDS.includes(brand)) return MIME_HEIF
   }
   return null
}


// True if the bytes (or string) look like a data URL, i.e. a legacy upload.
function isDataUrl(bufOrText) {
   if (typeof bufOrText === 'string') return bufOrText.startsWith(DATA_URL_PREFIX)
   return !!bufOrText && ascii(bufOrText, 0, DATA_URL_PREFIX.length) === DATA_URL_PREFIX
}


// Decode "data:<mime>;base64,<data>" into its bytes. Returns null if malformed.
function decodeDataUrl(text) {
   const match = DATA_URL_PATTERN.exec(text)
   if (!match || !match[2]) return null
   const buffer = Buffer.from(text.slice(match[0].length), 'base64')
   return { mime: match[1] || null, buffer }
}


module.exports = {
   PHOTO_MAX_BYTES,
   PHOTO_HEADER_BYTES,
   detectImageType,
   isDataUrl,
   decodeDataUrl
}
