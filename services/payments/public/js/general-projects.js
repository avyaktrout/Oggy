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
            <div class="card" style="cursor:pointer;transition:border-color 0.15s" onclick="window.location='/general-project-detail.html?id=${p.project_id}'"
                 onmouseover="this.style.borderColor='var(--primary)'" onmouseout="this.style.borderColor='var(--border)'">
                <div style="font-weight:600;font-size:16px;margin-bottom:4px">${p.name}</div>
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
