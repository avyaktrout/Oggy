// Shared utilities for Oggy Payments UI
const API_BASE = window.location.origin;
let USER_ID = null;
let CSRF_TOKEN = null;
let USER_DISPLAY_NAME = null;
let USER_ROLE = null;

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
        USER_ROLE = data.role || 'user';
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
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
const SIDEBAR_APPS = [
    {
        id: 'payments', label: 'Payments',
        pages: [
            { id: 'enter', label: 'Enter Payment', href: '/' },
            { id: 'view', label: 'View Payments', href: '/payments.html' },
            { id: 'chat', label: 'Chat & Training', href: '/chat.html' },
            { id: 'analytics', label: 'Analytics', href: '/analytics.html' }
        ]
    },
    {
        id: 'general', label: 'General Assistant',
        pages: [
            { id: 'chat', label: 'Chat & Training', href: '/general-chat.html' },
            { id: 'projects', label: 'Projects', href: '/general-projects.html' },
            { id: 'analytics', label: 'Analytics', href: '/general-analytics.html' }
        ]
    },
    {
        id: 'diet', label: 'Diet Agent',
        pages: [
            { id: 'enter', label: 'Enter Food', href: '/diet-enter.html' },
            { id: 'nutrition', label: 'View Nutrition', href: '/diet-nutrition.html' },
            { id: 'chat', label: 'Chat & Training', href: '/diet-chat.html' },
            { id: 'analytics', label: 'Analytics', href: '/diet-analytics.html' }
        ]
    }
];

function renderTopbar() {
    const topbar = document.getElementById('topbar');
    if (!topbar) return;
    topbar.innerHTML = `
        <button class="topbar-hamburger" onclick="toggleSidebar()">&#9776;</button>
        <a href="/" class="topbar-brand">Oggy</a>
        <div class="topbar-right">
            <span id="inquiry-nav-badge" style="display:none;cursor:pointer" onclick="window.location='/chat.html'"
                  title="Oggy has questions for you">
                <span class="inquiry-badge" id="inquiry-count">0</span>
            </span>
            <span class="topbar-user" title="${USER_DISPLAY_NAME || ''}">${USER_DISPLAY_NAME || ''}</span>
            <a href="#" onclick="logout();return false" class="topbar-logout">Sign out</a>
        </div>
    `;
}

function renderSidebar(appName, activePage) {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    let html = '';
    for (const app of SIDEBAR_APPS) {
        const isActive = app.id === appName;
        html += `<div class="sidebar-section">
            <div class="sidebar-section-header ${isActive ? 'active' : ''}" onclick="toggleSidebarSection(this)">
                <span>${app.label}</span>
                <span class="sidebar-arrow">${isActive ? '&#9660;' : '&#9654;'}</span>
            </div>
            <div class="sidebar-section-links ${isActive ? 'expanded' : ''}">
                ${app.pages.map(p => `<a href="${p.href}" class="sidebar-link ${isActive && p.id === activePage ? 'active' : ''}">${p.label}</a>`).join('')}
            </div>
        </div>`;
    }
    html += `<div class="sidebar-divider"></div>
        <a href="/settings.html" class="sidebar-link ${appName === 'settings' ? 'active' : ''}" style="padding-left:16px">Settings</a>`;
    if (USER_ROLE === 'admin') {
        html += `<a href="/admin.html" class="sidebar-link ${appName === 'admin' ? 'active' : ''}" style="padding-left:16px">Admin</a>`;
    }
    sidebar.innerHTML = html;
}

function toggleSidebarSection(header) {
    const links = header.nextElementSibling;
    const arrow = header.querySelector('.sidebar-arrow');
    const isExpanded = links.classList.contains('expanded');
    links.classList.toggle('expanded');
    arrow.innerHTML = isExpanded ? '&#9654;' : '&#9660;';
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (sidebar) sidebar.classList.toggle('open');
    if (overlay) overlay.classList.toggle('show');
}

// Deprecated — kept for backward compatibility
function renderNav(activePage) {
    renderTopbar();
    const map = { enter: 'payments', view: 'payments', chat: 'payments', analytics: 'payments', v2: 'general', v3: 'diet', settings: 'settings', admin: 'admin' };
    const pageMap = { v2: 'chat', v3: 'enter' };
    renderSidebar(map[activePage] || 'payments', pageMap[activePage] || activePage);
}

// --- Inquiry polling (shared across all pages) ---
let _inquiryPollInterval = null;
function startInquiryPolling() {
    checkInquiries();
    _inquiryPollInterval = setInterval(checkInquiries, 15000);
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
