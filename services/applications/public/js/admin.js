(async function() {
    const ok = await initAuth();
    if (!ok) return;
    renderNav('admin');
    startInquiryPolling();
    loadUsers();
})();

async function loadUsers() {
    const loading = document.getElementById('users-loading');
    const table = document.getElementById('users-table');
    const empty = document.getElementById('users-empty');
    const body = document.getElementById('users-body');

    try {
        const data = await apiCall('GET', '/v0/auth/users');
        const users = data.users || [];

        loading.style.display = 'none';

        if (users.length === 0) {
            empty.style.display = 'block';
            return;
        }

        table.style.display = 'table';
        body.innerHTML = users.map(u => {
            const isSelf = u.email && USER_ID && u.email.split('@')[0].toLowerCase() === USER_ID;
            const added = u.created_at ? new Date(u.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '-';
            const roleBadge = u.role === 'admin'
                ? '<span class="role-badge role-admin">Admin</span>'
                : '<span class="role-badge role-user">User</span>';

            return `<tr>
                <td>${escHtml(u.email)}</td>
                <td>${escHtml(u.display_name || '-')}</td>
                <td>${roleBadge}</td>
                <td>${added}</td>
                <td class="admin-actions">
                    <button class="btn-icon" onclick="openEditModal('${escAttr(u.email)}','${escAttr(u.display_name || '')}','${escAttr(u.role || 'user')}')" title="Edit">&#9998;</button>
                    ${isSelf ? '' : `<button class="btn-icon btn-icon-danger" onclick="removeUser('${escAttr(u.email)}')" title="Remove">&#10005;</button>`}
                </td>
            </tr>`;
        }).join('');
    } catch (e) {
        loading.textContent = 'Failed to load users: ' + e.message;
    }
}

async function addUser() {
    const email = document.getElementById('add-email').value.trim();
    const displayName = document.getElementById('add-display-name').value.trim();
    const role = document.getElementById('add-role').value;
    const status = document.getElementById('add-status');

    if (!email) {
        showStatus(status, 'Email is required.', 'error');
        return;
    }

    try {
        await apiCall('POST', '/v0/auth/add-user', {
            email,
            display_name: displayName || null,
            role
        });
        showStatus(status, `Added ${email} as ${role}.`, 'success');
        document.getElementById('add-email').value = '';
        document.getElementById('add-display-name').value = '';
        document.getElementById('add-role').value = 'user';
        loadUsers();
    } catch (e) {
        showStatus(status, e.message, 'error');
    }
}

function openEditModal(email, displayName, role) {
    document.getElementById('edit-email').value = email;
    document.getElementById('edit-email-display').textContent = email;
    document.getElementById('edit-display-name').value = displayName;
    document.getElementById('edit-role').value = role;
    document.getElementById('edit-modal').style.display = 'flex';
}

function closeEditModal() {
    document.getElementById('edit-modal').style.display = 'none';
}

async function saveEdit() {
    const email = document.getElementById('edit-email').value;
    const displayName = document.getElementById('edit-display-name').value.trim();
    const role = document.getElementById('edit-role').value;

    try {
        await apiCall('PUT', '/v0/auth/update-user', {
            email,
            display_name: displayName || null,
            role
        });
        closeEditModal();
        showToast('User updated.');
        loadUsers();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function removeUser(email) {
    if (!confirm(`Remove ${email} from the allowlist? They won't be able to log in anymore.`)) return;

    try {
        await apiCall('DELETE', '/v0/auth/remove-user', { email });
        showToast(`Removed ${email}.`);
        loadUsers();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

function showStatus(el, msg, type) {
    el.style.display = 'block';
    el.textContent = msg;
    el.className = 'admin-status admin-status-' + type;
    setTimeout(() => { el.style.display = 'none'; }, 4000);
}

function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function escAttr(s) {
    return (s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
