/**
 * Domain Learning Service
 * Manages domain tags, knowledge packs, apply/rollback, study plans.
 */

const axios = require('axios');
const { query } = require('../../../shared/utils/db');
const logger = require('../../../shared/utils/logger');
const { costGovernor } = require('../../../shared/middleware/costGovernor');
const circuitBreakerRegistry = require('../../../shared/utils/circuitBreakerRegistry');
const providerResolver = require('../../../shared/providers/providerResolver');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory-service:3000';

class DomainLearningService {
    constructor() {
        this.openaiBreaker = circuitBreakerRegistry.getOrCreate('openai-api');
        this.memoryBreaker = circuitBreakerRegistry.getOrCreate('memory-service');
    }

    /**
     * Map platform identifier to site domain for Google site-scoped search.
     */
    _platformToSiteDomain(platform) {
        const map = {
            wikipedia: 'en.wikipedia.org',
            youtube: 'youtube.com',
            khanacademy: 'khanacademy.org',
            mdn: 'developer.mozilla.org',
            freecodecamp: 'freecodecamp.org',
            w3schools: 'w3schools.com',
            geeksforgeeks: 'geeksforgeeks.org',
            coursera: 'coursera.org',
            edx: 'edx.org'
        };
        return map[platform] || null;
    }

    /**
     * Build a fallback Google search URL scoped to a specific site.
     */
    _buildFallbackUrl(title, platform) {
        const siteDomain = this._platformToSiteDomain(platform);
        const terms = title || '';
        if (siteDomain) {
            return `https://www.google.com/search?q=site:${siteDomain}+${encodeURIComponent(terms)}`;
        }
        return `https://www.google.com/search?q=${encodeURIComponent(terms)}`;
    }

    /**
     * Validate a URL with HEAD request, falling back to GET if HEAD is blocked.
     */
    async _validateUrl(url) {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html'
        };
        // Try HEAD first
        try {
            await axios.head(url, {
                timeout: 5000, maxRedirects: 5,
                validateStatus: (s) => s < 400,
                headers
            });
            return true;
        } catch (headErr) {
            const status = headErr.response?.status;
            // If HEAD returned 405/403, the page may still exist — try GET
            if (status === 405 || status === 403) {
                try {
                    await axios.get(url, {
                        timeout: 5000, maxRedirects: 5,
                        validateStatus: (s) => s < 400,
                        headers: { ...headers, 'Range': 'bytes=0-0' },
                        responseType: 'stream'
                    });
                    return true;
                } catch { return false; }
            }
            return false;
        }
    }

    /**
     * Post-process study plan: validate all resource URLs, replace broken ones with search fallbacks.
     */
    async _resolveStudyPlanUrls(plan) {
        const allResources = [];
        for (const topic of (plan.topics || [])) {
            for (const r of (topic.resources || [])) {
                if (r.url) allResources.push(r);
            }
        }

        // Validate all URLs in parallel (max 5s each, all concurrent)
        const validations = await Promise.allSettled(
            allResources.map(async (r) => {
                const valid = await this._validateUrl(r.url);
                if (!valid) {
                    // Detect platform from URL for better fallback
                    let platform = 'general';
                    for (const [key, domain] of Object.entries({
                        wikipedia: 'wikipedia.org', youtube: 'youtube.com',
                        khanacademy: 'khanacademy.org', mdn: 'developer.mozilla.org',
                        freecodecamp: 'freecodecamp.org', w3schools: 'w3schools.com',
                        geeksforgeeks: 'geeksforgeeks.org', coursera: 'coursera.org',
                        edx: 'edx.org'
                    })) {
                        if (r.url.includes(domain)) { platform = key; break; }
                    }
                    r.url = this._buildFallbackUrl(r.title, platform);
                    r.fallback = true;
                }
            })
        );

        return plan;
    }

    /**
     * Strip markdown code fences and clean LLM JSON output.
     */
    _cleanJson(text) {
        let cleaned = text.trim();
        // Remove ```json ... ``` or ``` ... ``` wrapping
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```$/i, '');
        return cleaned.trim();
    }

    /**
     * Suggest domain tags for a project based on name + recent messages.
     */
    async suggestDomainTags(userId, projectId) {
        // Get project info + recent messages
        const projResult = await query(
            'SELECT name, description FROM v2_projects WHERE project_id = $1 AND user_id = $2',
            [projectId, userId]
        );
        if (!projResult.rows.length) throw new Error('Project not found');
        const project = projResult.rows[0];

        const msgResult = await query(
            `SELECT content FROM v2_project_messages
             WHERE project_id = $1 AND user_id = $2 AND role = 'user'
             ORDER BY created_at DESC LIMIT 10`,
            [projectId, userId]
        );
        const recentMessages = msgResult.rows.map(r => r.content).join('\n').substring(0, 1500);

        // Get existing tags to avoid duplicates
        const existingResult = await query(
            `SELECT tag FROM dl_domain_tags WHERE user_id = $1 AND status IN ('enabled', 'suggested')`,
            [userId]
        );
        const existingTags = existingResult.rows.map(r => r.tag);

        const prompt = `Analyze this project and suggest 2-4 domain knowledge tags that would help the user.

Project: ${project.name}
Description: ${project.description || 'None'}
Recent messages:
${recentMessages || 'No messages yet'}

Existing tags to avoid: ${existingTags.join(', ') || 'none'}

Return a JSON array. Each item:
- "tag": lowercase slug (e.g., "calculus", "react_hooks", "machine_learning")
- "display_name": human-readable (e.g., "Calculus", "React Hooks", "Machine Learning")
- "description": 1-sentence description of what knowledge this covers

Only suggest tags where domain-specific knowledge would genuinely help. Return [] if the project doesn't need domain knowledge.
Respond with ONLY the JSON array.`;

        await costGovernor.checkBudget(1000);
        const resolved = await providerResolver.getAdapter(userId, 'oggy');
        const result = await this.openaiBreaker.execute(() =>
            resolved.adapter.chatCompletion({
                model: resolved.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 500,
                timeout: 30000
            })
        );
        costGovernor.recordUsage(result.tokens_used || 1000);
        providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'domainTagSuggest', result.tokens_used, result.latency_ms, true, null);

        let suggestions;
        try {
            suggestions = JSON.parse(this._cleanJson(result.text));
            if (!Array.isArray(suggestions)) suggestions = [];
        } catch {
            suggestions = [];
        }

        // Store suggestions in DB
        const stored = [];
        for (const s of suggestions) {
            if (!s.tag) continue;
            try {
                const ins = await query(
                    `INSERT INTO dl_domain_tags (user_id, tag, display_name, description, status, source)
                     VALUES ($1, $2, $3, $4, 'suggested', 'llm_suggestion')
                     ON CONFLICT (user_id, tag) DO UPDATE SET display_name = EXCLUDED.display_name, description = EXCLUDED.description
                     RETURNING tag_id, tag, display_name, description, status`,
                    [userId, s.tag, s.display_name, s.description]
                );
                stored.push(ins.rows[0]);
            } catch (err) {
                logger.debug('Failed to store domain tag', { error: err.message, tag: s.tag });
            }
        }

        // Audit
        await this._audit(userId, projectId, 'tags_suggested', { tags: stored.map(t => t.tag) });

        return stored;
    }

    /**
     * Enable a domain tag for a project.
     */
    async enableDomainTag(userId, projectId, tagId) {
        await query(
            `UPDATE dl_domain_tags SET status = 'enabled' WHERE tag_id = $1 AND user_id = $2`,
            [tagId, userId]
        );
        await query(
            `INSERT INTO dl_project_domain_tags (project_id, tag_id)
             VALUES ($1, $2) ON CONFLICT (project_id, tag_id) DO NOTHING`,
            [projectId, tagId]
        );
        await this._audit(userId, projectId, 'tag_enabled', { tag_id: tagId });
    }

    /**
     * Decline a domain tag.
     */
    async declineDomainTag(userId, tagId) {
        await query(
            `UPDATE dl_domain_tags SET status = 'declined' WHERE tag_id = $1 AND user_id = $2`,
            [tagId, userId]
        );
        await this._audit(userId, null, 'tag_declined', { tag_id: tagId });
    }

    /**
     * Build a knowledge pack for a domain tag.
     * LLM generates 10-20 knowledge cards covering the domain.
     */
    async buildKnowledgePack(userId, tagId) {
        const tagResult = await query(
            'SELECT tag, display_name, description FROM dl_domain_tags WHERE tag_id = $1 AND user_id = $2',
            [tagId, userId]
        );
        if (!tagResult.rows.length) throw new Error('Tag not found');
        const tag = tagResult.rows[0];

        // Get current version
        const versionResult = await query(
            'SELECT COALESCE(MAX(version), 0) + 1 as next_version FROM dl_knowledge_packs WHERE tag_id = $1 AND user_id = $2',
            [tagId, userId]
        );
        const version = versionResult.rows[0].next_version;

        const prompt = `Generate a comprehensive knowledge pack for the domain: "${tag.display_name || tag.tag}"
Description: ${tag.description || 'General knowledge about ' + tag.tag}

Create 12-18 knowledge cards covering key concepts, formulas, patterns, and best practices.
Each card should be a standalone fact/concept that helps a learner.

Return a JSON object:
{
  "summary": "Brief summary of what this pack covers",
  "cards": [
    {
      "topic": "Short topic name",
      "summary": "Clear, concise explanation (2-4 sentences). Include formulas, examples, or key details."
    }
  ],
  "coverage": {
    "fundamentals": true/false,
    "intermediate": true/false,
    "advanced": true/false,
    "practical": true/false
  }
}

Make cards progressively more advanced. Include practical application tips.
Respond with ONLY the JSON object.`;

        await costGovernor.checkBudget(5000);
        const resolved = await providerResolver.getAdapter(userId, 'oggy');
        const result = await this.openaiBreaker.execute(() =>
            resolved.adapter.chatCompletion({
                model: resolved.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.4,
                max_tokens: 3000,
                timeout: 60000
            })
        );
        const tokenCost = result.tokens_used || 5000;
        costGovernor.recordUsage(tokenCost);
        providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'buildKnowledgePack', result.tokens_used, result.latency_ms, true, null);

        let packData;
        try {
            packData = JSON.parse(this._cleanJson(result.text));
        } catch {
            throw new Error('Failed to parse knowledge pack from LLM');
        }

        const cards = packData.cards || [];
        if (cards.length === 0) throw new Error('LLM generated no cards');

        // Create pack
        const packResult = await query(
            `INSERT INTO dl_knowledge_packs (tag_id, user_id, version, status, summary, card_count, coverage_metrics, token_cost)
             VALUES ($1, $2, $3, 'ready', $4, $5, $6, $7)
             RETURNING pack_id`,
            [tagId, userId, version, packData.summary, cards.length,
             JSON.stringify(packData.coverage || {}), tokenCost]
        );
        const packId = packResult.rows[0].pack_id;

        // Create cards
        for (const card of cards) {
            await query(
                `INSERT INTO dl_knowledge_cards (pack_id, tag_id, topic, summary)
                 VALUES ($1, $2, $3, $4)`,
                [packId, tagId, card.topic, card.summary]
            );
        }

        await this._audit(userId, null, 'pack_built', {
            tag_id: tagId, pack_id: packId, version, card_count: cards.length, token_cost: tokenCost
        });

        logger.info('Knowledge pack built', { tagId, packId, version, cards: cards.length });

        return {
            pack_id: packId,
            version,
            status: 'ready',
            summary: packData.summary,
            card_count: cards.length,
            coverage: packData.coverage
        };
    }

    /**
     * Get packs for a tag.
     */
    async getPacks(userId, tagId) {
        const result = await query(
            `SELECT pack_id, version, status, summary, card_count, coverage_metrics, token_cost, created_at
             FROM dl_knowledge_packs WHERE tag_id = $1 AND user_id = $2
             ORDER BY version DESC`,
            [tagId, userId]
        );
        return result.rows;
    }

    /**
     * Get pack diff against previous version.
     */
    async getPackDiff(userId, packId) {
        const packResult = await query(
            `SELECT p.pack_id, p.tag_id, p.version, p.summary, p.card_count
             FROM dl_knowledge_packs p WHERE p.pack_id = $1 AND p.user_id = $2`,
            [packId, userId]
        );
        if (!packResult.rows.length) throw new Error('Pack not found');
        const pack = packResult.rows[0];

        // Current cards
        const currentCards = await query(
            'SELECT topic, summary FROM dl_knowledge_cards WHERE pack_id = $1 ORDER BY topic',
            [packId]
        );

        // Previous version cards
        const prevPackResult = await query(
            `SELECT pack_id FROM dl_knowledge_packs
             WHERE tag_id = $1 AND user_id = $2 AND version < $3
             ORDER BY version DESC LIMIT 1`,
            [pack.tag_id, userId, pack.version]
        );

        let previousCards = [];
        if (prevPackResult.rows.length) {
            const prev = await query(
                'SELECT topic, summary FROM dl_knowledge_cards WHERE pack_id = $1 ORDER BY topic',
                [prevPackResult.rows[0].pack_id]
            );
            previousCards = prev.rows;
        }

        const prevTopics = new Set(previousCards.map(c => c.topic));
        const currTopics = new Set(currentCards.rows.map(c => c.topic));

        return {
            pack_id: packId,
            version: pack.version,
            current_cards: currentCards.rows,
            added: currentCards.rows.filter(c => !prevTopics.has(c.topic)),
            removed: previousCards.filter(c => !currTopics.has(c.topic)),
            total_current: currentCards.rows.length,
            total_previous: previousCards.length
        };
    }

    /**
     * Apply a knowledge pack — creates memory cards via memory-service.
     */
    async applyPack(userId, projectId, packId) {
        const packResult = await query(
            `SELECT p.pack_id, p.tag_id, p.status, t.tag, t.display_name
             FROM dl_knowledge_packs p JOIN dl_domain_tags t ON t.tag_id = p.tag_id
             WHERE p.pack_id = $1 AND p.user_id = $2`,
            [packId, userId]
        );
        if (!packResult.rows.length) throw new Error('Pack not found');
        const pack = packResult.rows[0];

        if (pack.status === 'applied') throw new Error('Pack already applied');

        // Get cards
        const cards = await query(
            'SELECT card_id, topic, summary, confidence FROM dl_knowledge_cards WHERE pack_id = $1',
            [packId]
        );

        let stored = 0;
        for (const card of cards.rows) {
            try {
                const memResult = await this.memoryBreaker.execute(() =>
                    axios.post(`${MEMORY_SERVICE_URL}/cards`, {
                        owner_type: 'user',
                        owner_id: userId,
                        tier: 2,
                        kind: 'domain_knowledge',
                        content: {
                            type: 'FACT',
                            text: `[${pack.display_name || pack.tag}] ${card.topic}: ${card.summary}`,
                            source: 'domain_learning',
                            domain_tag: pack.tag,
                            confidence: card.confidence
                        },
                        tags: ['general', 'conversation', 'domain_knowledge', pack.tag],
                        utility_weight: 0.8,
                        reliability: card.confidence || 0.8
                    }, {
                        timeout: 5000,
                        headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                    })
                );

                // Store memory card ID reference
                const memoryCardId = memResult.data?.card_id || memResult.data?.id;
                if (memoryCardId) {
                    await query(
                        'UPDATE dl_knowledge_cards SET memory_card_id = $1 WHERE card_id = $2',
                        [memoryCardId, card.card_id]
                    );
                }
                stored++;
            } catch (err) {
                logger.debug('Failed to create memory card for knowledge card', {
                    error: err.message, cardId: card.card_id
                });
            }
        }

        // Update pack status
        await query(
            "UPDATE dl_knowledge_packs SET status = 'applied' WHERE pack_id = $1",
            [packId]
        );

        // Update project pack state
        await query(
            `INSERT INTO dl_project_pack_state (project_id, tag_id, active_pack_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (project_id, tag_id) DO UPDATE SET
                previous_pack_id = dl_project_pack_state.active_pack_id,
                active_pack_id = EXCLUDED.active_pack_id,
                updated_at = NOW()`,
            [projectId, pack.tag_id, packId]
        );

        await this._audit(userId, projectId, 'pack_applied', {
            pack_id: packId, tag: pack.tag, cards_stored: stored
        });

        logger.info('Knowledge pack applied', { packId, stored, total: cards.rows.length });
        return { stored, total: cards.rows.length };
    }

    /**
     * Reject a pack (mark as rejected without applying).
     */
    async rejectPack(userId, packId) {
        await query(
            "UPDATE dl_knowledge_packs SET status = 'rejected' WHERE pack_id = $1 AND user_id = $2",
            [packId, userId]
        );
        await this._audit(userId, null, 'pack_rejected', { pack_id: packId });
    }

    /**
     * Rollback a domain tag's applied pack — zeros utility_weight on memory cards.
     */
    async rollbackPack(userId, projectId, tagId) {
        // Get applied cards with memory_card_ids
        const cardsResult = await query(
            `SELECT kc.memory_card_id
             FROM dl_knowledge_cards kc
             JOIN dl_knowledge_packs kp ON kp.pack_id = kc.pack_id
             JOIN dl_project_pack_state ps ON ps.active_pack_id = kp.pack_id
             WHERE ps.project_id = $1 AND ps.tag_id = $2 AND kc.memory_card_id IS NOT NULL`,
            [projectId, tagId]
        );

        let rolled = 0;
        for (const card of cardsResult.rows) {
            try {
                await this.memoryBreaker.execute(() =>
                    axios.patch(`${MEMORY_SERVICE_URL}/cards/${card.memory_card_id}`, {
                        utility_weight: 0
                    }, {
                        timeout: 5000,
                        headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                    })
                );
                rolled++;
            } catch (err) {
                logger.debug('Failed to zero memory card', { error: err.message, memoryCardId: card.memory_card_id });
            }
        }

        // Update pack status
        await query(
            `UPDATE dl_knowledge_packs SET status = 'rolled_back'
             WHERE pack_id = (SELECT active_pack_id FROM dl_project_pack_state WHERE project_id = $1 AND tag_id = $2)`,
            [projectId, tagId]
        );

        // Clear active pack
        await query(
            `UPDATE dl_project_pack_state SET active_pack_id = NULL, updated_at = NOW()
             WHERE project_id = $1 AND tag_id = $2`,
            [projectId, tagId]
        );

        await this._audit(userId, projectId, 'pack_rolled_back', { tag_id: tagId, cards_zeroed: rolled });

        logger.info('Knowledge pack rolled back', { projectId, tagId, rolled });
        return { rolled, total: cardsResult.rows.length };
    }

    /**
     * Generate a study plan for a domain tag.
     */
    async generateStudyPlan(userId, tagId) {
        const tagResult = await query(
            'SELECT tag, display_name, description FROM dl_domain_tags WHERE tag_id = $1 AND user_id = $2',
            [tagId, userId]
        );
        if (!tagResult.rows.length) throw new Error('Tag not found');
        const tag = tagResult.rows[0];

        const prompt = `Create a comprehensive study plan for learning: "${tag.display_name || tag.tag}"
${tag.description ? 'Context: ' + tag.description : ''}

Create an optimized learning path that:
1. Starts with prerequisites
2. Builds knowledge progressively
3. Links to real, well-known resources
4. Estimates time for each topic
5. Includes practice exercises/projects

Return a JSON object:
{
  "domain": "${tag.display_name || tag.tag}",
  "estimated_total_hours": number,
  "prerequisites": ["list of things to know first"],
  "topics": [
    {
      "name": "Topic name",
      "description": "What you'll learn",
      "estimated_hours": number,
      "resources": [
        { "title": "Resource name", "url": "https://...", "type": "article|video|course|docs|practice" }
      ],
      "practice": "Suggested exercise or project"
    }
  ],
  "tips": ["Learning tips specific to this domain"]
}

URL guidelines for resources:
- Use real URLs from well-known platforms: Wikipedia, YouTube, Khan Academy, MDN, freeCodeCamp, W3Schools, GeeksforGeeks, Coursera, edX, official documentation sites
- Only link to pages you are confident exist (e.g. main topic pages, well-known course pages)
- Prefer broader/stable URLs over deep specific pages (e.g. a Wikipedia article, a YouTube channel, a Coursera course landing page)

Optimize for efficient learning — build on foundations, avoid redundancy.
Respond with ONLY the JSON object.`;

        await costGovernor.checkBudget(2000);
        const resolved = await providerResolver.getAdapter(userId, 'oggy');
        const result = await this.openaiBreaker.execute(() =>
            resolved.adapter.chatCompletion({
                model: resolved.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.4,
                max_tokens: 2000,
                timeout: 45000
            })
        );
        costGovernor.recordUsage(result.tokens_used || 2000);
        providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'studyPlan', result.tokens_used, result.latency_ms, true, null);

        let plan;
        try {
            plan = JSON.parse(this._cleanJson(result.text));
        } catch {
            throw new Error('Failed to parse study plan from LLM');
        }

        // Validate URLs and replace broken ones with search fallbacks
        await this._resolveStudyPlanUrls(plan);

        await this._audit(userId, null, 'study_plan_generated', {
            tag_id: tagId, topics: (plan.topics || []).length, hours: plan.estimated_total_hours
        });

        return plan;
    }

    /**
     * Save an accepted study plan for a project + tag.
     */
    async saveStudyPlan(userId, projectId, tagId, plan) {
        // Get tag display name for the saved record
        const tagResult = await query(
            'SELECT tag, display_name FROM dl_domain_tags WHERE tag_id = $1 AND user_id = $2',
            [tagId, userId]
        );
        const tagName = tagResult.rows[0]?.display_name || tagResult.rows[0]?.tag || tagId;

        await this._audit(userId, projectId, 'study_plan_saved', {
            tag_id: tagId, tag_name: tagName, plan
        });
        return { saved: true };
    }

    /**
     * Get all saved study plans for a project.
     */
    async getProjectStudyPlans(userId, projectId) {
        const result = await query(
            `SELECT event_id, payload, created_at FROM dl_audit_events
             WHERE user_id = $1 AND project_id = $2 AND event_type = 'study_plan_saved'
             ORDER BY created_at DESC`,
            [userId, projectId]
        );
        return result.rows.map(r => ({
            id: r.event_id,
            tag_id: r.payload?.tag_id,
            tag_name: r.payload?.tag_name || r.payload?.plan?.domain || 'Study Plan',
            plan: r.payload?.plan,
            saved_at: r.created_at
        }));
    }

    /**
     * Delete a saved study plan.
     */
    async deleteStudyPlan(userId, planEventId) {
        await query(
            `DELETE FROM dl_audit_events WHERE event_id = $1 AND user_id = $2 AND event_type = 'study_plan_saved'`,
            [planEventId, userId]
        );
        return { deleted: true };
    }

    /**
     * Get domain tags for a project (enabled ones).
     */
    async getProjectTags(userId, projectId) {
        const result = await query(
            `SELECT t.tag_id, t.tag, t.display_name, t.description, t.status,
                    ps.active_pack_id,
                    (SELECT version FROM dl_knowledge_packs WHERE pack_id = ps.active_pack_id) as active_version,
                    (SELECT card_count FROM dl_knowledge_packs WHERE pack_id = ps.active_pack_id) as active_cards
             FROM dl_project_domain_tags pt
             JOIN dl_domain_tags t ON t.tag_id = pt.tag_id
             LEFT JOIN dl_project_pack_state ps ON ps.project_id = pt.project_id AND ps.tag_id = pt.tag_id
             WHERE pt.project_id = $1 AND t.user_id = $2`,
            [projectId, userId]
        );
        return result.rows;
    }

    /**
     * Get audit events.
     */
    async getAuditEvents(userId, projectId, limit = 20) {
        let sql = `SELECT * FROM dl_audit_events WHERE user_id = $1`;
        const params = [userId];
        if (projectId) {
            sql += ` AND (project_id = $2 OR project_id IS NULL)`;
            params.push(projectId);
        }
        sql += ` ORDER BY created_at DESC LIMIT ${parseInt(limit)}`;
        const result = await query(sql, params);
        return result.rows;
    }

    async _audit(userId, projectId, eventType, payload) {
        try {
            await query(
                `INSERT INTO dl_audit_events (user_id, project_id, event_type, payload)
                 VALUES ($1, $2, $3, $4)`,
                [userId, projectId, eventType, JSON.stringify(payload)]
            );
        } catch (err) {
            logger.debug('Audit event write failed', { error: err.message });
        }
    }
}

module.exports = new DomainLearningService();
