// General Assistant - Projects List
(async function() {
    const authed = await initAuth();
    if (!authed) return;
    renderTopbar();
    renderSidebar("general", "projects");
    loadProjects();
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
