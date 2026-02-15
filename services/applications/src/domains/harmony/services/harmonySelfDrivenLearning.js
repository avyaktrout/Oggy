/**
 * Harmony Self-Driven Learning
 *
 * Training questions test Oggy on:
 * - Identifying missing indicators for a city
 * - Suggesting appropriate weights
 * - Predicting score impact of dimension changes
 * - Recommending data sources for uncovered indicators
 */

const { v4: uuidv4 } = require('uuid');
const { query } = require('../../../shared/utils/db');
const logger = require('../../../shared/utils/logger');
const providerResolver = require('../../../shared/providers/providerResolver');
const harmonySuggestionService = require('./harmonySuggestionService');

const instances = new Map();

class HarmonySelfDrivenLearning {
    constructor() {
        this.isRunning = false;
        this.interval = null;
        this.userId = null;
        this.sessionStats = { questionsAsked: 0, correct: 0, incorrect: 0 };
    }

    async start(userId, options = {}) {
        if (this.isRunning) return { status: 'already_running' };
        this.isRunning = true;
        this.userId = userId;
        this.mode = options.mode || 'training';
        // Preserve cumulative stats across stop/restart (e.g. benchmark pause/resume)
        if (!this.sessionStats || !this.sessionStats.questionsAsked) {
            this.sessionStats = { questionsAsked: 0, correct: 0, incorrect: 0 };
        }

        // Suggestion mode: shorter interval, more attempts per session
        const defaultInterval = this.mode === 'suggestions' ? 1 : 2;
        const defaultAttempts = this.mode === 'suggestions' ? 5 : 3;

        // Accept CLL-standard options: { interval (ms), practiceCount, enabled }
        const intervalMs = options.interval || (options.intervalMinutes || defaultInterval) * 60 * 1000;
        const attemptsPerSession = options.practiceCount || options.attemptsPerSession || defaultAttempts;

        this.interval = setInterval(() => {
            this.runLearningSession(attemptsPerSession).catch(err => {
                logger.error('Harmony SDL session error', { error: err.message, userId });
            });
        }, intervalMs);

        // Run first session immediately
        await this.runLearningSession(attemptsPerSession);
        return { status: 'started', intervalMs, attemptsPerSession, mode: this.mode };
    }

    stop() {
        if (this.interval) clearInterval(this.interval);
        this.interval = null;
        this.isRunning = false;
        return { status: 'stopped', stats: { ...this.sessionStats } };
    }

    getStats() {
        const total = this.sessionStats.questionsAsked;
        const correct = this.sessionStats.correct;
        return {
            total_attempts: total,
            correct: correct,
            incorrect: this.sessionStats.incorrect,
            accuracy: total > 0
                ? (correct / total * 100).toFixed(1) + '%'
                : '0%',
            is_running: this.isRunning,
            mode: this.mode || 'training'
        };
    }

    async runLearningSession(attempts = 3) {
        for (let i = 0; i < attempts; i++) {
            try {
                await this.practiceHarmonyQuestion();
            } catch (err) {
                logger.error('Harmony SDL practice error', { error: err.message, attempt: i });
            }
        }
    }

    async practiceHarmonyQuestion() {
        const traceId = uuidv4();
        const questionType = this._selectQuestionType();
        const assessment = await this._generateAssessment(questionType);
        if (!assessment) return;

        // Get Oggy's answer
        const oggyAnswer = await this._getOggyAnswer(assessment);

        // Evaluate the answer
        const evaluation = await this._evaluateAnswer(assessment, oggyAnswer);

        this.sessionStats.questionsAsked++;
        if (evaluation.correct) {
            this.sessionStats.correct++;
        } else {
            this.sessionStats.incorrect++;
        }

        // Update memory
        await this._updateMemory(traceId, assessment, oggyAnswer, evaluation);

        // Auto-generate suggestion from high-scoring city_expansion or data_source answers
        const suggestionThreshold = this.mode === 'suggestions' ? 3 : 4;
        if (evaluation.correct && evaluation.score >= suggestionThreshold &&
            ['city_expansion', 'data_source_recommendation', 'metric_identification'].includes(questionType)) {
            await this._createSuggestionFromLearning(traceId, assessment, oggyAnswer, evaluation);
        }

        return {
            correct: evaluation.correct,
            questionType,
            assessment: assessment.question,
            expectedAnswer: assessment.expectedAnswer,
            oggyAnswer: oggyAnswer,
            score: evaluation.score,
            trace_id: traceId,
        };
    }

    _selectQuestionType() {
        // Suggestion mode: 100% bias to types that generate suggestions
        if (this.mode === 'suggestions') {
            const r = Math.random();
            if (r < 0.40) return 'city_expansion';
            if (r < 0.70) return 'data_source_recommendation';
            return 'metric_identification';
        }
        const r = Math.random();
        if (r < 0.20) return 'indicator_classification';
        if (r < 0.35) return 'city_wellness_assessment';
        if (r < 0.50) return 'metric_identification';
        if (r < 0.65) return 'score_prediction';
        if (r < 0.80) return 'city_expansion';
        return 'data_source_recommendation';
    }

    async _generateAssessment(questionType) {
        try {
            // Load current state for context
            const nodes = await query(`
                SELECT n.name, n.scope, s.harmony, s.e_scaled, s.intent_coherence,
                       s.balance, s.flow, s.care, s.awareness, s.expression
                FROM harmony_nodes n
                LEFT JOIN harmony_scores s ON s.node_id = n.node_id
                WHERE n.scope = 'city'
                ORDER BY RANDOM() LIMIT 3
            `);

            const indicators = await query(`
                SELECT key, name, dimension, unit, direction FROM harmony_indicators LIMIT 30
            `);

            const cityContext = nodes.rows.map(n =>
                `${n.name}: H=${n.harmony || '?'}, E=${n.e_scaled || '?'}, S=${n.intent_coherence || '?'}, B=${n.balance || '?'}, F=${n.flow || '?'}, C=${n.care || '?'}, A=${n.awareness || '?'}, X=${n.expression || '?'}`
            ).join('\n');

            const indicatorList = indicators.rows.map(i => `${i.key} (${i.dimension}, ${i.direction})`).join(', ');
            const targetCity = nodes.rows[0]?.name || 'San Francisco';

            // Pick a random major city not in the map for expansion questions
            const expansionCities = ['New York City', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix',
                'Philadelphia', 'San Antonio', 'San Diego', 'Dallas', 'Austin', 'Seattle', 'Denver',
                'Boston', 'Nashville', 'Portland', 'Miami', 'Atlanta', 'Minneapolis', 'Detroit', 'Baltimore'];
            const existingNames = new Set(nodes.rows.map(n => n.name.toLowerCase()));
            const candidateCities = expansionCities.filter(c => !existingNames.has(c.toLowerCase()));
            const expansionCity = candidateCities[Math.floor(Math.random() * candidateCities.length)] || 'New York City';

            const prompts = {
                indicator_classification: {
                    question: `Which Harmony Map dimension does the indicator "${indicators.rows[Math.floor(Math.random() * indicators.rows.length)]?.name || 'public transit ridership'}" belong to? Choose from: Balance (safety/economic stability), Flow (mobility/infrastructure), Compassion (health/housing/food security), Discernment (education/civic engagement), Awareness (environmental/community), Expression (arts/cultural freedom). Explain your reasoning.`,
                    evaluationCriteria: 'Must choose exactly one correct dimension from the six options and provide valid reasoning for the classification',
                },
                city_wellness_assessment: {
                    question: `What factors make ${targetCity} a safe, free, and healthy city? Identify 3-5 real, observable factors across financial wellness (economic stability, housing affordability), health (healthcare access, food security, environmental quality), and societal wellness (safety, education, civic engagement). For each factor, name a specific publicly available metric or data source that measures it.`,
                    evaluationCriteria: 'Must identify real, verifiable factors with concrete publicly available metrics. Factors must span financial, health, and societal wellness. Metrics must be real and accessible.',
                },
                metric_identification: {
                    question: `What publicly available metric best captures the "${['Balance', 'Flow', 'Compassion', 'Discernment', 'Awareness', 'Expression'][Math.floor(Math.random() * 6)]}" dimension for ${targetCity}? Name the specific metric, the organization that publishes it, how often it's updated, and explain why it's the best single metric for this dimension.`,
                    evaluationCriteria: 'Must name a real, accessible metric from a real organization with plausible update frequency and valid reasoning for why it captures the dimension',
                },
                score_prediction: {
                    question: `If ${targetCity}'s violent crime rate dropped by 30%, predict the approximate change in: Balance (B), Equilibrium (E), and Harmony (H) scores. Current scores: ${cityContext}. Show your reasoning with the formula chain: crime → Balance → E = (B*F*C)^(1/3) → H = sqrt(E*S).`,
                    evaluationCriteria: 'Must show correct formula chain (crime → Balance → E → H), directionally correct predictions, and reasonable magnitude estimates',
                },
                city_expansion: {
                    question: `Should ${expansionCity} be added to the Harmony Map? Provide: (1) population and coordinates, (2) at least 3 publicly available data sources for its wellness indicators, (3) initial estimates for Balance, Flow, Compassion, Discernment, Awareness, and Expression scores (0-100 scale) with reasoning, (4) what unique insights this city would add to the map.`,
                    evaluationCriteria: 'Must provide accurate population/coordinates, name real data sources, give reasonable initial dimension scores with justification, and explain what value the city adds',
                },
                data_source_recommendation: {
                    question: `Recommend a specific publicly available data source that could improve the accuracy of the Harmony Map for ${targetCity} and potentially all tracked cities. Specify: source name, publishing organization, URL or access method, which indicators and dimensions it informs, update frequency, data quality considerations, and whether it improves a subset of nodes or all nodes.`,
                    evaluationCriteria: 'Must name a real, publicly accessible data source with plausible coverage, specify which dimensions it improves, and explain applicability (single city vs all nodes)',
                },
            };

            const prompt = prompts[questionType];
            return {
                question: prompt.question,
                evaluationCriteria: prompt.evaluationCriteria,
                questionType,
                targetCity,
                context: { cityContext, indicatorList },
            };
        } catch (err) {
            logger.error('Harmony SDL assessment generation failed', { error: err.message });
            return null;
        }
    }

    async _getOggyAnswer(assessment) {
        try {
            const resolved = await providerResolver.getAdapter(this.userId, 'oggy');
            const messages = [
                { role: 'system', content: 'You are Oggy, an expert on the Harmony Map wellbeing framework. The Harmony Map uses the Equilibrium Canon: H = sqrt(E * S), where E = (B*F*C)^(1/3) and S = sqrt(A*X). B=Balance, F=Flow, C=Care (Compassion*Discernment), A=Awareness, X=Expression. Answer precisely and concisely.' },
                { role: 'user', content: assessment.question },
            ];
            const response = await resolved.adapter.chatCompletion({
                model: resolved.model,
                messages,
                temperature: 0.4,
                max_tokens: 500,
            });
            return response.text || '';
        } catch (err) {
            logger.error('Harmony SDL Oggy answer failed', { error: err.message });
            return '';
        }
    }

    async _evaluateAnswer(assessment, oggyAnswer) {
        // Score threshold: answers scoring >= 3 out of 5 are considered correct
        // (matches general domain's approach for open-ended questions)
        const CORRECT_THRESHOLD = 3;

        try {
            const resolved = await providerResolver.getAdapter(this.userId, 'base');
            const messages = [
                { role: 'system', content: `You are an impartial judge evaluating an AI assistant's response about a city wellbeing framework.
Rate the response on a scale of 1-5:
  1 = Completely wrong or irrelevant
  2 = Partially relevant but major issues
  3 = Adequate — addresses the question with reasonable content
  4 = Good — well-structured, accurate, and insightful
  5 = Excellent — thorough, creative, and demonstrates deep understanding
Return ONLY valid JSON: { "score": <1-5>, "feedback": "..." }` },
                { role: 'user', content: `Question: ${assessment.question}\n\nEvaluation Criteria: ${assessment.evaluationCriteria}\n\nAnswer to evaluate:\n${oggyAnswer}\n\nReturn JSON only.` },
            ];
            const response = await resolved.adapter.chatCompletion({
                model: resolved.model,
                messages,
                temperature: 0.2,
                max_tokens: 300,
            });
            const text = response.text || '';
            const json = text.match(/\{[\s\S]*\}/);
            if (json) {
                const parsed = JSON.parse(json[0]);
                const score = parsed.score || 0;
                return {
                    correct: score >= CORRECT_THRESHOLD,
                    score,
                    feedback: parsed.feedback || ''
                };
            }
            return { correct: false, score: 0, feedback: 'Could not parse evaluation' };
        } catch (err) {
            logger.error('Harmony SDL evaluation failed', { error: err.message });
            return { correct: false, score: 0, feedback: err.message };
        }
    }

    async _createSuggestionFromLearning(traceId, assessment, oggyAnswer, evaluation) {
        try {
            const resolved = await providerResolver.getAdapter(this.userId, 'base');
            const messages = [
                { role: 'system', content: `Extract structured suggestion data from a training answer. Return ONLY valid JSON with these fields:
- suggestion_type: one of "new_city", "new_indicator", "model_update"
- title: short title (under 80 chars)
- description: 1-2 sentence explanation of the suggestion
- payload: object with relevant data depending on type:
  * new_city: { city_name, population, lat, lng, country, state, initial_scores: { balance, flow, compassion, discernment, awareness, expression } (0-100 scale), data_sources: ["source1", "source2"] }
  * new_indicator: { key: "snake_case_key", name: "Display Name", dimension: "balance|flow|compassion|discernment|awareness|expression", direction: "higher_is_better|lower_is_better", unit: "per 100k|%|index", description: "What it measures", bounds: { min: 0, max: 100 }, weight: 1.0, source_rationale: "Why this metric matters", target_city: "City Name or null if global" }
  * model_update: { change_description: "What to change", rationale: "Why", data_sources: ["source1"], applies_to: "all"|"subset"|"single" }

IMPORTANT: Do NOT use "new_data_point" type. PREFER "new_indicator" over "model_update" whenever the answer mentions a measurable metric, index, score, ranking, or data source — even if it references a specific city, set target_city accordingly. Only use "model_update" for abstract methodology changes that cannot be expressed as an indicator. If it recommends a new city, use "new_city".
For new_indicator: ONLY suggest GENERAL metrics that apply to ALL cities (e.g., "Air Quality Index", "Median Household Income"). NEVER suggest city-specific indicators.
CRITICAL SPECIFICITY RULES:
- Each indicator must measure EXACTLY ONE specific thing. Never combine multiple topics.
- Indicator names must be concise (under 60 chars) and be a metric name, NOT an action description.
- BAD: "Integrate American Community Survey data" or "Various socioeconomic and transportation metrics"
- GOOD: "Labor Force Participation Rate (%)" or "Average Commute Time (minutes)"
- If a data source covers multiple metrics, create ONLY the single most impactful one.
Return valid JSON only, no markdown.` },
                { role: 'user', content: `Question type: ${assessment.questionType}\nQuestion: ${assessment.question.substring(0, 300)}\nAnswer: ${oggyAnswer.substring(0, 800)}\nScore: ${evaluation.score}/5` },
            ];
            const response = await resolved.adapter.chatCompletion({
                model: resolved.model,
                messages,
                temperature: 0.2,
                max_tokens: 600,
            });
            const text = response.text || '';
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return;

            const parsed = JSON.parse(jsonMatch[0]);
            if (!parsed.suggestion_type || !parsed.title) return;

            // Resolve city name → node_id UUID
            let nodeId = null;
            const cityName = parsed.payload?.target_city || parsed.payload?.city_name || assessment.targetCity;
            if (cityName) {
                const nodeResult = await query(
                    "SELECT node_id FROM harmony_nodes WHERE LOWER(name) = LOWER($1) AND scope = 'city'",
                    [cityName]
                );
                if (nodeResult.rows[0]) nodeId = nodeResult.rows[0].node_id;
            }

            // Skip suggestions for things that already exist
            if (parsed.suggestion_type === 'new_city') {
                const newCityName = parsed.payload?.city_name || parsed.payload?.name;
                if (newCityName) {
                    const exists = await query("SELECT node_id FROM harmony_nodes WHERE LOWER(name) = LOWER($1) AND scope = 'city'", [newCityName]);
                    if (exists.rows.length > 0) {
                        logger.info('Harmony SDL skipping new_city for existing city', { city: newCityName, traceId });
                        return;
                    }
                }
            }
            if (parsed.suggestion_type === 'new_indicator') {
                const key = parsed.payload?.key;
                if (key) {
                    const exists = await query("SELECT indicator_id FROM harmony_indicators WHERE key = $1", [key]);
                    if (exists.rows.length > 0) {
                        logger.info('Harmony SDL skipping new_indicator for existing indicator', { key, traceId });
                        return;
                    }
                }
            }
            if (parsed.suggestion_type === 'model_update') {
                const key = parsed.payload?.key || parsed.payload?.indicator_key;
                if (key) {
                    const exists = await query("SELECT indicator_id FROM harmony_indicators WHERE key = $1", [key]);
                    if (exists.rows.length > 0) {
                        logger.info('Harmony SDL skipping model_update for existing indicator', { key, traceId });
                        return;
                    }
                }
            }

            await query(`
                INSERT INTO harmony_suggestions (suggestion_id, user_id, node_id, suggestion_type, title, description, payload, source, status, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, 'training', 'pending', NOW())
            `, [
                uuidv4(), this.userId, nodeId,
                parsed.suggestion_type,
                parsed.title.substring(0, 200),
                (parsed.description || '').substring(0, 500),
                JSON.stringify(parsed.payload || {}),
            ]);

            logger.info('Harmony SDL created suggestion from training', {
                type: parsed.suggestion_type,
                title: parsed.title,
                traceId,
            });
        } catch (err) {
            logger.warn('Harmony SDL suggestion creation failed (non-blocking)', { error: err.message });
        }
    }

    async _updateMemory(traceId, assessment, answer, evaluation) {
        try {
            const memoryHost = process.env.MEMORY_SERVICE_URL || 'http://memory-service:3000';
            const delta = evaluation.correct ? 0.1 : -0.15;

            await fetch(`${memoryHost}/utility/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: this.userId,
                    trace_id: traceId,
                    utility_weight_delta: delta,
                    domain: 'harmony',
                    metadata: {
                        question_type: assessment.questionType,
                        correct: evaluation.correct,
                        score: evaluation.score,
                    },
                }),
            });

            // If correct and high quality (score 4+), store domain knowledge
            if (evaluation.correct && evaluation.score >= 4) {
                await fetch(`${memoryHost}/cards`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        user_id: this.userId,
                        domain: 'harmony',
                        content: `[${assessment.questionType}] Q: ${assessment.question.substring(0, 200)} A: ${answer.substring(0, 300)}`,
                        source_type: 'training',
                        trace_id: traceId,
                    }),
                });
            }
        } catch (err) {
            logger.error('Harmony SDL memory update failed', { error: err.message });
        }
    }
}

function getInstance(userId, mode = 'training') {
    const key = mode === 'suggestions' ? `${userId}:suggestions` : userId;
    if (!instances.has(key)) {
        const inst = new HarmonySelfDrivenLearning();
        inst.userId = userId;
        instances.set(key, inst);
    }
    return instances.get(key);
}

module.exports = { getInstance };
