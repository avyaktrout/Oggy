/**
 * Auth Routes - Magic link login, session management
 * Private Domain Hosting v0.1
 */

const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const { parseCookies } = require('../middleware/auth');
const logger = require('../utils/logger');

// POST /v0/auth/demo-login
router.post('/demo-login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

    if (username !== 'Demo_Oggy' || password !== 'welcomeToOggy') {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    try {
        const demoEmail = 'demo_oggy@oggy-v1.com';
        const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';

        // Ensure demo user is in the allowlist
        const existing = await authService.isEmailAllowed(demoEmail);
        if (!existing) {
            await authService.addAllowedEmail(demoEmail, 'Demo User', 'user');
        }

        const userId = 'demo_oggy';
        const session = await authService.createSession(userId, demoEmail, ip);
        await authService.initializeTenant(userId, demoEmail).catch(() => {});

        const cookieOpts = [
            `oggy_session=${session.session_token}`,
            'Path=/',
            'HttpOnly',
            'SameSite=Lax',
            `Max-Age=${7 * 24 * 60 * 60}`
        ];
        if (req.protocol === 'https' || process.env.NODE_ENV === 'production') {
            cookieOpts.push('Secure');
        }
        res.setHeader('Set-Cookie', cookieOpts.join('; '));
        res.json({ success: true });
    } catch (error) {
        logger.logError(error, { operation: 'demo-login', requestId: req.requestId });
        res.status(500).json({ error: 'Login failed' });
    }
});

// POST /v0/auth/request-magic-link
router.post('/request-magic-link', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    try {
        const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';

        // Quick login: if this email was verified via magic link within the past 6 hours,
        // skip sending a new email and create a session directly
        const quickResult = await authService.quickLogin(email, ip);
        if (quickResult.auto_login) {
            // Set session cookie
            const cookieOpts = [
                `oggy_session=${quickResult.session_token}`,
                'Path=/',
                'HttpOnly',
                'SameSite=Lax',
                `Max-Age=${7 * 24 * 60 * 60}`
            ];
            if (req.protocol === 'https' || process.env.NODE_ENV === 'production') {
                cookieOpts.push('Secure');
            }
            res.setHeader('Set-Cookie', cookieOpts.join('; '));
            return res.json({ auto_login: true, message: 'Signed in automatically.' });
        }

        // Normal flow: generate and send magic link
        const result = await authService.createMagicLink(email, ip);

        if (result.error === 'email_not_allowed') {
            // Don't reveal whether email is in the list (security)
            return res.json({ message: 'If this email is registered, a login link has been sent.' });
        }
        if (result.error === 'rate_limited') {
            return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
        }

        // Send email (or log in dev mode)
        const proto = req.get('x-forwarded-proto') || req.protocol;
        const baseUrl = `${proto}://${req.get('host')}`;
        const sendResult = await authService.sendMagicLinkEmail(email, result.token, baseUrl);

        res.json({
            message: 'If this email is registered, a login link has been sent.',
            // In dev mode or if email failed, include the URL for easy testing
            ...(sendResult.url ? { dev_url: sendResult.url } : {})
        });
    } catch (error) {
        logger.logError(error, { operation: 'request-magic-link', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to process login request' });
    }
});

// GET /v0/auth/verify?token=xxx — landing page (safe for email prefetchers)
router.get('/verify', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send('Missing token');

    // Check if token is still valid WITHOUT consuming it
    const valid = await authService.checkMagicLinkValid(token);

    if (!valid) {
        return res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Oggy - Login</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f8fafc}
  .card{background:#fff;border-radius:16px;padding:40px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:400px;width:90%}
  h2{color:#1e293b;margin-bottom:8px}
  p{color:#64748b;margin-bottom:24px}
  a{display:inline-block;padding:12px 32px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:8px;font-weight:600}
  a:hover{background:#2563eb}
</style></head><body><div class="card">
  <h2>Link Expired</h2>
  <p>This login link has expired or already been used.</p>
  <a href="/login.html">Request a New Link</a>
</div></body></html>`);
    }

    // Show sign-in button — token is only consumed when the button is clicked (POST)
    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Oggy - Sign In</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f8fafc}
  .card{background:#fff;border-radius:16px;padding:40px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:400px;width:90%}
  h2{color:#1e293b;margin-bottom:8px}
  p{color:#64748b;margin-bottom:24px}
  button{padding:14px 40px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;width:100%}
  button:hover{background:#2563eb}
  button:disabled{background:#94a3b8;cursor:not-allowed}
  .error{color:#ef4444;margin-top:16px;display:none}
</style></head><body><div class="card">
  <h2>Welcome to Oggy</h2>
  <p>Tap the button below to sign in.</p>
  <button id="btn" onclick="signIn()">Sign In</button>
  <p class="error" id="err"></p>
</div>
<script>
async function signIn(){
  var btn=document.getElementById('btn'),err=document.getElementById('err');
  btn.disabled=true;btn.textContent='Signing in...';err.style.display='none';
  try{
    var r=await fetch('/v0/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'${token}'}),credentials:'include'});
    if(r.ok){window.location.href='/';}
    else{var d=await r.json();err.textContent=d.error||'Login failed';err.style.display='block';btn.disabled=false;btn.textContent='Sign In';}
  }catch(e){err.textContent='Network error. Please try again.';err.style.display='block';btn.disabled=false;btn.textContent='Sign In';}
}
</script></body></html>`);
});

// POST /v0/auth/verify — actually consume token and set cookie
router.post('/verify', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    try {
        const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
        const result = await authService.verifyMagicLink(token, ip);

        if (result.error) {
            return res.status(400).json({ error: 'Link expired or already used. Please request a new one.' });
        }

        // Set session cookie
        const cookieOpts = [
            `oggy_session=${result.session_token}`,
            'Path=/',
            'HttpOnly',
            'SameSite=Lax',
            `Max-Age=${7 * 24 * 60 * 60}` // 7 days
        ];

        if (req.protocol === 'https' || process.env.NODE_ENV === 'production') {
            cookieOpts.push('Secure');
        }

        res.setHeader('Set-Cookie', cookieOpts.join('; '));
        res.json({ success: true });
    } catch (error) {
        logger.logError(error, { operation: 'verify-magic-link', requestId: req.requestId });
        res.status(500).json({ error: 'Verification failed' });
    }
});

// POST /v0/auth/logout
router.post('/logout', async (req, res) => {
    try {
        const cookies = parseCookies(req);
        const sessionToken = cookies['oggy_session'];
        if (sessionToken) {
            await authService.destroySession(sessionToken);
        }

        // Clear cookie
        res.setHeader('Set-Cookie', 'oggy_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
        res.json({ success: true });
    } catch (error) {
        logger.logError(error, { operation: 'logout', requestId: req.requestId });
        res.status(500).json({ error: 'Logout failed' });
    }
});

// GET /v0/auth/me
router.get('/me', async (req, res) => {
    try {
        const cookies = parseCookies(req);
        const sessionToken = cookies['oggy_session'];

        if (!sessionToken) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const session = await authService.validateSession(sessionToken);
        if (!session) {
            return res.status(401).json({ error: 'Session expired' });
        }

        res.json({
            user_id: session.user_id,
            csrf_token: session.csrf_token,
            display_name: session.display_name,
            email: session.email,
            role: session.role || 'user'
        });
    } catch (error) {
        logger.logError(error, { operation: 'auth-me', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to get user info' });
    }
});

// --- Admin-only helper ---
async function requireAdmin(req, res) {
    const cookies = parseCookies(req);
    const sessionToken = cookies['oggy_session'];
    if (!sessionToken) { res.status(401).json({ error: 'Not authenticated' }); return null; }

    const session = await authService.validateSession(sessionToken);
    if (!session) { res.status(401).json({ error: 'Session expired' }); return null; }
    if (session.role !== 'admin') { res.status(403).json({ error: 'Admin access required' }); return null; }
    return session;
}

// POST /v0/auth/add-user (admin only)
router.post('/add-user', async (req, res) => {
    try {
        const session = await requireAdmin(req, res);
        if (!session) return;

        const { email, display_name, role } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required' });

        const validRoles = ['user', 'admin'];
        const userRole = validRoles.includes(role) ? role : 'user';

        await authService.addAllowedEmail(email, display_name, userRole);
        res.json({ success: true, email, role: userRole });
    } catch (error) {
        logger.logError(error, { operation: 'add-user', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to add user' });
    }
});

// GET /v0/auth/users (admin only)
router.get('/users', async (req, res) => {
    try {
        const session = await requireAdmin(req, res);
        if (!session) return;

        const { query: dbQuery } = require('../utils/db');
        const result = await dbQuery(
            'SELECT email, display_name, role, created_at FROM auth_allowed_emails ORDER BY created_at ASC'
        );
        res.json({ users: result.rows });
    } catch (error) {
        logger.logError(error, { operation: 'list-users', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to list users' });
    }
});

// PUT /v0/auth/update-user (admin only)
router.put('/update-user', async (req, res) => {
    try {
        const session = await requireAdmin(req, res);
        if (!session) return;

        const { email, display_name, role } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required' });

        const validRoles = ['user', 'admin'];
        const { query: dbQuery } = require('../utils/db');

        const updates = [];
        const params = [email];
        let paramIdx = 2;

        if (display_name !== undefined) {
            updates.push(`display_name = $${paramIdx++}`);
            params.push(display_name);
        }
        if (role && validRoles.includes(role)) {
            updates.push(`role = $${paramIdx++}`);
            params.push(role);
        }

        if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

        await dbQuery(
            `UPDATE auth_allowed_emails SET ${updates.join(', ')} WHERE LOWER(email) = LOWER($1)`,
            params
        );
        res.json({ success: true, email });
    } catch (error) {
        logger.logError(error, { operation: 'update-user', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to update user' });
    }
});

// DELETE /v0/auth/remove-user (admin only)
router.delete('/remove-user', async (req, res) => {
    try {
        const session = await requireAdmin(req, res);
        if (!session) return;

        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required' });

        // Prevent removing yourself
        if (session.email && session.email.toLowerCase() === email.toLowerCase()) {
            return res.status(400).json({ error: 'Cannot remove your own account' });
        }

        const { query: dbQuery } = require('../utils/db');
        const result = await dbQuery(
            'DELETE FROM auth_allowed_emails WHERE LOWER(email) = LOWER($1) RETURNING email',
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({ success: true, email });
    } catch (error) {
        logger.logError(error, { operation: 'remove-user', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to remove user' });
    }
});

module.exports = router;
