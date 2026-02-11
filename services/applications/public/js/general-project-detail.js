// General Assistant - Project Detail
const projectId = new URLSearchParams(window.location.search).get("id");

if (!projectId) {
    window.location.href = "/general-projects.html";
}

let projectData = null;

const shell = new AgentShell({
    domain: "general",
    label: "Project Chat",
    chatEndpoint: "/v0/general/chat",
    trainingEndpoint: "/v0/continuous-learning",
    chatPlaceholder: "Ask about this project...",
    welcomeMessage: "Hi! Ask me anything about this project.",
    contextProvider: async () => ({ project_id: projectId }),
    capabilities: {
        training: false,
        comparison: false,
        inquiries: false,
        observer: false,
        audit: false
    }
});

shell.init().then(() => { loadProjectDetail(); });

async function loadProjectDetail() {
    try {
        const data = await apiCall("GET", "/v0/general/projects/" + projectId + "?user_id=" + USER_ID);
        projectData = data.project || data;
        document.getElementById("project-name").textContent = projectData.name || "Project";
        document.getElementById("project-desc").textContent = projectData.description || "No description";
        document.title = "Oggy - " + (projectData.name || "Project");
    } catch (e) {
        document.getElementById("project-name").textContent = "Project not found";
        showToast("Failed to load project", "error");
    }
}
