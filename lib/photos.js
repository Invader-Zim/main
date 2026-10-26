// Helpers for uploaded game photos.
//
// Photos are stored in UPLOADS_FOLDER named by the sha1 of their bytes, with no
// extension. New uploads are raw image bytes; older ones are base64 data-URL
// text ("data:image/png;base64,..."). The type is worked out from the first
// bytes of the file.

const PHOTO_MAX_BYTES = 10 * 1024 * 1024

// Enough of the file to recognize any format below.
const PHOTO_HEADER_BYTES = 32

// A stored photo's id: the sha1 of its bytes, which is also its file name.
const PHOTO_ID_PATTERN = /^[0-9a-f]{40}$/

// Told to a page whose photo is no longer the game's newest.
const PHOTO_CHANGED_MESSAGE = "A newer photo was saved for this game. Reload the page to see it."

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

// JPEG header segments, for spotting MPO files.
const JPEG_MARKER = 0xFF
const JPEG_SOS = 0xDA
const JPEG_EOI = 0xD9
const JPEG_APP2 = 0xE2
const MPF_ID = 'MPF\0'

const FORMAT_NAME_MPO = 'MPO'
const FORMAT_NAME_UNKNOWN = 'unrecognized'
const FORMAT_NAMES = {
   [MIME_JPEG]: 'JPEG',
   [MIME_PNG]: 'PNG',
   [MIME_GIF]: 'GIF',
   [MIME_WEBP]: 'WebP',
   [MIME_HEIC]: 'HEIC',
   [MIME_HEIF]: 'HEIF'
}


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


// A JPEG whose header has an APP2 "MPF" segment is an MPO (multi-picture)
// file: the main image with more images appended, e.g. an iPhone HDR gain map.
function isMpo(buf) {
   if (!startsWith(buf, [0xFF, 0xD8])) return false
   let i = 2
   while (i + 4 <= buf.length && buf[i] === JPEG_MARKER) {
      const marker = buf[i + 1]
      if (marker === JPEG_SOS || marker === JPEG_EOI) break
      const length = buf.readUInt16BE(i + 2)
      if (marker === JPEG_APP2 && ascii(buf, i + 4, i + 8) === MPF_ID) return true
      i += 2 + length
   }
   return false
}


// A short, readable name for a photo's format, e.g. "JPEG", "MPO", "HEIC".
function photoFormatName(buf) {
   if (isMpo(buf)) return FORMAT_NAME_MPO
   return FORMAT_NAMES[detectImageType(buf)] || FORMAT_NAME_UNKNOWN
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


// The sha of the game's current (newest) photo, from its /pics/<sha> url.
function currentPhotoSha(game) {
   const photo = game && game.photos && game.photos[0]
   return (photo && photo.url) ? photo.url.split('/').pop() : null
}


module.exports = {
   PHOTO_MAX_BYTES,
   PHOTO_HEADER_BYTES,
   PHOTO_ID_PATTERN,
   PHOTO_CHANGED_MESSAGE,
   currentPhotoSha,
   detectImageType,
   photoFormatName,
   isDataUrl,
   decodeDataUrl
}
