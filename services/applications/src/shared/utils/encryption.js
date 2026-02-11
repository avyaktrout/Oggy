/**
 * AES-256-GCM encryption for API keys at rest.
 * Format: iv:tag:ciphertext (all hex)
 * Uses ENCRYPTION_KEY env var (32-byte hex string = 64 hex chars).
 */

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function _getKey() {
    const keyHex = process.env.ENCRYPTION_KEY;
    if (!keyHex || keyHex.length !== 64) {
        throw new Error('ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
    }
    return Buffer.from(keyHex, 'hex');
}

/**
 * Encrypt plaintext string → "iv:tag:ciphertext" (hex)
 */
function encrypt(plaintext) {
    const key = _getKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt "iv:tag:ciphertext" (hex) → plaintext string
 */
function decrypt(encryptedStr) {
    const key = _getKey();
    const parts = encryptedStr.split(':');
    if (parts.length !== 3) throw new Error('Invalid encrypted format');

    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const ciphertext = parts[2];

    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

/**
 * Get last 4 characters of a key for display hint.
 */
function keyHint(apiKey) {
    if (!apiKey || apiKey.length < 4) return '****';
    return '...' + apiKey.slice(-4);
}

module.exports = { encrypt, decrypt, keyHint };
