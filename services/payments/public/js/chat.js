// Chat page logic + Training controls
(function() {
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
                learn_from_chat: learnFromChat
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
    }

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

    // Restore chat and load inquiry preferences on page load
    restoreChat();
    loadInquiryPreferences();
})();
