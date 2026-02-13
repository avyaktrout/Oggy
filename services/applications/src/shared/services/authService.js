/**
 * Auth Service - Magic link email authentication
 * Private Domain Hosting v0.1
 *
 * - Invite-only allowlist
 * - Magic link tokens (6 hour expiry)
 * - Session cookies (7 day expiry)
 * - CSRF protection
 * - Rate limiting (5 attempts/hour)
 */

const crypto = require('crypto');
const { query } = require('../utils/db');
const logger = require('../utils/logger');

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_HOURS = 1;
const TOKEN_EXPIRY_MINUTES = 360; // 6 hours
const SESSION_EXPIRY_DAYS = 7;

class AuthService {
    constructor() {
        this._cleanupInterval = null;
        this._transporter = null;
    }

    /**
     * Get or create a reusable SMTP transporter (singleton).
     */
    _getTransporter() {
        if (!this._transporter) {
            const nodemailer = require('nodemailer');
            this._transporter = nodemailer.createTransport({
                host: process.env.SMTP_HOST,
                port: parseInt(process.env.SMTP_PORT || '587'),
                secure: process.env.SMTP_SECURE === 'true',
                auth: {
                    user: process.env.SMTP_USER,
                    pass: process.env.SMTP_PASS
                }
            });
        }
        return this._transporter;
    }

    /**
     * Check if an email is on the allowlist.
     */
    async isEmailAllowed(email) {
        const result = await query(
            'SELECT email, display_name, role FROM auth_allowed_emails WHERE LOWER(email) = LOWER($1)',
            [email]
        );
        return result.rows.length > 0 ? result.rows[0] : null;
    }

    /**
     * Add an email to the allowlist.
     */
    async addAllowedEmail(email, displayName = null, role = 'user') {
        await query(
            `INSERT INTO auth_allowed_emails (email, display_name, role)
             VALUES (LOWER($1), $2, $3)
             ON CONFLICT (email) DO UPDATE SET
               display_name = COALESCE($2, auth_allowed_emails.display_name),
               role = $3`,
            [email, displayName, role]
        );
    }

    /**
     * Check rate limit for magic link requests.
     */
    async _checkRateLimit(email, ip) {
        const result = await query(
            `SELECT COUNT(*) as count FROM auth_rate_limits
             WHERE (email = LOWER($1) OR ip_address = $2)
             AND attempt_at > now() - INTERVAL '${RATE_LIMIT_WINDOW_HOURS} hours'`,
            [email, ip]
        );
        return parseInt(result.rows[0].count) < RATE_LIMIT_MAX;
    }

    async _recordAttempt(email, ip) {
        await query(
            'INSERT INTO auth_rate_limits (email, ip_address) VALUES (LOWER($1), $2)',
            [email, ip]
        );
    }

    /**
     * Create a magic link token for an email.
     * Returns the raw token (to send in email/log).
     */
    async createMagicLink(email, ip) {
        // Check allowlist
        const allowed = await this.isEmailAllowed(email);
        if (!allowed) {
            return { error: 'email_not_allowed' };
        }

        // Generate token
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

        await query(
            `INSERT INTO auth_magic_links (email, token_hash, ip_address)
             VALUES (LOWER($1), $2, $3)`,
            [email, tokenHash, ip]
        );

        logger.info('Magic link created', { email, ip });
        return { token: rawToken, email: email.toLowerCase() };
    }

    /**
     * Check if a magic link token is still valid (without consuming it).
     * Used by GET /verify to show the sign-in page vs expired page.
     */
    async checkMagicLinkValid(token) {
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const result = await query(
            `SELECT 1 FROM auth_magic_links
             WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
            [tokenHash]
        );
        return result.rows.length > 0;
    }

    /**
     * Verify a magic link token and create a session.
     * Returns session info or error.
     */
    async verifyMagicLink(token, ip) {
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

        // Atomically mark as used
        const result = await query(
            `UPDATE auth_magic_links
             SET used_at = now()
             WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
             RETURNING email`,
            [tokenHash]
        );

        if (result.rows.length === 0) {
            return { error: 'invalid_or_expired_token' };
        }

        const email = result.rows[0].email;

        // Derive user_id from email (use the part before @ as user_id)
        const userId = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '_');

        // Initialize tenant data on first login (idempotent)
        await this.initializeTenant(userId);

        // Create session
        const session = await this.createSession(userId, email, ip);
        return { ...session, email };
    }

    /**
     * Create a new session for a user.
     */
    async createSession(userId, email, ip) {
        const sessionToken = crypto.randomBytes(32).toString('hex');
        const sessionTokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
        const csrfToken = crypto.randomBytes(24).toString('hex');

        await query(
            `INSERT INTO auth_sessions (user_id, session_token_hash, csrf_token, ip_address)
             VALUES ($1, $2, $3, $4)`,
            [userId, sessionTokenHash, csrfToken, ip]
        );

        logger.info('Session created', { user_id: userId, ip });
        return { session_token: sessionToken, csrf_token: csrfToken, user_id: userId };
    }

    /**
     * Validate a session token.
     * Returns user info or null.
     */
    async validateSession(sessionToken) {
        if (!sessionToken) return null;

        const sessionTokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');

        const result = await query(
            `SELECT session_id, user_id, csrf_token, expires_at
             FROM auth_sessions
             WHERE session_token_hash = $1 AND expires_at > now()`,
            [sessionTokenHash]
        );

        if (result.rows.length === 0) return null;

        const session = result.rows[0];

        // Update last_active
        await query(
            'UPDATE auth_sessions SET last_active_at = now() WHERE session_id = $1',
            [session.session_id]
        );

        // Look up display name and role
        const emailResult = await query(
            'SELECT email, display_name, role FROM auth_allowed_emails WHERE LOWER(email) LIKE $1',
            [`${session.user_id}@%`]
        );

        return {
            user_id: session.user_id,
            csrf_token: session.csrf_token,
            display_name: emailResult.rows[0]?.display_name || session.user_id,
            email: emailResult.rows[0]?.email || null,
            role: emailResult.rows[0]?.role || 'user'
        };
    }

    /**
     * Destroy a session.
     */
    async destroySession(sessionToken) {
        if (!sessionToken) return;

        const sessionTokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
        await query(
            'DELETE FROM auth_sessions WHERE session_token_hash = $1',
            [sessionTokenHash]
        );
    }

    /**
     * Send magic link email (or log it in dev mode).
     */
    async sendMagicLinkEmail(email, token, baseUrl) {
        const magicUrl = `${baseUrl}/v0/auth/verify?token=${token}`;

        // In dev mode, log the URL for easy testing
        const isDev = !process.env.NODE_ENV || process.env.NODE_ENV === 'development';
        if (isDev) {
            logger.info('=== MAGIC LINK (dev mode) ===', {
                email,
                url: magicUrl
            });
            console.log(`\n  Magic Link for ${email}:\n  ${magicUrl}\n`);
            return { sent: false, dev_mode: true, url: magicUrl };
        }

        // Production: use nodemailer
        try {
            if (!process.env.SMTP_HOST) {
                logger.warn('SMTP not configured, falling back to console', { email });
                console.log(`\n  Magic Link for ${email} (no SMTP):\n  ${magicUrl}\n`);
                return { sent: false, error: 'SMTP not configured', url: magicUrl };
            }

            const transporter = this._getTransporter();

            await transporter.sendMail({
                from: process.env.SMTP_FROM || 'Oggy <noreply@oggy.app>',
                to: email,
                subject: 'Your Oggy Login Link',
                html: `
                    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 20px">
                        <h2 style="color:#1a1a2e">Sign in to Oggy</h2>
                        <p>Click the button below to sign in. This link expires in ${TOKEN_EXPIRY_MINUTES >= 60 ? (TOKEN_EXPIRY_MINUTES / 60) + ' hours' : TOKEN_EXPIRY_MINUTES + ' minutes'}.</p>
                        <a href="${magicUrl}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0">Sign In</a>
                        <p style="color:#888;font-size:13px">If you didn't request this link, you can safely ignore this email.</p>
                    </div>
                `
            });

            logger.info('Magic link email sent', { email });
            return { sent: true };
        } catch (err) {
            logger.error('Failed to send magic link email', { error: err.message, email });
            // Fallback: log the URL
            console.log(`\n  Magic Link for ${email} (email failed):\n  ${magicUrl}\n`);
            return { sent: false, error: err.message, url: magicUrl };
        }
    }

    /**
     * Cleanup expired tokens and sessions.
     */
    async cleanup() {
        try {
            const tokens = await query(
                'DELETE FROM auth_magic_links WHERE expires_at < now() OR used_at IS NOT NULL RETURNING token_id'
            );
            const sessions = await query(
                'DELETE FROM auth_sessions WHERE expires_at < now() RETURNING session_id'
            );
            const rateRecords = await query(
                `DELETE FROM auth_rate_limits WHERE attempt_at < now() - INTERVAL '${RATE_LIMIT_WINDOW_HOURS * 2} hours' RETURNING id`
            );

            if (tokens.rows.length > 0 || sessions.rows.length > 0) {
                logger.info('Auth cleanup completed', {
                    tokens_cleaned: tokens.rows.length,
                    sessions_cleaned: sessions.rows.length,
                    rate_records_cleaned: rateRecords.rows.length
                });
            }
        } catch (err) {
            logger.warn('Auth cleanup failed', { error: err.message });
        }
    }

    /**
     * Start periodic cleanup.
     */
    startCleanup() {
        this.cleanup(); // Run immediately
        this._cleanupInterval = setInterval(() => this.cleanup(), 3600000); // Every hour
    }

    stopCleanup() {
        if (this._cleanupInterval) {
            clearInterval(this._cleanupInterval);
            this._cleanupInterval = null;
        }
    }

    /**
     * Initialize tenant data for a new user (idempotent).
     * Called on first login — gives each tenant their own fresh Oggy at S1 L1.
     */
    async initializeTenant(userId) {
        try {
            await query(
                `INSERT INTO oggy_inquiry_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
                [userId]
            );
            await query(
                `INSERT INTO observer_tenant_config (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
                [userId]
            );
            await query(
                `INSERT INTO continuous_learning_state (user_id, scale, difficulty_level)
                 VALUES ($1, 1, 1) ON CONFLICT DO NOTHING`,
                [userId]
            );
            logger.info('Tenant initialized', { user_id: userId });
        } catch (err) {
            logger.warn('Tenant initialization partial failure', { user_id: userId, error: err.message });
        }
    }

    /**
     * Seed admin email on startup.
     */
    async seedAdminEmail() {
        const adminEmail = process.env.ADMIN_EMAIL;
        if (adminEmail) {
            await this.addAllowedEmail(adminEmail, 'Admin', 'admin');
            logger.info('Admin email seeded', { email: adminEmail });
        }
    }
}

module.exports = new AuthService();
