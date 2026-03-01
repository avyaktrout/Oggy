// General Assistant Chat Page
let activeProjectId = null;

const shell = new AgentShell({
    domain: "general",
    label: "General Chat",
    chatEndpoint: "/v0/general/chat",
    trainingEndpoint: "/v0/continuous-learning",
    analyticsPage: "/general-analytics.html",
    observerBasePath: "/v0/general/observer",
    chatPlaceholder: "Ask Oggy anything...",
    welcomeMessage: "Hi! I'm Oggy, your general-purpose assistant. I remember our conversations and learn from them. Ask me anything!",
    baseWelcome: "Hi! I'm the base model without memory. Compare my answers with Oggy's.",
    contextProvider: async () => {
        return activeProjectId ? { project_id: activeProjectId } : {};
    },
    capabilities: {
        training: true,
        comparison: true,
        inquiries: true,
        observer: true,
        audit: true
    }
});

shell.init().then(() => { loadProjectSelector(); });

async function loadProjectSelector() {
    try {
        const data = await apiCall("GET", "/v0/general/projects?user_id=" + USER_ID);
        const select = document.getElementById("project-select");
        if (!select || !data.projects) return;
        select.innerHTML = '<option value="">No project (general)</option>';
        data.projects.forEach(p => {
            const opt = document.createElement("option");
            opt.value = p.project_id;
            opt.textContent = p.name;
            select.appendChild(opt);
        });
    } catch (e) { /* projects endpoint may not be ready */ }
}

window.selectProject = function(projectId) {
    activeProjectId = projectId || null;
    showToast(activeProjectId ? "Project selected" : "No project selected");
};
