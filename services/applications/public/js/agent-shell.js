/**
 * Agent Shell — Shared UI component for all Oggy domains.
 *
 * Each domain (Payments, V2 General, V3 Diet) provides a config:
 *   {
 *     domain: 'payments' | 'general' | 'diet',
 *     label: 'Payments' | 'General Chat' | 'Diet Agent',
 *     chatEndpoint: '/v0/chat',
 *     trainingEndpoint: '/v0/continuous-learning',
 *     analyticsPage: '/analytics.html',
 *     chatPlaceholder: 'Ask about spending...',
 *     welcomeMessage: 'Hi! I am Oggy...',
 *     baseWelcome: 'Hi! I am the base model...',
 *     contextProvider: async () => ({...}),
 *     actionHandlers: { onTrain, onStopTrain },
 *     trainingConfig: { durations, defaultDuration, showBenchmarks },
 *     auditProvider: { endpoint, placeholder },
 *     capabilities: { training, comparison, inquiries, observer, audit }
 *   }
 */

class AgentShell {
    constructor(config) {
        this.config = Object.assign({
            domain: 'general',
            label: 'Chat',
            chatEndpoint: '/v0/chat',
            trainingEndpoint: '/v0/continuous-learning',
            analyticsPage: '/analytics.html',
            chatPlaceholder: 'Ask Oggy anything...',
            welcomeMessage: 'Hi! I\'m Oggy. I learn from our conversations!',
            baseWelcome: 'Hi! I\'m the base model without memory.',
            contextProvider: async () => ({}),
            actionHandlers: {},
            trainingConfig: {
                durations: [5, 10, 15, 30, 60, 120, 240, 360, 480, 720, 1440, 0],
                defaultDuration: 10,
                showBenchmarks: true
            },
            observerBasePath: '/v0/observer',
            auditProvider: {
                endpoint: '/v0/benchmark-analytics/audit-chat',
                placeholder: 'Ask about performance...'
            },
            capabilities: {
                training: true,
                comparison: true,
                inquiries: true,
                observer: true,
                audit: true
            }
        }, config);

        this.STORAGE_KEY = this.config.storageKey || `oggy_${this.config.domain}_chat`;
        this.MAX_TURNS = 50;
        this.messages = [];
        this.conversationHistory = [];
        this.learnFromChat = false;
        this.trainingPollInterval = null;
    }

    // --- State ---
    loadState() {
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    }

    saveState() {
        const maxMessages = this.MAX_TURNS * 3;
        const maxHistory = this.MAX_TURNS * 2;
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify({
                messages: this.messages.slice(-maxMessages),
                history: this.conversationHistory.slice(-maxHistory),
                learning: this.learnFromChat,
                savedAt: Date.now()
            }));
        } catch {
            localStorage.removeItem(this.STORAGE_KEY);
        }
    }

    // --- Init ---
    async init() {
        const authed = await initAuth();
        if (!authed) return;

        this._renderNav();
        if (this.config.capabilities.inquiries) startInquiryPolling();
        this._restoreChat();
        this._bindEvents();

        // Check if training is running
        if (this.config.capabilities.training) {
            this._checkRunningTraining();
        }

        // Load inquiry preferences
        if (this.config.capabilities.inquiries) {
            this._loadInquiryPreferences();
        }
    }

    async _loadInquiryPreferences() {
        try {
            const prefs = await apiCall('GET', `/v0/inquiries/preferences?user_id=${USER_ID}`);
            const toggle = document.getElementById('inquiry-toggle');
            const limitSelect = document.getElementById('inquiry-limit');
            if (toggle) toggle.checked = prefs.enabled !== false;
            if (limitSelect) limitSelect.value = String(prefs.max_questions_per_day || 5);
        } catch (e) { /* Inquiry system may not be ready */ }

        try {
            const settings = await apiCall('GET', `/v0/inquiries/suggestion-settings?user_id=${USER_ID}`);
            const sugToggle = document.getElementById('suggestion-toggle');
            const sugInterval = document.getElementById('suggestion-interval');
            if (sugToggle) sugToggle.checked = settings.receive_suggestions === true;
            if (sugInterval) sugInterval.value = String(settings.suggestion_interval_seconds || 900);
        } catch (e) { /* Suggestion system may not be ready */ }
    }

    _renderNav() {
        renderTopbar();
        renderSidebar(this.config.domain, 'chat');
    }

    _bindEvents() {
        const self = this;

        // Chat send
        window.shellSendChat = () => self.sendChat();

        // Learning toggle
        window.shellToggleLearning = (enabled) => {
            self.learnFromChat = enabled;
            const indicator = document.getElementById('learning-indicator');
            if (indicator) indicator.style.display = enabled ? 'inline' : 'none';
            self.saveState();
            showToast(enabled ? 'Learning from chat enabled' : 'Learning from chat disabled');
        };

        // Clear chat
        window.shellClearChat = () => {
            if (!confirm('Clear the entire conversation?')) return;
            self.messages = [];
            self.conversationHistory = [];
            localStorage.removeItem(self.STORAGE_KEY);
            const oggy = document.getElementById('oggy-messages');
            const base = document.getElementById('base-messages');
            if (oggy) oggy.innerHTML = `<div class="chat-msg chat-msg-bot">${self.config.welcomeMessage}</div>`;
            if (base) base.innerHTML = `<div class="chat-msg chat-msg-bot">${self.config.baseWelcome}</div>`;
            showToast('Conversation cleared');
        };

        // Training
        if (this.config.capabilities.training) {
            window.shellStartTraining = () => self.startTraining();
            window.shellStopTraining = () => self.stopTraining();
        }

        // Reset Preferences
        window.resetPreferences = async function() {
            if (!confirm('Reset all non-pinned preferences? Pinned preferences (from explicit statements) will be kept.')) return;
            try {
                const result = await apiCall('POST', '/v0/preferences/reset', { user_id: USER_ID });
                showToast(`Preferences reset (${result.reset_count} signals cleared)`);
            } catch (err) {
                showToast('Failed to reset: ' + err.message, 'error');
            }
        };

        // Inquiry Settings
        if (this.config.capabilities.inquiries) {
            window.toggleInquiries = async function(enabled) {
                try {
                    await apiCall('PUT', '/v0/inquiries/preferences', { user_id: USER_ID, enabled: enabled });
                    showToast(enabled ? 'Self-driven inquiries enabled' : 'Self-driven inquiries disabled');
                } catch (err) { showToast('Failed to update: ' + err.message, 'error'); }
            };
            window.updateInquiryLimit = async function(limit) {
                const val = parseInt(limit);
                try {
                    await apiCall('PUT', '/v0/inquiries/preferences', { user_id: USER_ID, max_questions_per_day: val, enabled: val > 0 });
                    const toggle = document.getElementById('inquiry-toggle');
                    if (toggle) toggle.checked = val > 0;
                    showToast(`Daily inquiry limit set to ${val}`);
                } catch (err) { showToast('Failed to update: ' + err.message, 'error'); }
            };
            window.toggleSuggestions = async function(enabled) {
                try {
                    await apiCall('PUT', '/v0/inquiries/suggestion-settings', { user_id: USER_ID, receive_suggestions: enabled });
                    showToast(enabled ? 'Suggestions enabled' : 'Suggestions disabled');
                } catch (err) { showToast('Failed to update: ' + err.message, 'error'); }
            };
            window.updateSuggestionInterval = async function(seconds) {
                try {
                    await apiCall('PUT', '/v0/inquiries/suggestion-settings', { user_id: USER_ID, suggestion_interval_seconds: parseInt(seconds) });
                    showToast('Suggestion frequency updated');
                } catch (err) { showToast('Failed to update: ' + err.message, 'error'); }
            };
        }

        // Observer
        if (this.config.capabilities.observer) {
            const obsBase = this.config.observerBasePath;
            const loadObserverConfig = async () => {
                try {
                    const config = await apiCall('GET', `${obsBase}/config?user_id=${USER_ID}`);
                    const shareEl = document.getElementById('observer-share');
                    const sugEl = document.getElementById('observer-suggestions');
                    const merchEl = document.getElementById('observer-merchant');
                    if (shareEl) shareEl.checked = config.share_learning === true;
                    if (sugEl) sugEl.checked = config.receive_observer_suggestions === true;
                    if (merchEl) merchEl.checked = config.receive_merchant_packs === true;
                } catch (e) { /* Observer may not be ready */ }
            };
            const loadObserverPacks = async () => {
                const container = document.getElementById('observer-packs');
                if (!container) return;
                try {
                    const data = await apiCall('GET', `${obsBase}/packs`);
                    if (!data.packs || data.packs.length === 0) {
                        container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">No packs available yet. Run an observer job to generate packs.</div>';
                        return;
                    }
                    container.innerHTML = data.packs.map(pack => {
                        const riskColor = pack.risk_level === 'low' ? 'var(--success)' : pack.risk_level === 'medium' ? 'var(--warning)' : 'var(--danger)';
                        const rules = pack.rules || [];
                        const isApplied = pack.status === 'applied';
                        const isRolledBack = pack.status === 'rolled_back';
                        return `<div class="observer-pack-card">
                            <div class="observer-pack-header"><strong>${pack.name}</strong><span class="observer-risk-badge" style="background:${riskColor}">${pack.risk_level}</span></div>
                            <div class="observer-pack-meta">${rules.length} rules | ${(pack.categories_covered || []).join(', ') || 'various'} | +${pack.expected_lift || 0}% expected lift</div>
                            <div class="observer-pack-actions">${isApplied ? `<button class="btn btn-sm btn-danger" onclick="rollbackPack('${pack.pack_id}')">Rollback</button><span style="color:var(--success);font-size:12px">Applied</span>` : isRolledBack ? `<button class="btn btn-sm btn-success" onclick="applyPack('${pack.pack_id}')">Apply</button><span style="color:var(--text-muted);font-size:12px">Rolled back</span>` : `<button class="btn btn-sm btn-success" onclick="applyPack('${pack.pack_id}')">Apply</button>`}</div>
                        </div>`;
                    }).join('');
                } catch (e) { container.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Failed to load packs</div>'; }
            };
            const timeSince = (date) => {
                const s = Math.floor((Date.now() - date.getTime()) / 1000);
                if (s < 60) return 'just now';
                if (s < 3600) return Math.floor(s / 60) + 'm ago';
                if (s < 86400) return Math.floor(s / 3600) + 'h ago';
                return Math.floor(s / 86400) + 'd ago';
            };
            const loadObserverJobStatus = async () => {
                try {
                    const status = await apiCall('GET', `${obsBase}/job-status`);
                    const btn = document.getElementById('observer-run-btn');
                    const dot = document.querySelector('.observer-status-dot');
                    const text = document.getElementById('observer-status-text');
                    const meta = document.getElementById('observer-job-meta');
                    const autoRunEl = document.getElementById('observer-auto-run');
                    if (autoRunEl) autoRunEl.checked = status.auto_run_active;
                    if (status.is_running) {
                        if (dot) dot.className = 'observer-status-dot observer-status-running';
                        if (text) text.textContent = 'Running...';
                        if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
                    } else if (status.ready) {
                        if (dot) dot.className = 'observer-status-dot observer-status-ready';
                        if (text) text.textContent = 'Ready';
                        if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
                    } else {
                        if (dot) dot.className = 'observer-status-dot observer-status-unavailable';
                        if (text) text.textContent = 'Unavailable';
                        if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
                    }
                    const parts = [];
                    parts.push(`${status.sharing_tenants} tenant${status.sharing_tenants !== 1 ? 's' : ''} sharing`);
                    if (status.last_run) {
                        parts.push(`last run ${timeSince(new Date(status.last_run))}`);
                        if (status.last_packs_generated > 0) parts.push(`${status.last_packs_generated} packs`);
                    } else { parts.push('never run'); }
                    if (status.reason && !status.ready) parts.push(status.reason);
                    if (meta) meta.textContent = parts.join(' · ');
                } catch (e) { /* Observer may not be ready */ }
            };
            window.toggleObserverPanel = function() {
                const body = document.getElementById('observer-body');
                const arrow = document.getElementById('observer-arrow');
                if (body.style.display === 'none') {
                    body.style.display = 'block';
                    arrow.innerHTML = '&#9660;';
                    loadObserverConfig();
                    loadObserverJobStatus();
                    loadObserverPacks();
                } else {
                    body.style.display = 'none';
                    arrow.innerHTML = '&#9654;';
                }
            };
            window.updateObserverConfig = async function(field, value) {
                try {
                    const update = { user_id: USER_ID };
                    update[field] = value;
                    await apiCall('PUT', `${obsBase}/config`, update);
                    showToast('Observer setting updated');
                } catch (err) { showToast('Failed to update: ' + err.message, 'error'); }
            };
            window.toggleObserverAutoRun = async function(enabled) {
                try {
                    if (enabled) {
                        await apiCall('POST', `${obsBase}/run-job`, { start_schedule: true });
                        showToast('Observer auto-run enabled (every 6h)');
                    } else {
                        await apiCall('POST', `${obsBase}/run-job`, { stop_schedule: true });
                        showToast('Observer auto-run disabled');
                    }
                    loadObserverJobStatus();
                } catch (err) { showToast('Failed: ' + err.message, 'error'); }
            };
            window.runObserverJob = async function() {
                try {
                    const btn = document.getElementById('observer-run-btn');
                    if (btn) { btn.disabled = true; btn.textContent = 'Running...'; }
                    const result = await apiCall('POST', `${obsBase}/run-job`, {});
                    showToast(`Observer job complete: ${result.packs_generated} packs generated`);
                    if (btn) btn.textContent = 'Run Now';
                    loadObserverPacks();
                    loadObserverJobStatus();
                } catch (err) {
                    showToast('Observer job failed: ' + err.message, 'error');
                    const btn = document.getElementById('observer-run-btn');
                    if (btn) btn.textContent = 'Run Now';
                    loadObserverJobStatus();
                }
            };
            window.applyPack = async function(packId) {
                try {
                    const result = await apiCall('POST', `${obsBase}/import-pack`, { pack_id: packId, user_id: USER_ID });
                    showToast(`Pack applied: ${result.rules_applied} rules, ${result.cards_created} memory cards created`);
                    loadObserverPacks();
                } catch (err) { showToast('Failed to apply pack: ' + err.message, 'error'); }
            };
            window.rollbackPack = async function(packId) {
                if (!confirm('Rollback this observer pack? This will zero out the memory cards it created.')) return;
                try {
                    const result = await apiCall('POST', `${obsBase}/rollback-pack`, { pack_id: packId, user_id: USER_ID });
                    showToast(`Pack rolled back: ${result.cards_rolled_back} cards affected`);
                    loadObserverPacks();
                } catch (err) { showToast('Failed to rollback: ' + err.message, 'error'); }
            };
        }

        // Feedback
        window.shellSendFeedback = async function(intent, requestId, btn) {
            const feedbackDiv = btn.parentElement;
            feedbackDiv.querySelectorAll('.feedback-btn').forEach(b => b.disabled = true);
            btn.classList.add('feedback-active');
            try {
                await apiCall('POST', '/v0/preferences/feedback', {
                    user_id: USER_ID,
                    intent: intent,
                    target: 'tone',
                    value: intent === 'like' ? 'good response quality' : 'response could be improved',
                    strength: 0.6,
                    request_id: requestId
                });
                if (intent === 'dislike') {
                    const options = document.createElement('div');
                    options.className = 'feedback-options';
                    options.innerHTML = `
                        <span class="feedback-label">What could be better?</span>
                        <button onclick="shellSendDetailedFeedback('verbosity', 'too verbose', this)">Too long</button>
                        <button onclick="shellSendDetailedFeedback('verbosity', 'too brief', this)">Too short</button>
                        <button onclick="shellSendDetailedFeedback('tone', 'too formal', this)">Too formal</button>
                        <button onclick="shellSendDetailedFeedback('tone', 'not helpful enough', this)">Not helpful</button>
                    `;
                    feedbackDiv.appendChild(options);
                }
            } catch (err) {
                showToast('Failed to record feedback', 'error');
            }
        };
        window.shellSendDetailedFeedback = async function(target, value, btn) {
            btn.disabled = true;
            btn.textContent = 'Noted';
            try {
                await apiCall('POST', '/v0/preferences/feedback', {
                    user_id: USER_ID,
                    intent: 'dislike',
                    target: target,
                    value: value,
                    strength: 0.7
                });
                const options = btn.parentElement;
                setTimeout(() => options.remove(), 1000);
            } catch (err) { /* silent fail */ }
        };

        // Audit
        if (this.config.capabilities.audit) {
            window.shellToggleAudit = () => {
                const body = document.getElementById('audit-body');
                const arrow = document.getElementById('audit-arrow');
                if (body.style.display === 'none') {
                    body.style.display = 'block';
                    arrow.innerHTML = '&#9660;';
                } else {
                    body.style.display = 'none';
                    arrow.innerHTML = '&#9654;';
                }
            };
            window.shellSendAudit = () => self.sendAuditQuestion();
        }
    }

    // --- Chat ---
    async sendChat() {
        const input = document.getElementById('chat-input');
        const msg = input.value.trim();
        if (!msg) return;

        input.value = '';
        const sendBtn = document.getElementById('chat-send-btn');
        if (sendBtn) sendBtn.disabled = true;

        // Show user message
        this._addMsg('oggy-messages', msg, 'user');
        if (this.config.capabilities.comparison) {
            this._addMsg('base-messages', msg, 'user');
        }
        this.messages.push({ role: 'user', text: msg });

        // Typing indicators
        const oggyTyping = this._addMsg('oggy-messages', '<span class="spinner"></span> Thinking...', 'bot');
        let baseTyping = null;
        if (this.config.capabilities.comparison) {
            baseTyping = this._addMsg('base-messages', '<span class="spinner"></span> Thinking...', 'bot');
        }

        try {
            // Get domain-specific context
            const ctx = await this.config.contextProvider();

            const data = await apiCall('POST', this.config.chatEndpoint, {
                user_id: USER_ID,
                message: msg,
                conversation_history: this.conversationHistory.slice(-10),
                learn_from_chat: this.learnFromChat,
                client_date: todayStr(),
                ...ctx
            });

            oggyTyping.remove();
            if (baseTyping) baseTyping.remove();

            // Show Oggy response
            const oggyEl = this._addMsg('oggy-messages', data.oggy_response.text, 'bot');
            if (data.oggy_response.used_memory) {
                const memNote = document.createElement('div');
                memNote.className = 'chat-msg-memory';
                memNote.textContent = 'Used learned memory';
                oggyEl.appendChild(memNote);
            }

            // Feedback buttons + audit tag
            const feedbackDiv = document.createElement('div');
            feedbackDiv.className = 'chat-feedback';
            const reqId = data.request_id || '';
            feedbackDiv.innerHTML = `
                <button class="feedback-btn feedback-like" onclick="shellSendFeedback('like', '${reqId}', this)" title="Good response">&#x1F44D;</button>
                <button class="feedback-btn feedback-dislike" onclick="shellSendFeedback('dislike', '${reqId}', this)" title="Could be better">&#x1F44E;</button>
            `;
            if (data.oggy_response.audit) {
                const auditTag = document.createElement('span');
                auditTag.className = 'chat-audit-tag';
                auditTag.textContent = data.oggy_response.style || '';
                if (data.oggy_response.audit.candidate_count > 1) {
                    auditTag.title = `Selected from ${data.oggy_response.audit.candidate_count} candidates (score: ${(data.oggy_response.audit.winner_score || 0).toFixed(2)})`;
                }
                feedbackDiv.appendChild(auditTag);

                // "Why?" link for audit detail
                if (reqId) {
                    const whyLink = document.createElement('a');
                    whyLink.className = 'chat-why-link';
                    whyLink.textContent = 'Why?';
                    whyLink.href = '#';
                    const self = this;
                    whyLink.onclick = (e) => { e.preventDefault(); self._showAuditDetail(reqId, whyLink); };
                    feedbackDiv.appendChild(whyLink);
                }
            }
            oggyEl.appendChild(feedbackDiv);

            // Show base response
            if (this.config.capabilities.comparison && data.base_response) {
                this._addMsg('base-messages', data.base_response.text, 'bot');
                this.messages.push(
                    { role: 'oggy', text: data.oggy_response.text, usedMemory: data.oggy_response.used_memory },
                    { role: 'base', text: data.base_response.text }
                );
            } else {
                this.messages.push(
                    { role: 'oggy', text: data.oggy_response.text, usedMemory: data.oggy_response.used_memory }
                );
            }

            this.conversationHistory.push(
                { role: 'user', content: msg },
                { role: 'assistant', content: data.oggy_response.text }
            );
            this.saveState();

        } catch (err) {
            oggyTyping.remove();
            if (baseTyping) baseTyping.remove();
            this._addMsg('oggy-messages', 'Error: ' + err.message, 'bot');
            if (this.config.capabilities.comparison) {
                this._addMsg('base-messages', 'Error: ' + err.message, 'bot');
            }
        } finally {
            if (sendBtn) sendBtn.disabled = false;
            input.focus();
        }
    }

    _addMsg(containerId, text, type) {
        const container = document.getElementById(containerId);
        if (!container) return document.createElement('div');
        const div = document.createElement('div');
        div.className = `chat-msg chat-msg-${type === 'user' ? 'user' : 'bot'}`;
        div.innerHTML = text;
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        return div;
    }

    _restoreChat() {
        const state = this.loadState();
        if (!state || !state.messages || state.messages.length === 0) return;

        this.messages = state.messages;
        this.conversationHistory = state.history || [];
        this.learnFromChat = state.learning || false;

        const toggle = document.getElementById('learn-toggle');
        if (toggle) toggle.checked = this.learnFromChat;
        const indicator = document.getElementById('learning-indicator');
        if (indicator) indicator.style.display = this.learnFromChat ? 'inline' : 'none';

        const oggyContainer = document.getElementById('oggy-messages');
        const baseContainer = document.getElementById('base-messages');

        for (const msg of this.messages) {
            if (msg.role === 'user') {
                this._addMsg('oggy-messages', msg.text, 'user');
                if (this.config.capabilities.comparison) {
                    this._addMsg('base-messages', msg.text, 'user');
                }
            } else if (msg.role === 'oggy') {
                const el = this._addMsg('oggy-messages', msg.text, 'bot');
                if (msg.usedMemory) {
                    const memNote = document.createElement('div');
                    memNote.className = 'chat-msg-memory';
                    memNote.textContent = 'Used learned memory';
                    el.appendChild(memNote);
                }
            } else if (msg.role === 'base' && this.config.capabilities.comparison) {
                this._addMsg('base-messages', msg.text, 'bot');
            }
        }
    }

    // --- Training ---
    async startTraining() {
        const duration = parseInt(document.getElementById('train-duration')?.value || '10');
        const email = document.getElementById('train-email')?.value?.trim();
        const reportInterval = document.getElementById('train-report-interval')?.value;
        const startBtn = document.getElementById('train-start');
        const stopBtn = document.getElementById('train-stop');

        if (startBtn) { startBtn.disabled = true; startBtn.textContent = 'Starting...'; }

        const reqBody = { user_id: USER_ID, duration_minutes: duration === 0 ? null : duration, run_benchmarks: true, domain: this.config.domain };
        if (email) { reqBody.report_email = email; reqBody.report_interval = reportInterval; }

        try {
            await apiCall('POST', `${this.config.trainingEndpoint}/start`, reqBody);

            if (startBtn) startBtn.style.display = 'none';
            if (stopBtn) stopBtn.style.display = 'inline-flex';
            const status = document.getElementById('training-status');
            if (status) status.style.display = 'grid';
            const panel = document.getElementById('training-panel');
            if (panel) panel.classList.add('training-active');

            const durationLabel = duration === 0 ? 'indefinitely (until stopped)' : duration >= 60 ? `${duration / 60} hour${duration > 60 ? 's' : ''}` : `${duration} minutes`;
            showToast(`Training started — running ${durationLabel}`);
            this.trainingPollInterval = setInterval(() => this._pollTraining(), 5000);
            this._pollTraining();
        } catch (err) {
            showToast('Failed to start: ' + err.message, 'error');
        } finally {
            if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Start Training'; }
        }
    }

    async stopTraining() {
        try {
            await apiCall('POST', `${this.config.trainingEndpoint}/stop`, { user_id: USER_ID, domain: this.config.domain });
            showToast('Training stopped');
        } catch (err) {
            showToast('Error stopping: ' + err.message, 'error');
        }
        this._resetTrainingUI();
    }

    async _pollTraining() {
        try {
            const s = await apiCall('GET', `${this.config.trainingEndpoint}/status?domain=${this.config.domain}`);
            const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
            setVal('ts-level', s.scale_level_display || '-');
            setVal('ts-accuracy', s.overall_accuracy || '-');
            setVal('ts-questions', `${s.correct_answers || 0}/${s.total_questions || 0}`);
            setVal('ts-benchmarks', `${s.benchmarks_passed || 0}/${s.benchmarks_generated || 0} passed`);
            setVal('ts-remaining', s.training_time_remaining_readable || (s.is_running ? 'Indefinite' : '-'));
            setVal('ts-status', s.status || '-');

            if (s.status === 'stopped' || !s.is_running) {
                this._resetTrainingUI();
            }
        } catch (err) { /* ignore polling errors */ }
    }

    _resetTrainingUI() {
        if (this.trainingPollInterval) { clearInterval(this.trainingPollInterval); this.trainingPollInterval = null; }
        const el = (id) => document.getElementById(id);
        if (el('train-start')) el('train-start').style.display = 'inline-flex';
        if (el('train-stop')) el('train-stop').style.display = 'none';
        if (el('training-panel')) el('training-panel').classList.remove('training-active');
        if (el('train-duration')) el('train-duration').disabled = false;
        if (el('train-email')) el('train-email').disabled = false;
        if (el('train-report-interval')) el('train-report-interval').disabled = false;
    }

    async _checkRunningTraining() {
        try {
            const s = await apiCall('GET', `${this.config.trainingEndpoint}/status?domain=${this.config.domain}`);
            if (s.is_running) {
                const el = (id) => document.getElementById(id);
                if (el('train-start')) el('train-start').style.display = 'none';
                if (el('train-stop')) el('train-stop').style.display = 'inline-flex';
                if (el('training-status')) el('training-status').style.display = 'grid';
                if (el('training-panel')) el('training-panel').classList.add('training-active');
                if (el('train-duration')) el('train-duration').disabled = true;
                if (el('train-email')) el('train-email').disabled = true;
                if (el('train-report-interval')) el('train-report-interval').disabled = true;
                // Restore email/report settings from server state
                if (s.report_email && el('train-email')) el('train-email').value = s.report_email;
                if (s.report_interval && el('train-report-interval')) el('train-report-interval').value = s.report_interval;
                this.trainingPollInterval = setInterval(() => this._pollTraining(), 5000);
                this._pollTraining();
            }
        } catch (e) { /* ignore */ }
    }

    // --- Audit ---
    async sendAuditQuestion() {
        const input = document.getElementById('audit-input');
        const question = input?.value?.trim();
        if (!question) return;
        input.value = '';

        const container = document.getElementById('audit-messages');
        const sendBtn = document.getElementById('audit-send-btn');
        if (sendBtn) sendBtn.disabled = true;

        const userDiv = document.createElement('div');
        userDiv.className = 'audit-msg audit-msg-user';
        userDiv.textContent = question;
        container.appendChild(userDiv);

        const typingDiv = document.createElement('div');
        typingDiv.className = 'audit-msg audit-msg-bot';
        typingDiv.innerHTML = '<span class="spinner"></span> Analyzing...';
        container.appendChild(typingDiv);
        container.scrollTop = container.scrollHeight;

        try {
            const data = await apiCall('POST', this.config.auditProvider.endpoint, { question });
            typingDiv.remove();
            const answerDiv = document.createElement('div');
            answerDiv.className = 'audit-msg audit-msg-bot';
            answerDiv.textContent = data.answer;
            if (data.sources) {
                const srcDiv = document.createElement('div');
                srcDiv.className = 'audit-msg-source';
                srcDiv.textContent = `Based on ${data.sources.benchmarks_analyzed} benchmarks, ${data.sources.total_scenarios} scenarios (${data.sources.overall_accuracy}% overall)`;
                answerDiv.appendChild(srcDiv);
            }
            container.appendChild(answerDiv);
        } catch (err) {
            typingDiv.remove();
            const errDiv = document.createElement('div');
            errDiv.className = 'audit-msg audit-msg-bot';
            errDiv.textContent = 'Error: ' + (err.message || 'Failed to get answer');
            errDiv.style.color = 'var(--danger)';
            container.appendChild(errDiv);
        } finally {
            if (sendBtn) sendBtn.disabled = false;
            container.scrollTop = container.scrollHeight;
            input.focus();
        }
    }

    // --- Audit Detail ("Why?" link) ---
    async _showAuditDetail(requestId, linkEl) {
        // Toggle: if detail panel already exists, remove it
        const existing = linkEl.parentElement?.querySelector('.chat-audit-detail');
        if (existing) { existing.remove(); return; }

        linkEl.textContent = '...';
        try {
            const data = await apiCall('GET', `/v0/preferences/audit/${requestId}?user_id=${USER_ID}`);

            const panel = document.createElement('div');
            panel.className = 'chat-audit-detail';

            let html = `<div class="audit-detail-header">Response Audit</div>`;
            html += `<div class="audit-detail-row"><span>Candidates evaluated:</span><strong>${data.candidate_count}</strong></div>`;
            if (data.winner_reason) {
                html += `<div class="audit-detail-row"><span>Reason:</span><span>${data.winner_reason}</span></div>`;
            }
            html += `<div class="audit-detail-row"><span>Memory cards used:</span><strong>${data.memory_cards_used}</strong></div>`;
            if (data.humor_gate_active) {
                html += `<div class="audit-detail-row"><span>Humor gate:</span><span>Active</span></div>`;
            }

            // Scoring breakdown bars
            if (data.scoring && data.scoring.length > 0) {
                html += `<div class="audit-detail-scoring">`;
                for (const s of data.scoring) {
                    const label = s.axis.replace(/_/g, ' ');
                    const pct = s.score != null ? Math.round(s.score * 100) : 0;
                    const weightPct = Math.round(s.weight * 100);
                    html += `<div class="audit-score-row">
                        <span class="audit-score-label">${label} <span class="audit-score-weight">(${weightPct}%)</span></span>
                        <div class="audit-score-bar"><div class="audit-score-fill" style="width:${pct}%"></div></div>
                        <span class="audit-score-value">${pct}%</span>
                    </div>`;
                }
                html += `</div>`;
            }

            panel.innerHTML = html;
            linkEl.parentElement.appendChild(panel);
        } catch (err) {
            // Show inline error
            const errSpan = document.createElement('span');
            errSpan.style.cssText = 'color:var(--danger);font-size:11px;margin-left:6px';
            errSpan.textContent = 'Audit unavailable';
            linkEl.parentElement.appendChild(errSpan);
            setTimeout(() => errSpan.remove(), 3000);
        } finally {
            linkEl.textContent = 'Why?';
        }
    }
}

// Export globally
window.AgentShell = AgentShell;
