/**
 * Behavior Engine - Candidate Generation, Scoring, and Selection
 * Behavior Design Doc Sections 3, 6, 8
 *
 * Flow: Generate N candidates -> Score each on rubric -> Select winner -> Write audit
 */

const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const circuitBreakerRegistry = require('../utils/circuitBreakerRegistry');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Section 8: Safety non-negotiables
const SAFETY_REFUSAL_PATTERNS = [
    /how\s+to\s+(hack|steal|rob|attack|kill|hurt|harm)/i,
    /make\s+a\s+(bomb|weapon|drug|poison)/i,
    /instructions?\s+for\s+(violence|fraud|theft)/i
];

// Section 6.1: Serious domains where humor is capped
const SERIOUS_DOMAIN_KEYWORDS = [
    'error', 'mistake', 'wrong', 'overcharged', 'fraud', 'stolen',
    'dispute', 'emergency', 'urgent', 'medical', 'legal', 'crisis',
    'lost money', 'missing payment', 'unauthorized'
];

const HUMOR_HARD_CAP = 0.1; // Section 6.1: cap humor score in serious domains

class BehaviorEngine {
    constructor(preferenceManager, responseAuditor) {
        this.prefManager = preferenceManager;
        this.auditor = responseAuditor;
        this.openaiBreaker = circuitBreakerRegistry.getOrCreate('openai-api', {
            failureThreshold: 3,
            timeout: 30000
        });
    }

    /**
     * Generate, score, and select the best response (Section 3)
     * Returns the winning candidate with audit trail
     */
    async selectResponse(userId, message, systemPrompt, conversationHistory = [], options = {}) {
        const requestId = options.requestId || crypto.randomUUID();
        const sessionId = options.sessionId || null;

        // Section 8: Check safety first
        const safetyCheck = this._checkSafety(message);
        if (safetyCheck.refused) {
            return {
                text: safetyCheck.response,
                audit: { refused: true, reason: 'safety_violation' }
            };
        }

        // Get user preference profile
        const profile = await this.prefManager.getProfile(userId);

        // Detect if serious domain (Section 6.1)
        const isSeriousDomain = this._isSeriousDomain(message);
        const humorGateActive = isSeriousDomain && !this._userInvitesPlay(message);

        // Section 3.1: Generate candidates with varied tone/verbosity
        const candidates = await this._generateCandidates(
            systemPrompt, message, conversationHistory, profile, humorGateActive
        );

        if (candidates.length === 0) {
            return {
                text: 'I wasn\'t able to generate a response. Please try again.',
                audit: { refused: false, reason: 'generation_failed' }
            };
        }

        // Section 3.2: Score each candidate
        const scoredCandidates = candidates.map((candidate, i) => ({
            index: i,
            text: candidate.text,
            style: candidate.style,
            hash: crypto.createHash('sha256').update(candidate.text).digest('hex').slice(0, 16),
            scores: this._scoreCandidateLocal(candidate, profile, humorGateActive, message)
        }));

        // Select winner (highest total score)
        scoredCandidates.sort((a, b) => b.scores.total - a.scores.total);
        const winner = scoredCandidates[0];

        // Section 3.3: Write audit trace
        const auditData = {
            request_id: requestId,
            user_id: userId,
            session_id: sessionId,
            candidate_count: candidates.length,
            candidates: scoredCandidates.map(c => ({
                index: c.index,
                hash: c.hash,
                style: c.style,
                scores: c.scores
            })),
            winner_index: winner.index,
            winner_reason: this._buildWinnerReason(winner, scoredCandidates),
            humor_gate_active: humorGateActive,
            memory_card_ids: options.memoryCardIds || []
        };

        await this.auditor.writeAudit(auditData);

        return {
            text: winner.text,
            style: winner.style,
            scores: winner.scores,
            audit: {
                audit_id: auditData.request_id,
                candidate_count: candidates.length,
                winner_score: winner.scores.total,
                humor_gate_active: humorGateActive
            }
        };
    }

    /**
     * Generate N candidate responses (Section 3.1)
     * Vary by tone and verbosity
     */
    async _generateCandidates(systemPrompt, message, history, profile, humorGateActive) {
        const styles = this._selectStyles(profile, humorGateActive);
        const candidates = [];

        // Generate candidates in parallel for speed
        const promises = styles.map(style =>
            this._generateSingleCandidate(systemPrompt, message, history, style)
                .catch(err => {
                    logger.warn('Candidate generation failed', { style: style.name, error: err.message });
                    return null;
                })
        );

        const results = await Promise.all(promises);
        for (const result of results) {
            if (result) candidates.push(result);
        }

        return candidates;
    }

    /**
     * Select which styles to generate based on profile
     */
    _selectStyles(profile, humorGateActive) {
        const styles = [
            { name: 'concise', instruction: 'Be concise and direct. Give the essential answer in 1-2 sentences.', temperature: 0.3 },
            { name: 'detailed', instruction: 'Be thorough and detailed. Provide context and explanation.', temperature: 0.5 },
            { name: 'friendly', instruction: 'Be warm and conversational. Use a friendly, approachable tone.', temperature: 0.6 }
        ];

        // Only add playful style if humor gate is not active
        if (!humorGateActive) {
            styles.push({
                name: 'playful',
                instruction: 'Be light and slightly playful while still being helpful. A touch of personality is okay.',
                temperature: 0.7
            });
        }

        return styles;
    }

    async _generateSingleCandidate(systemPrompt, message, history, style) {
        const styledPrompt = `${systemPrompt}\n\nResponse style: ${style.instruction}`;
        const messages = [
            { role: 'system', content: styledPrompt },
            ...history.slice(-10),
            { role: 'user', content: message }
        ];

        const response = await this.openaiBreaker.execute(() =>
            axios.post('https://api.openai.com/v1/chat/completions', {
                model: OPENAI_MODEL,
                messages,
                temperature: style.temperature,
                max_tokens: 500
            }, {
                headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
                timeout: 15000
            })
        );

        return {
            text: response.data.choices[0].message.content,
            style: style.name,
            temperature: style.temperature,
            tokens_used: response.data.usage?.total_tokens || 0
        };
    }

    /**
     * Score a candidate against the rubric (Section 3.2)
     * All scores on 0-1 scale
     */
    _scoreCandidateLocal(candidate, profile, humorGateActive, message) {
        const scores = {
            function_relevance: this._scoreFunctionRelevance(candidate, message),
            preference_fit: this._scorePreferenceFit(candidate, profile),
            safety: this._scoreSafety(candidate),
            tone_fit: this._scoreToneFit(candidate, profile, humorGateActive),
            uncertainty_penalty: this._scoreUncertainty(candidate)
        };

        // Weighted combination
        scores.total = (
            scores.function_relevance * 0.35 +
            scores.preference_fit * 0.20 +
            scores.safety * 0.20 +
            scores.tone_fit * 0.15 +
            scores.uncertainty_penalty * 0.10
        );

        return scores;
    }

    _scoreFunctionRelevance(candidate, message) {
        // Heuristic: longer responses with content related to the question score higher
        const text = candidate.text.toLowerCase();
        const words = message.toLowerCase().split(/\s+/);
        const relevantWords = words.filter(w => w.length > 3 && text.includes(w));
        const coverage = words.length > 0 ? relevantWords.length / words.length : 0;

        // Penalize very short or error responses
        if (candidate.text.length < 20) return 0.3;
        if (candidate.text.includes('error') && candidate.text.includes('try again')) return 0.2;

        return Math.min(1.0, 0.5 + coverage * 0.5);
    }

    _scorePreferenceFit(candidate, profile) {
        if (!profile || !profile.preferences) return 0.7; // Default neutral score

        let score = 0.7;
        const text = candidate.text;

        // Verbosity preference
        const verbPref = profile.preferences.verbosity || {};
        if (verbPref['concise'] > 0 && candidate.style === 'concise') score += 0.15;
        if (verbPref['detailed'] > 0 && candidate.style === 'detailed') score += 0.15;
        if (verbPref['concise'] < 0 && candidate.style === 'concise') score -= 0.15;

        // Tone preference
        const tonePref = profile.preferences.tone || {};
        if (tonePref['friendly'] > 0 && candidate.style === 'friendly') score += 0.1;
        if (tonePref['formal'] > 0 && candidate.style === 'concise') score += 0.1;

        return Math.max(0, Math.min(1, score));
    }

    _scoreSafety(candidate) {
        const text = candidate.text;
        // Check for coercive language (Section 8)
        const coercivePatterns = [
            /i (decided|chose) for you/i,
            /you (must|have to|need to) do/i,
            /don't question/i,
            /just trust me/i
        ];

        let score = 1.0;
        for (const pattern of coercivePatterns) {
            if (pattern.test(text)) score -= 0.3;
        }

        return Math.max(0, score);
    }

    _scoreToneFit(candidate, profile, humorGateActive) {
        let score = 0.8;
        const text = candidate.text;

        // Section 6.1: If humor gate is active, penalize humor
        if (humorGateActive) {
            const humorIndicators = ['haha', 'lol', '😄', '😂', '🎉', 'joke', 'funny'];
            const hasHumor = humorIndicators.some(h => text.toLowerCase().includes(h));
            if (hasHumor) {
                score = Math.min(score, HUMOR_HARD_CAP);
            }
        }

        // Check humor params
        if (profile?.humor_params) {
            const hp = profile.humor_params;
            if (hp.avoid_sarcasm && /sarcas/i.test(text)) score -= 0.2;
        }

        // Penalize condescending tone
        if (/obviously|clearly you|as I already said/i.test(text)) score -= 0.3;

        return Math.max(0, Math.min(1, score));
    }

    _scoreUncertainty(candidate) {
        const text = candidate.text;
        // Reward calibration: explicit assumptions and hedging
        const calibrationPhrases = [
            'based on', 'it appears', 'from what I can see',
            'I think', 'it seems', 'approximately', 'roughly'
        ];
        const overconfidentPhrases = [
            'definitely', 'absolutely', 'without a doubt',
            'certainly', 'guaranteed', 'always', 'never'
        ];

        let score = 0.7;
        const lower = text.toLowerCase();

        for (const phrase of calibrationPhrases) {
            if (lower.includes(phrase)) { score += 0.05; break; }
        }
        for (const phrase of overconfidentPhrases) {
            if (lower.includes(phrase)) { score -= 0.1; break; }
        }

        return Math.max(0, Math.min(1, score));
    }

    /**
     * Section 8: Safety non-negotiables
     */
    _checkSafety(message) {
        for (const pattern of SAFETY_REFUSAL_PATTERNS) {
            if (pattern.test(message)) {
                return {
                    refused: true,
                    response: 'I can\'t help with that request. I\'m a payments assistant focused on helping you manage your expenses and spending patterns.'
                };
            }
        }
        return { refused: false };
    }

    /**
     * Section 6.1: Detect serious domain
     */
    _isSeriousDomain(message) {
        const lower = message.toLowerCase();
        return SERIOUS_DOMAIN_KEYWORDS.some(kw => lower.includes(kw));
    }

    /**
     * Section 6.1: Check if user explicitly invites play
     */
    _userInvitesPlay(message) {
        const playInvites = ['joke', 'funny', 'make me laugh', 'lighten up', 'be playful'];
        const lower = message.toLowerCase();
        return playInvites.some(p => lower.includes(p));
    }

    _buildWinnerReason(winner, allCandidates) {
        if (allCandidates.length === 1) return 'Only candidate generated';

        const secondBest = allCandidates[1];
        const margin = (winner.scores.total - secondBest.scores.total).toFixed(3);
        const topAxis = Object.entries(winner.scores)
            .filter(([k]) => k !== 'total')
            .sort(([, a], [, b]) => b - a)[0];

        return `${winner.style} style won by ${margin} margin. Strongest axis: ${topAxis[0]} (${topAxis[1].toFixed(2)})`;
    }
}

module.exports = BehaviorEngine;
