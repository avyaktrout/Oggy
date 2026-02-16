// Chat page logic + Training controls
(async function() {
    const authed = await initAuth();
    if (!authed) return;
    renderNav('chat');
    startInquiryPolling();

    const STORAGE_KEY = 'oggy_chat';
    const MAX_TURNS = 50; // Max conversation turns before trimming oldest
    let learnFromChat = false;
    let trainingPollInterval = null;

    // --- Persistence ---
    function loadState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch { return null; }
    }

    function saveState(messages, history) {
        // Trim to MAX_TURNS (each turn = user + oggy + base = 3 entries in messages)
        const maxMessages = MAX_TURNS * 3;
        const maxHistory = MAX_TURNS * 2;
        const trimmedMessages = messages.length > maxMessages ? messages.slice(-maxMessages) : messages;
        const trimmedHistory = history.length > maxHistory ? history.slice(-maxHistory) : history;

        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                messages: trimmedMessages,
                history: trimmedHistory,
                learning: learnFromChat,
                savedAt: Date.now()
            }));
        } catch {
            // localStorage full — clear and continue
            localStorage.removeItem(STORAGE_KEY);
        }
    }

    // Messages array stores structured data for re-rendering
    // Each entry: { role: 'user'|'oggy'|'base', text: string, usedMemory?: bool, style?: string, requestId?: string }
    let messages = [];
    let conversationHistory = [];

    function restoreChat() {
        const state = loadState();
        if (!state || !state.messages || state.messages.length === 0) return;

        messages = state.messages;
        conversationHistory = state.history || [];
        learnFromChat = state.learning || false;

        // Update toggle
        const toggle = document.getElementById('learn-toggle');
        if (toggle) toggle.checked = learnFromChat;
        updateLearningIndicator();

        // Re-render messages
        const oggyContainer = document.getElementById('oggy-messages');
        const baseContainer = document.getElementById('base-messages');

        for (const msg of messages) {
            if (msg.role === 'user') {
                appendMsgEl(oggyContainer, msg.text, 'user');
                appendMsgEl(baseContainer, msg.text, 'user');
            } else if (msg.role === 'oggy') {
                const el = appendMsgEl(oggyContainer, msg.text, 'bot');
                if (msg.usedMemory) {
                    const memNote = document.createElement('div');
                    memNote.className = 'chat-msg-memory';
                    memNote.textContent = 'Used learned memory';
                    el.appendChild(memNote);
                }
            } else if (msg.role === 'base') {
                appendMsgEl(baseContainer, msg.text, 'bot');
            }
        }
    }

    function appendMsgEl(container, text, type) {
        const div = document.createElement('div');
        div.className = `chat-msg chat-msg-${type === 'user' ? 'user' : 'bot'}`;
        div.innerHTML = text;
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        return div;
    }

    // --- Chat ---
    window.sendChat = async function() {
        const input = document.getElementById('chat-input');
        const msg = input.value.trim();
        if (!msg) return;

        input.value = '';
        document.getElementById('chat-send-btn').disabled = true;

        // Show user message in both columns
        addMessage('oggy-messages', msg, 'user');
        addMessage('base-messages', msg, 'user');
        messages.push({ role: 'user', text: msg });

        // Show typing indicators
        const oggyTyping = addMessage('oggy-messages', '<span class="spinner"></span> Thinking...', 'bot');
        const baseTyping = addMessage('base-messages', '<span class="spinner"></span> Thinking...', 'bot');

        try {
            const data = await apiCall('POST', '/v0/chat', {
                user_id: USER_ID,
                message: msg,
                conversation_history: conversationHistory.slice(-10),
                learn_from_chat: learnFromChat,
                client_date: todayStr()
            });

            // Remove typing indicators
            oggyTyping.remove();
            baseTyping.remove();

            // Show responses
            const oggyEl = addMessage('oggy-messages', data.oggy_response.text, 'bot');
            if (data.oggy_response.used_memory) {
                const memNote = document.createElement('div');
                memNote.className = 'chat-msg-memory';
                memNote.textContent = 'Used learned memory';
                oggyEl.appendChild(memNote);
            }

            // Add feedback buttons to Oggy's response
            const feedbackDiv = document.createElement('div');
            feedbackDiv.className = 'chat-feedback';
            feedbackDiv.innerHTML = `
                <button class="feedback-btn feedback-like" onclick="sendFeedback('like', '${data.request_id || ''}', this)" title="Good response">&#x1F44D;</button>
                <button class="feedback-btn feedback-dislike" onclick="sendFeedback('dislike', '${data.request_id || ''}', this)" title="Could be better">&#x1F44E;</button>
            `;
            if (data.oggy_response.audit) {
                const auditTag = document.createElement('span');
                auditTag.className = 'chat-audit-tag';
                auditTag.textContent = data.oggy_response.style || '';
                if (data.oggy_response.audit.candidate_count > 1) {
                    auditTag.title = `Selected from ${data.oggy_response.audit.candidate_count} candidates (score: ${(data.oggy_response.audit.winner_score || 0).toFixed(2)})`;
                }
                feedbackDiv.appendChild(auditTag);
            }
            oggyEl.appendChild(feedbackDiv);

            addMessage('base-messages', data.base_response.text, 'bot');

            // Track conversation
            messages.push(
                { role: 'oggy', text: data.oggy_response.text, usedMemory: data.oggy_response.used_memory },
                { role: 'base', text: data.base_response.text }
            );
            conversationHistory.push(
                { role: 'user', content: msg },
                { role: 'assistant', content: data.oggy_response.text }
            );

            // Persist
            saveState(messages, conversationHistory);

        } catch (err) {
            oggyTyping.remove();
            baseTyping.remove();
            addMessage('oggy-messages', 'Error: ' + err.message, 'bot');
            addMessage('base-messages', 'Error: ' + err.message, 'bot');
        } finally {
            document.getElementById('chat-send-btn').disabled = false;
            input.focus();
        }
    };

    function addMessage(containerId, text, type) {
        const container = document.getElementById(containerId);
        const div = document.createElement('div');
        div.className = `chat-msg chat-msg-${type === 'user' ? 'user' : 'bot'}`;
        div.innerHTML = text;
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        return div;
    }

    // --- Clear Chat ---
    window.clearChat = function() {
        if (!confirm('Clear the entire conversation? This cannot be undone.')) return;
        messages = [];
        conversationHistory = [];
        localStorage.removeItem(STORAGE_KEY);

        // Reset message containers to defaults
        document.getElementById('oggy-messages').innerHTML =
            '<div class="chat-msg chat-msg-bot">Hi! I\'m Oggy. Ask me about your spending, or have me categorize an expense. I learn from our interactions!</div>';
        document.getElementById('base-messages').innerHTML =
            '<div class="chat-msg chat-msg-bot">Hi! I\'m the base model without memory. Compare my answers with Oggy\'s to see the difference learning makes.</div>';
        showToast('Conversation cleared');
    };

    // --- Learning Toggle ---
    window.toggleLearning = function(enabled) {
        learnFromChat = enabled;
        updateLearningIndicator();
        // Persist the toggle state
        saveState(messages, conversationHistory);
        showToast(enabled ? 'Learning from chat enabled' : 'Learning from chat disabled');
    };

    function updateLearningIndicator() {
        const indicator = document.getElementById('learning-indicator');
        if (indicator) indicator.style.display = learnFromChat ? 'inline' : 'none';
    }

    // --- Training Controls ---
    window.startTraining = async function() {
        const duration = parseInt(document.getElementById('train-duration').value);
        const email = document.getElementById('train-email').value.trim();
        const reportInterval = document.getElementById('train-report-interval').value;
        const startBtn = document.getElementById('train-start');
        const stopBtn = document.getElementById('train-stop');
        startBtn.disabled = true;
        startBtn.textContent = 'Starting...';

        const reqBody = {
            user_id: USER_ID,
            duration_minutes: duration,
            run_benchmarks: true
        };
        if (email) {
            reqBody.report_email = email;
            reqBody.report_interval = reportInterval;
        }

        try {
            await apiCall('POST', '/v0/continuous-learning/start', reqBody);

            startBtn.style.display = 'none';
            stopBtn.style.display = 'inline-flex';
            document.getElementById('training-status').style.display = 'grid';
            document.getElementById('training-panel').classList.add('training-active');
            document.getElementById('train-duration').disabled = true;
            document.getElementById('train-email').disabled = true;
            document.getElementById('train-report-interval').disabled = true;

            showToast(`Training started for ${duration} minutes`);

            // Start polling
            trainingPollInterval = setInterval(pollTrainingStatus, 5000);
            pollTrainingStatus();

        } catch (err) {
            showToast('Failed to start: ' + err.message, 'error');
        } finally {
            startBtn.disabled = false;
            startBtn.textContent = 'Start Training';
        }
    };

    window.stopTraining = async function() {
        try {
            await apiCall('POST', '/v0/continuous-learning/stop', {});
            showToast('Training stopped');
        } catch (err) {
            showToast('Error stopping: ' + err.message, 'error');
        }
        resetTrainingUI();
    };

    async function pollTrainingStatus() {
        try {
            const s = await apiCall('GET', '/v0/continuous-learning/status');

            document.getElementById('ts-level').textContent = s.scale_level_display || '-';
            document.getElementById('ts-accuracy').textContent = s.overall_accuracy || '-';
            document.getElementById('ts-questions').textContent = `${s.correct_answers || 0}/${s.total_questions || 0}`;
            document.getElementById('ts-benchmarks').textContent =
                `${s.benchmarks_passed || 0}/${s.benchmarks_generated || 0} passed`;
            document.getElementById('ts-remaining').textContent = s.training_time_remaining_readable || '-';
            document.getElementById('ts-status').textContent = s.status || '-';

            if (s.status === 'stopped' || !s.is_running) {
                resetTrainingUI();
                if (s.benchmarks_generated > 0) {
                    const lastBm = s.benchmark_results?.[s.benchmark_results.length - 1];
                    if (lastBm) {
                        showToast(
                            `Training complete! Oggy: ${(lastBm.oggy_accuracy * 100).toFixed(0)}% vs Base: ${(lastBm.base_accuracy * 100).toFixed(0)}%`,
                            lastBm.oggy_passed ? 'success' : 'info'
                        );
                    }
                }
            }
        } catch (err) {
            // ignore polling errors
        }
    }

    function resetTrainingUI() {
        if (trainingPollInterval) {
            clearInterval(trainingPollInterval);
            trainingPollInterval = null;
        }
        document.getElementById('train-start').style.display = 'inline-flex';
        document.getElementById('train-stop').style.display = 'none';
        document.getElementById('training-panel').classList.remove('training-active');
        document.getElementById('train-duration').disabled = false;
        document.getElementById('train-email').disabled = false;
        document.getElementById('train-report-interval').disabled = false;
    }

    // --- Feedback ---
    window.sendFeedback = async function(intent, requestId, btn) {
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

            // If dislike, show a quick follow-up for more specific feedback
            if (intent === 'dislike') {
                const options = document.createElement('div');
                options.className = 'feedback-options';
                options.innerHTML = `
                    <span class="feedback-label">What could be better?</span>
                    <button onclick="sendDetailedFeedback('verbosity', 'too verbose', this)">Too long</button>
                    <button onclick="sendDetailedFeedback('verbosity', 'too brief', this)">Too short</button>
                    <button onclick="sendDetailedFeedback('tone', 'too formal', this)">Too formal</button>
                    <button onclick="sendDetailedFeedback('tone', 'not helpful enough', this)">Not helpful</button>
                `;
                feedbackDiv.appendChild(options);
            }
        } catch (err) {
            showToast('Failed to record feedback', 'error');
        }
    };

    window.sendDetailedFeedback = async function(target, value, btn) {
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
        } catch (err) {
            // silent fail
        }
    };

    window.resetPreferences = async function() {
        if (!confirm('Reset all non-pinned preferences? Pinned preferences (from explicit statements) will be kept.')) return;
        try {
            const result = await apiCall('POST', '/v0/preferences/reset', { user_id: USER_ID });
            showToast(`Preferences reset (${result.reset_count} signals cleared)`);
        } catch (err) {
            showToast('Failed to reset: ' + err.message, 'error');
        }
    };

    // --- Inquiry Settings ---
    window.toggleInquiries = async function(enabled) {
        try {
            await apiCall('PUT', '/v0/inquiries/preferences', {
                user_id: USER_ID,
                enabled: enabled
            });
            showToast(enabled ? 'Self-driven inquiries enabled' : 'Self-driven inquiries disabled');
        } catch (err) {
            showToast('Failed to update: ' + err.message, 'error');
        }
    };

    window.updateInquiryLimit = async function(limit) {
        const val = parseInt(limit);
        try {
            await apiCall('PUT', '/v0/inquiries/preferences', {
                user_id: USER_ID,
                max_questions_per_day: val,
                enabled: val > 0
            });
            // Sync toggle with limit
            const toggle = document.getElementById('inquiry-toggle');
            if (toggle) toggle.checked = val > 0;
            showToast(`Daily inquiry limit set to ${val}`);
        } catch (err) {
            showToast('Failed to update: ' + err.message, 'error');
        }
    };

    // --- Suggestion Settings ---
    window.toggleSuggestions = async function(enabled) {
        try {
            await apiCall('PUT', '/v0/inquiries/suggestion-settings', {
                user_id: USER_ID,
                receive_suggestions: enabled
            });
            showToast(enabled ? 'Suggestions enabled — Oggy will share cost-cutting tips' : 'Suggestions disabled');
        } catch (err) {
            showToast('Failed to update: ' + err.message, 'error');
        }
    };

    window.updateSuggestionInterval = async function(seconds) {
        try {
            await apiCall('PUT', '/v0/inquiries/suggestion-settings', {
                user_id: USER_ID,
                suggestion_interval_seconds: parseInt(seconds)
            });
            showToast('Suggestion frequency updated');
        } catch (err) {
            showToast('Failed to update: ' + err.message, 'error');
        }
    };

    async function loadInquiryPreferences() {
        try {
            const prefs = await apiCall('GET', `/v0/inquiries/preferences?user_id=${USER_ID}`);
            const toggle = document.getElementById('inquiry-toggle');
            const limitSelect = document.getElementById('inquiry-limit');
            if (toggle) toggle.checked = prefs.enabled !== false;
            if (limitSelect) limitSelect.value = String(prefs.max_questions_per_day || 5);
        } catch (e) {
            // Inquiry system may not be ready
        }

        // Load suggestion settings
        try {
            const settings = await apiCall('GET', `/v0/inquiries/suggestion-settings?user_id=${USER_ID}`);
            const sugToggle = document.getElementById('suggestion-toggle');
            const sugInterval = document.getElementById('suggestion-interval');
            if (sugToggle) sugToggle.checked = settings.receive_suggestions === true;
            if (sugInterval) sugInterval.value = String(settings.suggestion_interval_seconds || 900);
        } catch (e) {
            // Suggestion system may not be ready
        }
    }

    // --- Observer Settings ---
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
            await apiCall('PUT', '/v0/observer/config', update);
            showToast('Observer setting updated');
        } catch (err) {
            showToast('Failed to update: ' + err.message, 'error');
        }
    };

    async function loadObserverConfig() {
        try {
            const config = await apiCall('GET', `/v0/observer/config?user_id=${USER_ID}`);
            const shareEl = document.getElementById('observer-share');
            const sugEl = document.getElementById('observer-suggestions');
            const merchEl = document.getElementById('observer-merchant');
            if (shareEl) shareEl.checked = config.share_learning === true;
            if (sugEl) sugEl.checked = config.receive_observer_suggestions === true;
            if (merchEl) merchEl.checked = config.receive_merchant_packs === true;
        } catch (e) {
            // Observer may not be ready
        }
    }

    async function loadObserverPacks() {
        const container = document.getElementById('observer-packs');
        try {
            const data = await apiCall('GET', '/v0/observer/packs');
            if (!data.packs || data.packs.length === 0) {
                container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">No packs available yet. Run an observer job to generate packs.</div>';
                return;
            }
            container.innerHTML = data.packs.map(pack => {
                const riskColor = pack.risk_level === 'low' ? 'var(--success)' :
                                  pack.risk_level === 'medium' ? 'var(--warning)' : 'var(--danger)';
                const rules = pack.rules || [];
                const isApplied = pack.status === 'applied';
                const isRolledBack = pack.status === 'rolled_back';
                return `
                    <div class="observer-pack-card">
                        <div class="observer-pack-header">
                            <strong>${pack.name}</strong>
                            <span class="observer-risk-badge" style="background:${riskColor}">${pack.risk_level}</span>
                        </div>
                        <div class="observer-pack-meta">
                            ${rules.length} rules | ${(pack.categories_covered || []).join(', ') || 'various'} |
                            +${pack.expected_lift || 0}% expected lift
                        </div>
                        <div class="observer-pack-actions">
                            ${isApplied ? `<button class="btn btn-sm btn-danger" onclick="rollbackPack('${pack.pack_id}')">Rollback</button>
                                          <span style="color:var(--success);font-size:12px">Applied</span>` :
                              isRolledBack ? `<span style="color:var(--text-muted);font-size:12px">Rolled back</span>` :
                              `<button class="btn btn-sm btn-success" onclick="applyPack('${pack.pack_id}')">Apply</button>`}
                        </div>
                    </div>
                `;
            }).join('');
        } catch (e) {
            container.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Failed to load packs</div>';
        }
    }

    window.applyPack = async function(packId) {
        try {
            const result = await apiCall('POST', '/v0/observer/import-pack', { pack_id: packId, user_id: USER_ID });
            showToast(`Pack applied: ${result.rules_applied} rules, ${result.cards_created} memory cards created`);
            loadObserverPacks();
        } catch (err) {
            showToast('Failed to apply pack: ' + err.message, 'error');
        }
    };

    window.rollbackPack = async function(packId) {
        if (!confirm('Rollback this observer pack? This will zero out the memory cards it created.')) return;
        try {
            const result = await apiCall('POST', '/v0/observer/rollback-pack', { pack_id: packId, user_id: USER_ID });
            showToast(`Pack rolled back: ${result.cards_rolled_back} cards affected`);
            loadObserverPacks();
        } catch (err) {
            showToast('Failed to rollback: ' + err.message, 'error');
        }
    };

    // --- Observer Job Dashboard ---
    async function loadObserverJobStatus() {
        try {
            const status = await apiCall('GET', '/v0/observer/job-status');
            const btn = document.getElementById('observer-run-btn');
            const dot = document.querySelector('.observer-status-dot');
            const text = document.getElementById('observer-status-text');
            const meta = document.getElementById('observer-job-meta');
            const autoRunEl = document.getElementById('observer-auto-run');

            if (autoRunEl) autoRunEl.checked = status.auto_run_active;

            if (status.is_running) {
                dot.className = 'observer-status-dot observer-status-running';
                text.textContent = 'Running...';
                btn.disabled = true;
                btn.style.opacity = '0.5';
            } else if (status.ready) {
                dot.className = 'observer-status-dot observer-status-ready';
                text.textContent = 'Ready';
                btn.disabled = false;
                btn.style.opacity = '1';
            } else {
                dot.className = 'observer-status-dot observer-status-unavailable';
                text.textContent = 'Unavailable';
                btn.disabled = true;
                btn.style.opacity = '0.5';
            }

            // Meta info line
            const parts = [];
            parts.push(`${status.sharing_tenants} tenant${status.sharing_tenants !== 1 ? 's' : ''} sharing`);
            if (status.last_run) {
                const ago = timeSince(new Date(status.last_run));
                parts.push(`last run ${ago}`);
                if (status.last_packs_generated > 0) parts.push(`${status.last_packs_generated} packs`);
            } else {
                parts.push('never run');
            }
            if (status.reason && !status.ready) parts.push(status.reason);
            meta.textContent = parts.join(' · ');
        } catch (e) {
            // Observer may not be ready
        }
    }

    function timeSince(date) {
        const s = Math.floor((Date.now() - date.getTime()) / 1000);
        if (s < 60) return 'just now';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        if (s < 86400) return Math.floor(s / 3600) + 'h ago';
        return Math.floor(s / 86400) + 'd ago';
    }

    window.toggleObserverAutoRun = async function(enabled) {
        try {
            if (enabled) {
                await apiCall('POST', '/v0/observer/run-job', { start_schedule: true });
                showToast('Observer auto-run enabled (every 6h)');
            } else {
                await apiCall('POST', '/v0/observer/run-job', { stop_schedule: true });
                showToast('Observer auto-run disabled');
            }
            loadObserverJobStatus();
        } catch (err) {
            showToast('Failed: ' + err.message, 'error');
        }
    };

    window.runObserverJob = async function() {
        try {
            const btn = document.getElementById('observer-run-btn');
            btn.disabled = true;
            btn.textContent = 'Running...';
            const result = await apiCall('POST', '/v0/observer/run-job', {});
            showToast(`Observer job complete: ${result.packs_generated} packs generated`);
            btn.textContent = 'Run Now';
            loadObserverPacks();
            loadObserverJobStatus();
        } catch (err) {
            showToast('Observer job failed: ' + err.message, 'error');
            document.getElementById('observer-run-btn').textContent = 'Run Now';
            loadObserverJobStatus();
        }
    };

    // Check if training is already running on page load
    (async function() {
        try {
            const s = await apiCall('GET', '/v0/continuous-learning/status');
            if (s.is_running) {
                document.getElementById('train-start').style.display = 'none';
                document.getElementById('train-stop').style.display = 'inline-flex';
                document.getElementById('training-status').style.display = 'grid';
                document.getElementById('training-panel').classList.add('training-active');
                document.getElementById('train-duration').disabled = true;
                document.getElementById('train-email').disabled = true;
                document.getElementById('train-report-interval').disabled = true;
                trainingPollInterval = setInterval(pollTrainingStatus, 5000);
                pollTrainingStatus();
            }
        } catch(e) {}
    })();

    // --- Audit Chat Panel ---
    window.toggleAuditPanel = function() {
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

    window.sendAuditQuestion = async function() {
        const input = document.getElementById('audit-input');
        const question = input.value.trim();
        if (!question) return;
        input.value = '';

        const container = document.getElementById('audit-messages');
        const sendBtn = document.getElementById('audit-send-btn');
        sendBtn.disabled = true;

        // Show user question
        const userDiv = document.createElement('div');
        userDiv.className = 'audit-msg audit-msg-user';
        userDiv.textContent = question;
        container.appendChild(userDiv);

        // Show typing indicator
        const typingDiv = document.createElement('div');
        typingDiv.className = 'audit-msg audit-msg-bot';
        typingDiv.innerHTML = '<span class="spinner"></span> Analyzing...';
        container.appendChild(typingDiv);
        container.scrollTop = container.scrollHeight;

        try {
            const data = await apiCall('POST', '/v0/benchmark-analytics/audit-chat', { question });
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
            sendBtn.disabled = false;
            container.scrollTop = container.scrollHeight;
            input.focus();
        }
    };

    // Restore chat and load inquiry preferences on page load
    restoreChat();
    loadInquiryPreferences();
})();
