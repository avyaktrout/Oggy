// General Assistant - Projects List
(async function() {
    const authed = await initAuth();
    if (!authed) return;
    renderTopbar();
    renderSidebar("general", "projects");
    loadProjects();
    loadSuggestions();
})();

async function loadProjects() {
    const grid = document.getElementById("projects-grid");
    try {
        const data = await apiCall("GET", "/v0/general/projects?user_id=" + USER_ID);
        if (!data.projects || data.projects.length === 0) {
            grid.innerHTML = '<div style="color:var(--text-muted);font-size:14px;padding:24px;grid-column:1/-1">No projects yet. Create one above to organize conversations.</div>';
            return;
        }
        grid.innerHTML = data.projects.map(p => `
            <div class="card" style="cursor:pointer;transition:border-color 0.15s;position:relative" onclick="window.location='/general-project-detail.html?id=${p.project_id}'"
                 onmouseover="this.style.borderColor='var(--primary)'" onmouseout="this.style.borderColor='var(--border)'">
                <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:4px">
                    <div style="font-weight:600;font-size:16px">${p.name}</div>
                    <div style="display:flex;gap:4px;flex-shrink:0" onclick="event.stopPropagation()">
                        <button onclick="editProject('${p.project_id}','${(p.name || '').replace(/'/g, "\\'")}','${(p.description || '').replace(/'/g, "\\'")}')" title="Edit" style="background:none;border:none;cursor:pointer;font-size:14px;padding:2px 6px;color:var(--text-muted);border-radius:4px" onmouseover="this.style.background='var(--bg-hover)'" onmouseout="this.style.background='none'">&#x270E;</button>
                        <button onclick="deleteProject('${p.project_id}')" title="Delete" style="background:none;border:none;cursor:pointer;font-size:14px;padding:2px 6px;color:var(--text-muted);border-radius:4px" onmouseover="this.style.color='var(--danger)';this.style.background='var(--bg-hover)'" onmouseout="this.style.color='var(--text-muted)';this.style.background='none'">&#x2715;</button>
                    </div>
                </div>
                <div style="font-size:13px;color:var(--text-muted);margin-bottom:8px">${p.description || "No description"}</div>
                <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted)">
                    <span>${p.status || "active"}</span>
                    <span>${p.created_at ? new Date(p.created_at).toLocaleDateString() : ""}</span>
                </div>
            </div>
        `).join("");
    } catch (e) {
        grid.innerHTML = '<div style="color:var(--text-muted);font-size:14px;padding:24px">Failed to load projects</div>';
    }
}

window.createProject = async function() {
    const name = document.getElementById("new-project-name").value.trim();
    if (!name) return;
    const description = document.getElementById("new-project-desc").value.trim();
    try {
        await apiCall("POST", "/v0/general/projects", { user_id: USER_ID, name, description });
        document.getElementById("new-project-name").value = "";
        document.getElementById("new-project-desc").value = "";
        showToast("Project created");
        loadProjects();
    } catch (err) {
        showToast("Failed: " + err.message, "error");
    }
};

window.editProject = function(projectId, currentName, currentDesc) {
    const newName = prompt("Project name:", currentName);
    if (newName === null) return;
    if (!newName.trim()) { showToast("Name cannot be empty", "error"); return; }
    const newDesc = prompt("Description:", currentDesc);
    if (newDesc === null) return;
    apiCall("PUT", "/v0/general/projects/" + projectId, {
        user_id: USER_ID,
        name: newName.trim(),
        description: newDesc.trim()
    }).then(() => {
        showToast("Project updated");
        loadProjects();
    }).catch(err => showToast("Failed: " + err.message, "error"));
};

window.deleteProject = async function(projectId) {
    if (!confirm("Delete this project and all its messages?")) return;
    try {
        await apiCall("DELETE", "/v0/general/projects/" + projectId + "?user_id=" + USER_ID);
        showToast("Project deleted");
        loadProjects();
    } catch (err) {
        showToast("Failed: " + err.message, "error");
    }
};

// --- Suggested Projects ---

async function loadSuggestions() {
    const section = document.getElementById("suggestions-section");
    const grid = document.getElementById("suggestions-grid");
    const btn = document.getElementById("refresh-suggestions-btn");

    section.style.display = "block";
    grid.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px;grid-column:1/-1">Generating suggestions...</div>';
    if (btn) btn.disabled = true;

    try {
        const data = await apiCall("GET", "/v0/general/projects/suggestions?user_id=" + USER_ID);
        const suggestions = data.suggestions || [];
        if (suggestions.length === 0) {
            grid.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px;grid-column:1/-1">No suggestions available.</div>';
            return;
        }
        const esc = (s) => (s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
        grid.innerHTML = suggestions.map(s => `
            <div class="card" style="cursor:pointer;transition:border-color 0.15s;border-left:3px solid var(--accent)"
                 onclick="createFromSuggestion('${esc(s.name)}','${esc(s.description)}')"
                 onmouseover="this.style.borderColor='var(--primary)'" onmouseout="this.style.borderLeftColor='var(--accent)';this.style.borderColor='var(--border)'">
                <div style="font-weight:600;font-size:14px;margin-bottom:4px">${esc(s.name)}</div>
                <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">${esc(s.description)}</div>
                <div style="font-size:11px;color:var(--accent);font-style:italic">${esc(s.reason)}</div>
            </div>
        `).join("");
    } catch (e) {
        grid.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px;grid-column:1/-1">Failed to load suggestions.</div>';
    } finally {
        if (btn) btn.disabled = false;
    }
}

window.createFromSuggestion = async function(name, description) {
    // Decode HTML entities back
    const tmp = document.createElement('textarea');
    tmp.innerHTML = name; const cleanName = tmp.value;
    tmp.innerHTML = description; const cleanDesc = tmp.value;
    try {
        const project = await apiCall("POST", "/v0/general/projects", { user_id: USER_ID, name: cleanName, description: cleanDesc });
        showToast("Project created from suggestion!");
        window.location.href = '/general-project-detail.html?id=' + project.project_id;
    } catch (err) {
        showToast("Failed: " + err.message, "error");
    }
};

window.loadSuggestions = loadSuggestions;
