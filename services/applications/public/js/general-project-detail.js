// General Assistant - Project Detail
const projectId = new URLSearchParams(window.location.search).get("id");

if (!projectId) {
    window.location.href = "/general-projects.html";
}

let projectData = null;
let learningSettings = { behavior_learning: true, domain_learning: false };

const shell = new AgentShell({
    domain: "general",
    label: "Project Chat",
    chatEndpoint: "/v0/general/chat",
    trainingEndpoint: "/v0/continuous-learning",
    chatPlaceholder: "Ask about this project...",
    welcomeMessage: "Hi! Ask me anything about this project.",
    storageKey: `oggy_general_project_${projectId}`,
    contextProvider: async () => ({ project_id: projectId }),
    capabilities: {
        training: false,
        comparison: true,
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
        await loadLearningSettings();
        loadNotes();
    } catch (e) {
        document.getElementById("project-name").textContent = "Project not found";
        showToast("Failed to load project", "error");
    }
}

async function loadLearningSettings() {
    try {
        const data = await apiCall("GET", `/v0/general/projects/${projectId}/learning-settings`);
        learningSettings = data.learning || { behavior_learning: true, domain_learning: false };
        document.getElementById("bl-toggle").checked = learningSettings.behavior_learning;
        document.getElementById("dl-toggle").checked = learningSettings.domain_learning;
        document.getElementById("dl-panel").style.display = learningSettings.domain_learning ? "block" : "none";
        if (learningSettings.domain_learning) {
            loadProjectTags();
            loadSavedStudyPlans();
            loadAuditTrail();
        }
    } catch (e) {
        // Use defaults
    }
}

async function toggleLearningMode(mode, enabled) {
    try {
        learningSettings[mode] = enabled;
        await apiCall("PUT", `/v0/general/projects/${projectId}/learning-settings`, {
            ...learningSettings
        });
        if (mode === "domain_learning") {
            document.getElementById("dl-panel").style.display = enabled ? "block" : "none";
            if (enabled) { loadProjectTags(); loadSavedStudyPlans(); loadAuditTrail(); }
        }
        showToast(`${mode === 'behavior_learning' ? 'Behavior' : 'Domain'} learning ${enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (e) {
        showToast("Failed to update setting", "error");
        document.getElementById(mode === 'behavior_learning' ? 'bl-toggle' : 'dl-toggle').checked = !enabled;
    }
}

async function suggestDomainTags() {
    const tagsEl = document.getElementById("domain-tags");
    tagsEl.innerHTML = '<span style="color:var(--text-muted)">Analyzing project...</span>';
    try {
        const data = await apiCall("POST", "/v0/general/domain-tags/suggest", { project_id: projectId });
        const tags = data.tags || [];
        if (tags.length === 0) {
            tagsEl.innerHTML = '<span style="color:var(--text-muted)">No domain tags suggested. Chat more about your project first.</span>';
            return;
        }
        tagsEl.innerHTML = tags.map(t =>
            `<span class="chip chip-suggested" data-tag-id="${t.tag_id}" style="cursor:pointer;padding:4px 10px;border-radius:12px;background:var(--bg);border:1px solid var(--border)" onclick="enableDomainTag('${t.tag_id}', this)">${t.display_name || t.tag} <span style="color:var(--accent);margin-left:4px">Enable?</span></span>`
        ).join('');
    } catch (e) {
        tagsEl.innerHTML = '<span style="color:var(--text-muted)">Failed to suggest tags.</span>';
        showToast("Tag suggestion failed: " + e.message, "error");
    }
}

async function enableDomainTag(tagId, el) {
    try {
        await apiCall("POST", "/v0/general/domain-tags/enable", { project_id: projectId, tag_id: tagId });
        if (el) {
            el.className = "tag-chip enabled";
            el.innerHTML = el.textContent.replace(' Enable?', '').trim();
            el.onclick = null;
        }
        showToast("Domain tag enabled", "success");
        loadProjectTags();
    } catch (e) {
        showToast("Failed to enable tag: " + e.message, "error");
    }
}

async function loadProjectTags() {
    try {
        const data = await apiCall("GET", `/v0/general/domain-tags?project_id=${projectId}`);
        const tags = data.tags || [];
        if (tags.length === 0) return;

        const tagsEl = document.getElementById("domain-tags");
        tagsEl.innerHTML = tags.map(t => {
            const hasActivePack = t.active_pack_id;
            return `<span class="tag-chip enabled">${t.display_name || t.tag}${hasActivePack ? ` <span style="color:var(--accent);font-size:10px">v${t.active_version} (${t.active_cards} cards)</span>` : ''}</span>`;
        }).join('');

        // Show pack management for each tag
        const packsSection = document.getElementById("packs-section");
        packsSection.style.display = "block";

        let packsHtml = '';
        for (const tag of tags) {
            packsHtml += `<div style="margin-bottom:10px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                    <span style="font-size:12px;font-weight:500">${tag.display_name || tag.tag}</span>
                    <div style="display:flex;gap:6px">
                        <button class="btn btn-sm btn-outline" onclick="buildPack('${tag.tag_id}')">Build Pack</button>
                        <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--text-muted);cursor:pointer">
                            <input type="checkbox" onchange="_freeOnlyStudyPlan=this.checked" style="width:14px;height:14px"> Free only
                        </label>
                        <button class="btn btn-sm btn-outline" onclick="generateStudyPlan('${tag.tag_id}')">Study Plan</button>
                        ${tag.active_pack_id ? `<button class="btn btn-sm btn-outline" style="color:var(--error)" onclick="rollbackPack('${tag.tag_id}')">Rollback</button>` : ''}
                    </div>
                </div>`;

            // Load packs for this tag
            try {
                const packData = await apiCall("GET", `/v0/general/domain-learning/packs?tag_id=${tag.tag_id}`);
                const packs = packData.packs || [];
                for (const pack of packs.slice(0, 3)) {
                    const statusColor = pack.status === 'applied' ? 'var(--accent)' : pack.status === 'ready' ? '#22c55e' : 'var(--text-muted)';
                    packsHtml += `<div class="pack-item">
                        <div class="pack-header">
                            <span>v${pack.version} - ${pack.card_count} cards</span>
                            <span style="color:${statusColor};font-size:11px">${pack.status}</span>
                        </div>
                        <div class="pack-meta">${pack.summary || ''}</div>
                        ${pack.status === 'ready' ? `<div class="pack-actions" style="margin-top:6px">
                            <button class="btn btn-sm btn-primary" onclick="applyPack('${pack.pack_id}')">Apply</button>
                            <button class="btn btn-sm btn-outline" onclick="rejectPack('${pack.pack_id}')">Reject</button>
                        </div>` : ''}
                    </div>`;
                }
            } catch (e) { /* ignore */ }

            packsHtml += '</div>';
        }
        document.getElementById("knowledge-packs").innerHTML = packsHtml;
    } catch (e) {
        // Tags table may not exist yet
    }
}

async function buildPack(tagId) {
    showToast("Building knowledge pack...", "info");
    try {
        const data = await apiCall("POST", "/v0/general/domain-learning/build-pack", { tag_id: tagId });
        showToast(`Pack v${data.version} built with ${data.card_count} cards`, "success");
        loadProjectTags();
    } catch (e) {
        showToast("Build failed: " + e.message, "error");
    }
}

async function applyPack(packId) {
    try {
        const data = await apiCall("POST", `/v0/general/domain-learning/packs/${packId}/apply`, { project_id: projectId });
        showToast(`Pack applied: ${data.stored}/${data.total} cards stored as memory`, "success");
        loadProjectTags();
        loadAuditTrail();
    } catch (e) {
        showToast("Apply failed: " + e.message, "error");
    }
}

async function rejectPack(packId) {
    try {
        await apiCall("POST", `/v0/general/domain-learning/packs/${packId}/reject`);
        showToast("Pack rejected", "success");
        loadProjectTags();
    } catch (e) {
        showToast("Reject failed: " + e.message, "error");
    }
}

async function rollbackPack(tagId) {
    if (!confirm("This will remove the applied knowledge from memory. Continue?")) return;
    try {
        const data = await apiCall("POST", "/v0/general/domain-learning/rollback", { project_id: projectId, tag_id: tagId });
        showToast(`Rolled back: ${data.rolled} memory cards zeroed`, "success");
        loadProjectTags();
        loadAuditTrail();
    } catch (e) {
        showToast("Rollback failed: " + e.message, "error");
    }
}

// --- Study Plans ---

let _currentStudyPlan = null;
let _currentStudyPlanTagId = null;
let _freeOnlyStudyPlan = false;
let _savedPlansCache = {}; // planId -> plan object for edit/refine

function renderStudyPlan(plan, options) {
    const { saved = false, planId = null, showDelete = false, tagId = null } = options || {};
    let html = '';
    if (plan.domain) {
        html += `<div style="font-size:13px;font-weight:600;margin-bottom:6px">${plan.domain}</div>`;
    }
    if (plan.estimated_total_hours) {
        html += `<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Estimated: ~${plan.estimated_total_hours} hours</div>`;
    }
    if (plan.prerequisites && plan.prerequisites.length) {
        html += `<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">Prerequisites: ${plan.prerequisites.join(', ')}</div>`;
    }
    for (const topic of (plan.topics || [])) {
        html += `<div class="study-plan-topic">
            <div class="topic-name">${topic.name}</div>
            <div>${topic.description || ''}</div>
            <div class="topic-hours">${topic.estimated_hours ? topic.estimated_hours + 'h' : ''} ${topic.practice ? '| Practice: ' + topic.practice : ''}</div>
            ${(topic.resources || []).map(r => {
                const url = r.url || ('https://www.google.com/search?q=' + encodeURIComponent(r.title || ''));
                return `<div style="margin-top:2px"><a href="${url}" target="_blank" rel="noopener" style="color:var(--accent);font-size:11px">${r.title}</a> <span style="color:var(--text-muted);font-size:10px">${r.type || ''}</span></div>`;
            }).join('')}
        </div>`;
    }
    if (plan.tips && plan.tips.length) {
        html += `<div style="font-size:11px;color:var(--text-muted);margin-top:8px">Tips: ${plan.tips.join(' | ')}</div>`;
    }

    // Edit input area (hidden by default, toggled by Edit button)
    const editId = saved ? `saved-edit-${planId}` : 'new-plan-edit';
    html += `<div id="${editId}" style="display:none;margin-top:10px">
        <textarea id="${editId}-input" placeholder="e.g. I already know derivatives and integrals well, focus more on differential equations" style="width:100%;min-height:60px;padding:8px;border:1px solid var(--border);border-radius:6px;font-size:12px;resize:vertical;background:var(--bg);color:var(--text)"></textarea>
        <div style="display:flex;gap:8px;margin-top:6px">
            <button class="btn btn-sm btn-primary" onclick="applyStudyPlanEdit('${editId}', ${saved ? `'${planId}'` : 'null'}, '${tagId || _currentStudyPlanTagId || ''}')">Apply</button>
            <button class="btn btn-sm btn-outline" onclick="document.getElementById('${editId}').style.display='none'">Cancel</button>
        </div>
    </div>`;

    if (!saved) {
        html += `<div style="display:flex;gap:8px;margin-top:12px">
            <button class="btn btn-sm btn-primary" onclick="saveStudyPlan()">Accept & Save</button>
            <button class="btn btn-sm btn-outline" onclick="toggleStudyPlanEdit('${editId}')">Edit</button>
            <button class="btn btn-sm btn-outline" onclick="generateStudyPlan('${_currentStudyPlanTagId}')">Regenerate</button>
        </div>`;
    } else if (showDelete && planId) {
        html += `<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
            <button class="btn btn-sm btn-outline" onclick="toggleStudyPlanEdit('${editId}')">Edit</button>
            <button class="btn btn-sm btn-outline" style="color:var(--error);font-size:10px" onclick="deleteStudyPlan('${planId}')">Remove</button>
        </div>`;
    }
    return html;
}

function toggleStudyPlanEdit(editId) {
    const el = document.getElementById(editId);
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
    if (el.style.display === 'block') {
        el.querySelector('textarea').focus();
    }
}

async function applyStudyPlanEdit(editId, savedPlanId, tagId) {
    const input = document.getElementById(editId + '-input');
    const feedback = (input.value || '').trim();
    if (!feedback) { showToast("Please enter your feedback", "error"); return; }

    // Determine which plan to refine
    const plan = savedPlanId ? _savedPlansCache[savedPlanId] : _currentStudyPlan;
    const resolvedTagId = tagId || _currentStudyPlanTagId;
    if (!plan || !resolvedTagId) { showToast("No plan to refine", "error"); return; }

    // Show loading state
    const applyBtn = document.querySelector(`#${editId} .btn-primary`);
    const origText = applyBtn.textContent;
    applyBtn.textContent = 'Refining...';
    applyBtn.disabled = true;

    try {
        const refined = await apiCall("POST", "/v0/general/domain-learning/study-plan/refine", {
            tag_id: resolvedTagId,
            current_plan: plan,
            feedback: feedback,
            free_only: _freeOnlyStudyPlan
        });

        if (savedPlanId) {
            // For saved plans: delete old, save new, reload
            await apiCall("DELETE", `/v0/general/domain-learning/study-plan/${savedPlanId}`);
            await apiCall("POST", "/v0/general/domain-learning/study-plan/save", {
                project_id: projectId,
                tag_id: resolvedTagId,
                plan: refined
            });
            showToast("Study plan updated!", "success");
            loadSavedStudyPlans();
            loadAuditTrail();
        } else {
            // For new plan: replace current
            _currentStudyPlan = refined;
            document.getElementById("study-plan-hours").textContent = refined.estimated_total_hours ? `~${refined.estimated_total_hours} hours` : '';
            document.getElementById("study-plan-content").innerHTML = renderStudyPlan(refined, { saved: false });
        }
    } catch (e) {
        showToast("Failed to refine plan: " + e.message, "error");
    } finally {
        applyBtn.textContent = origText;
        applyBtn.disabled = false;
    }
}

async function generateStudyPlan(tagId) {
    const section = document.getElementById("study-plan-section");
    const content = document.getElementById("study-plan-content");
    section.style.display = "block";
    content.innerHTML = '<span style="color:var(--text-muted);font-size:12px">Generating study plan...</span>';
    try {
        const plan = await apiCall("POST", "/v0/general/domain-learning/study-plan", { tag_id: tagId, free_only: _freeOnlyStudyPlan });
        _currentStudyPlan = plan;
        _currentStudyPlanTagId = tagId;
        document.getElementById("study-plan-hours").textContent = plan.estimated_total_hours ? `~${plan.estimated_total_hours} hours` : '';
        content.innerHTML = renderStudyPlan(plan, { saved: false }) || '<span style="color:var(--text-muted)">No plan generated.</span>';
    } catch (e) {
        content.innerHTML = '<span style="color:var(--error);font-size:12px">Failed to generate study plan.</span>';
        showToast("Study plan failed: " + e.message, "error");
    }
}

async function saveStudyPlan() {
    if (!_currentStudyPlan || !_currentStudyPlanTagId) return;
    try {
        await apiCall("POST", "/v0/general/domain-learning/study-plan/save", {
            project_id: projectId,
            tag_id: _currentStudyPlanTagId,
            plan: _currentStudyPlan
        });
        showToast("Study plan saved!", "success");
        // Clear the generate section and reload saved plans
        document.getElementById("study-plan-section").style.display = "none";
        _currentStudyPlan = null;
        _currentStudyPlanTagId = null;
        loadSavedStudyPlans();
        loadAuditTrail();
    } catch (e) {
        showToast("Failed to save study plan: " + e.message, "error");
    }
}

async function loadSavedStudyPlans() {
    try {
        const data = await apiCall("GET", `/v0/general/domain-learning/study-plans?project_id=${projectId}`);
        const plans = data.plans || [];
        const section = document.getElementById("saved-plans-section");
        const container = document.getElementById("saved-plans-list");
        if (plans.length === 0) {
            section.style.display = "none";
            return;
        }
        section.style.display = "block";
        document.getElementById("saved-plans-count").textContent = `(${plans.length})`;

        // Cache plans for edit/refine
        _savedPlansCache = {};
        for (const p of plans) {
            _savedPlansCache[p.id] = p.plan;
        }

        container.innerHTML = plans.map(p => {
            const date = new Date(p.saved_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            return `<div class="saved-plan-card" style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px;background:var(--bg)">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;cursor:pointer" onclick="toggleSavedPlan('${p.id}')">
                    <div>
                        <span style="font-weight:500;font-size:12px">${p.tag_name}</span>
                        <span style="color:var(--text-muted);font-size:10px;margin-left:8px">Saved ${date}</span>
                    </div>
                    <span id="plan-toggle-${p.id}" style="font-size:10px;color:var(--text-muted)">expand</span>
                </div>
                <div id="plan-body-${p.id}" style="display:none">
                    ${renderStudyPlan(p.plan, { saved: true, planId: p.id, showDelete: true, tagId: p.tag_id })}
                </div>
            </div>`;
        }).join('');
    } catch (e) { /* ignore */ }
}

function toggleSavedPlan(planId) {
    const body = document.getElementById('plan-body-' + planId);
    const toggle = document.getElementById('plan-toggle-' + planId);
    if (body.style.display === 'none') {
        body.style.display = 'block';
        toggle.textContent = 'collapse';
    } else {
        body.style.display = 'none';
        toggle.textContent = 'expand';
    }
}

async function deleteStudyPlan(planId) {
    if (!confirm("Remove this saved study plan?")) return;
    try {
        await apiCall("DELETE", `/v0/general/domain-learning/study-plan/${planId}`);
        showToast("Study plan removed", "success");
        loadSavedStudyPlans();
        loadAuditTrail();
    } catch (e) {
        showToast("Failed to remove plan: " + e.message, "error");
    }
}

async function loadAuditTrail() {
    try {
        const data = await apiCall("GET", `/v0/general/domain-learning/audit?project_id=${projectId}&limit=15`);
        const events = data.events || [];
        const el = document.getElementById("audit-trail");
        if (events.length === 0) {
            el.innerHTML = '<span style="font-size:11px;color:var(--text-muted)">No events yet.</span>';
            return;
        }
        el.innerHTML = events.map(e => {
            const date = new Date(e.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            const typeLabel = e.event_type.replace(/_/g, ' ');
            return `<div class="audit-item"><span>${typeLabel}</span><span style="color:var(--text-muted)">${date}</span></div>`;
        }).join('');
    } catch (e) { /* ignore */ }
}

// --- Notes ---

async function loadNotes() {
    const section = document.getElementById("notes-section");
    const list = document.getElementById("notes-list");
    const countEl = document.getElementById("notes-count");

    // Always show notes section so user can add notes
    section.style.display = "block";

    try {
        const data = await apiCall("GET", `/v0/general/projects/${projectId}/notes?user_id=${USER_ID}`);
        const notes = data.notes || [];

        if (notes.length === 0) {
            countEl.textContent = "";
            list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px 0">No notes yet. Click "+ Add Note" or save a chat message as a note.</div>';
            return;
        }

        countEl.textContent = `(${notes.length})`;

        // Group by day
        const grouped = {};
        for (const note of notes) {
            const day = new Date(note.created_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
            if (!grouped[day]) grouped[day] = [];
            grouped[day].push(note);
        }

        let html = '';
        for (const [day, dayNotes] of Object.entries(grouped)) {
            html += `<div class="note-day-header">${day}</div>`;
            for (const note of dayNotes) {
                const time = new Date(note.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                const sourceLabel = note.source_role === 'conversation' ? 'Conversation snapshot' : note.source_role === 'assistant' ? 'From Oggy' : note.source_role === 'user' ? 'From you' : 'Manual note';
                const escaped = note.content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                html += `<div class="note-card">
                    <div class="note-meta">
                        <span class="note-source">${sourceLabel}</span>
                        <div style="display:flex;align-items:center;gap:8px">
                            <span>${time}</span>
                            <button onclick="deleteNote('${note.note_id}')" style="background:none;border:none;cursor:pointer;font-size:14px;color:var(--text-muted);padding:0;line-height:1" title="Delete note">&times;</button>
                        </div>
                    </div>
                    <div style="white-space:pre-wrap;line-height:1.5">${escaped}</div>
                </div>`;
            }
        }
        list.innerHTML = html;
    } catch (err) {
        // Keep section visible even on error so user can add notes manually
        countEl.textContent = "";
        list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px 0">No notes yet. Click "+ Add Note" or save a chat message as a note.</div>';
    }
}

window.toggleAddNote = function() {
    const form = document.getElementById("add-note-form");
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
    if (form.style.display === 'block') {
        document.getElementById("manual-note-input").focus();
    }
};

window.saveManualNote = async function() {
    const input = document.getElementById("manual-note-input");
    const content = (input.value || '').trim();
    if (!content) { showToast("Note cannot be empty", "error"); return; }
    try {
        await apiCall("POST", `/v0/general/projects/${projectId}/notes`, {
            user_id: USER_ID,
            content: content
        });
        input.value = '';
        toggleAddNote();
        showToast("Note saved!", "success");
        loadNotes();
    } catch (err) {
        showToast("Failed to save note: " + err.message, "error");
    }
};

const NOTE_MAX_CHARS = 5000;

window.saveChatAsNote = function() {
    const oggyContainer = document.getElementById('oggy-messages');
    if (!oggyContainer) return;

    // Collect all messages in order (skip the initial welcome message)
    const msgs = oggyContainer.querySelectorAll('.chat-msg-user, .chat-msg-bot');
    if (msgs.length <= 1) {
        showToast("No conversation to save yet", "error");
        return;
    }

    let lines = [];
    msgs.forEach(msg => {
        const clone = msg.cloneNode(true);
        // Remove UI elements (buttons, memory labels, feedback)
        clone.querySelectorAll('button, .chat-msg-memory, .chat-feedback').forEach(el => el.remove());
        const text = clone.textContent.trim();
        if (!text) return;
        const role = msg.classList.contains('chat-msg-user') ? 'You' : 'Oggy';
        lines.push(`${role}: ${text}`);
    });

    if (lines.length === 0) {
        showToast("No conversation to save", "error");
        return;
    }

    let snapshot = lines.join('\n\n');

    if (snapshot.length > NOTE_MAX_CHARS) {
        const truncated = snapshot.substring(0, NOTE_MAX_CHARS);
        // Find last complete message boundary
        const lastBreak = truncated.lastIndexOf('\n\n');
        const cleanTruncated = lastBreak > 0 ? truncated.substring(0, lastBreak) : truncated;
        const msgCount = lines.length;
        const savedCount = cleanTruncated.split('\n\n').length;

        if (!confirm(`This conversation has ${msgCount} messages and exceeds the note limit (${NOTE_MAX_CHARS} chars).\n\nSave the first ${savedCount} messages (truncated to fit)?`)) {
            return;
        }
        snapshot = cleanTruncated + '\n\n[... conversation truncated]';
    }

    _saveConversationNote(snapshot);
};

async function _saveConversationNote(content) {
    try {
        await apiCall("POST", `/v0/general/projects/${projectId}/notes`, {
            user_id: USER_ID,
            content: content,
            source_role: 'conversation'
        });
        showToast("Conversation saved as note!", "success");
        loadNotes();
    } catch (err) {
        showToast("Failed to save note: " + err.message, "error");
    }
}

window.deleteNote = async function(noteId) {
    if (!confirm("Delete this note?")) return;
    try {
        await apiCall("DELETE", `/v0/general/notes/${noteId}?user_id=${USER_ID}`);
        showToast("Note deleted", "success");
        loadNotes();
    } catch (err) {
        showToast("Failed to delete note: " + err.message, "error");
    }
};

// No per-message buttons — notes are saved as full conversation snapshots via "Save Chat" button

function showSuggestionBanner(suggestion) {
    const banner = document.getElementById("suggestion-banner");
    if (!banner || !suggestion) return;
    banner.style.display = "flex";
    banner.className = "suggestion-banner";
    banner.innerHTML = `<span>${suggestion.message}</span>
        <button class="btn btn-sm btn-primary" onclick="acceptSuggestion('${suggestion.type}')">Enable</button>`;
}

async function acceptSuggestion(type) {
    if (type === 'enable_domain_learning') {
        document.getElementById("dl-toggle").checked = true;
        await toggleLearningMode('domain_learning', true);
    }
    document.getElementById("suggestion-banner").style.display = "none";
}
