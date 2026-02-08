// Shared utilities for Oggy Payments UI
const API_BASE = window.location.origin;
let USER_ID = null;
let CSRF_TOKEN = null;
let USER_DISPLAY_NAME = null;

const CATEGORIES = [
    'dining', 'groceries', 'transportation', 'utilities',
    'entertainment', 'business_meal', 'shopping', 'health',
    'personal_care', 'other'
];

// --- Auth initialization ---
async function initAuth() {
    try {
        const res = await fetch(`${API_BASE}/v0/auth/me`, { credentials: 'include' });
        if (!res.ok) {
            // Not authenticated — redirect to login
            if (!window.location.pathname.includes('login.html')) {
                window.location.href = '/login.html';
            }
            return false;
        }
        const data = await res.json();
        USER_ID = data.user_id;
        CSRF_TOKEN = data.csrf_token;
        USER_DISPLAY_NAME = data.display_name || data.user_id;
        return true;
    } catch (e) {
        if (!window.location.pathname.includes('login.html')) {
            window.location.href = '/login.html';
        }
        return false;
    }
}

async function logout() {
    try {
        await fetch(`${API_BASE}/v0/auth/logout`, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': CSRF_TOKEN || ''
            }
        });
    } catch (e) {
        // Proceed to redirect even if request fails
    }
    window.location.href = '/login.html';
}

// --- API helper ---
async function apiCall(method, path, body) {
    const opts = {
        method,
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json'
        }
    };
    if (CSRF_TOKEN) {
        opts.headers['X-CSRF-Token'] = CSRF_TOKEN;
    }
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${API_BASE}${path}`, opts);

    // Handle auth failures
    if (res.status === 401) {
        window.location.href = '/login.html';
        throw new Error('Authentication required');
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
    return data;
}

// --- Formatting ---
function formatCurrency(amount) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('T')[0].split('-');
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatCategory(cat) {
    if (!cat) return '<span class="cat-badge" style="background:#f1f5f9;color:#94a3b8">uncategorized</span>';
    return `<span class="cat-badge">${cat.replace(/_/g, ' ')}</span>`;
}

function todayStr() {
    return new Date().toISOString().split('T')[0];
}

// --- Toast notifications ---
function showToast(message, type = 'success') {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => { toast.remove(); }, 4000);
}

// --- Navigation ---
function renderNav(activePage) {
    const nav = document.getElementById('nav');
    if (!nav) return;
    nav.innerHTML = `
        <a href="/" class="nav-brand">Oggy</a>
        <a href="/" class="${activePage === 'enter' ? 'active' : ''}">Enter Payment</a>
        <a href="/payments.html" class="${activePage === 'view' ? 'active' : ''}">View Payments</a>
        <a href="/chat.html" class="${activePage === 'chat' ? 'active' : ''}">Chat</a>
        <a href="/analytics.html" class="${activePage === 'analytics' ? 'active' : ''}">Analytics</a>
        <div class="nav-right">
            <span id="inquiry-nav-badge" style="display:none;cursor:pointer" onclick="window.location='/chat.html'"
                  title="Oggy has questions for you">
                <span class="inquiry-badge" id="inquiry-count">0</span>
            </span>
            <span class="nav-user" title="${USER_DISPLAY_NAME || ''}">${USER_DISPLAY_NAME || ''}</span>
            <a href="#" onclick="logout();return false" class="nav-logout">Sign out</a>
        </div>
    `;
}

// --- Inquiry polling (shared across all pages) ---
let _inquiryPollInterval = null;
function startInquiryPolling() {
    checkInquiries();
    _inquiryPollInterval = setInterval(checkInquiries, 60000);
}

async function checkInquiries() {
    try {
        const data = await apiCall('GET', `/v0/inquiries/pending?user_id=${USER_ID}`);
        const count = data.count || 0;
        const badge = document.getElementById('inquiry-nav-badge');
        const countEl = document.getElementById('inquiry-count');
        if (badge && countEl) {
            badge.style.display = count > 0 ? 'inline' : 'none';
            countEl.textContent = count;
        }
        // If inquiry widget exists on page, update it
        if (window.updateInquiryWidget) {
            window.updateInquiryWidget(data.inquiries || []);
        }
    } catch (e) {
        // Inquiry system may not be ready yet, ignore
    }
}
