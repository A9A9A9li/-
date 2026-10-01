const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function getKey() {
  const key = process.env.APP_ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    throw new Error('APP_ENCRYPTION_KEY يجب أن يكون 32 حرفاً على الأقل');
  }
  return Buffer.from(key.slice(0, 32));
}

/**
 * تشفير على مستوى التطبيق للحقول الحساسة (رقم الهوية، سرّ TOTP)
 * قبل إدراجها في قاعدة البيانات — بحيث لا تُقرأ حتى من مسؤول قاعدة البيانات
 * نفسه دون امتلاك هذا المفتاح المنفصل.
 */
function encryptField(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decryptField(payloadB64) {
  const raw = Buffer.from(payloadB64, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

module.exports = { encryptField, decryptField };
