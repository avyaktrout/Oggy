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
                durations: [5, 10, 15, 30, 60],
                defaultDuration: 10,
                showBenchmarks: true
            },
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

        this.STORAGE_KEY = `oggy_${this.config.domain}_chat`;
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
    }

    _renderNav() {
        const activePage = this.config.domain === 'payments' ? 'chat'
            : this.config.domain === 'general' ? 'v2'
            : 'v3';
        const nav = document.getElementById('nav');
        if (!nav) return;

        const adminLink = USER_ROLE === 'admin'
            ? `<a href="/admin.html" class="${activePage === 'admin' ? 'active' : ''}">Admin</a>`
            : '';

        nav.innerHTML = `
            <a href="/" class="nav-brand">Oggy</a>
            <a href="/" class="${activePage === 'enter' ? 'active' : ''}">Enter Payment</a>
            <a href="/payments.html" class="${activePage === 'view' ? 'active' : ''}">View Payments</a>
            <a href="/chat.html" class="${activePage === 'chat' ? 'active' : ''}">Chat</a>
            <a href="/v2-chat.html" class="${activePage === 'v2' ? 'active' : ''}">V2</a>
            <a href="/v3-chat.html" class="${activePage === 'v3' ? 'active' : ''}">V3</a>
            <a href="/analytics.html" class="${activePage === 'analytics' ? 'active' : ''}">Analytics</a>
            ${adminLink}
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

        const reqBody = { user_id: USER_ID, duration_minutes: duration, run_benchmarks: true };
        if (email) { reqBody.report_email = email; reqBody.report_interval = reportInterval; }

        try {
            await apiCall('POST', `${this.config.trainingEndpoint}/start`, reqBody);

            if (startBtn) startBtn.style.display = 'none';
            if (stopBtn) stopBtn.style.display = 'inline-flex';
            const status = document.getElementById('training-status');
            if (status) status.style.display = 'grid';
            const panel = document.getElementById('training-panel');
            if (panel) panel.classList.add('training-active');

            showToast(`Training started for ${duration} minutes`);
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
            await apiCall('POST', `${this.config.trainingEndpoint}/stop`, {});
            showToast('Training stopped');
        } catch (err) {
            showToast('Error stopping: ' + err.message, 'error');
        }
        this._resetTrainingUI();
    }

    async _pollTraining() {
        try {
            const s = await apiCall('GET', `${this.config.trainingEndpoint}/status`);
            const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
            setVal('ts-level', s.scale_level_display || '-');
            setVal('ts-accuracy', s.overall_accuracy || '-');
            setVal('ts-questions', `${s.correct_answers || 0}/${s.total_questions || 0}`);
            setVal('ts-benchmarks', `${s.benchmarks_passed || 0}/${s.benchmarks_generated || 0} passed`);
            setVal('ts-remaining', s.training_time_remaining_readable || '-');
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
            const s = await apiCall('GET', `${this.config.trainingEndpoint}/status`);
            if (s.is_running) {
                const el = (id) => document.getElementById(id);
                if (el('train-start')) el('train-start').style.display = 'none';
                if (el('train-stop')) el('train-stop').style.display = 'inline-flex';
                if (el('training-status')) el('training-status').style.display = 'grid';
                if (el('training-panel')) el('training-panel').classList.add('training-active');
                if (el('train-duration')) el('train-duration').disabled = true;
                if (el('train-email')) el('train-email').disabled = true;
                if (el('train-report-interval')) el('train-report-interval').disabled = true;
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
}

// Export globally
window.AgentShell = AgentShell;
