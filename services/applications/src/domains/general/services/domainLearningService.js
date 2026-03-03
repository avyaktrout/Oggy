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
     * Validate a YouTube video URL using the oEmbed API.
     * YouTube returns 200 for unavailable videos on the main page,
     * but oEmbed returns 404 for non-existent/unavailable videos.
     */
    async _validateYouTubeUrl(url) {
        try {
            await axios.get('https://www.youtube.com/oembed', {
                params: { url, format: 'json' },
                timeout: 5000,
                validateStatus: (s) => s < 400
            });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Check if a URL points to a generic landing/index page rather than specific content.
     */
    _isGenericLandingPage(url) {
        try {
            const parsed = new URL(url);
            const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
            const segments = path.split('/').filter(Boolean);
            if (segments.length === 0) return true;
            const genericSegments = ['learn', 'learning', 'learning-center', 'resources', 'education',
                'help', 'support', 'blog', 'articles', 'guides', 'home', 'overview', 'topics'];
            if (segments.length === 1 && genericSegments.includes(segments[0])) return true;
            return false;
        } catch { return false; }
    }

    /**
     * Detect soft 404 pages — sites that return HTTP 200 but show "page not found" content.
     */
    _isSoft404(html) {
        const titleMatch = html.match(/<title[^>]*>([^<]{0,300})<\/title>/i);
        if (titleMatch) {
            const title = titleMatch[1].toLowerCase();
            if (title.includes('not found') || title.includes('404') ||
                title.includes("doesn't exist") || title.includes('does not exist') ||
                title.includes('page error') || title.includes('error page')) {
                return true;
            }
        }
        const errorPatterns = [
            "page you were trying to load doesn't exist",
            "page you were trying to load does not exist",
            "sorry, the page you were looking for",
            "the page you requested could not be found",
            "this page doesn't exist", "this page does not exist",
            "this page isn't available",
            "the page you are looking for doesn't exist",
            "the page you are looking for does not exist",
            "we couldn't find the page", "we could not find the page"
        ];
        for (const pattern of errorPatterns) {
            if (html.includes(pattern)) return true;
        }
        return false;
    }

    /**
     * Detect bot protection/challenge pages that block server-side validation.
     * Sites like Khan Academy serve these to all server requests — valid and invalid
     * pages look identical, so we can't trust any URL from these sites.
     */
    _isBotChallenge(html, pageLength) {
        // Real content pages are typically > 10KB; challenge pages are small shells
        if (pageLength > 15000) return false;
        const titleMatch = html.match(/<title[^>]*>([^<]{0,300})<\/title>/i);
        const title = titleMatch ? titleMatch[1].toLowerCase() : '';
        const challengeIndicators = ['client challenge', 'checking your browser',
            'just a moment', 'attention required', 'enable javascript and cookies',
            'verify you are human', 'please wait', 'browser check'];
        for (const ind of challengeIndicators) {
            if (title.includes(ind) || html.includes(ind)) return true;
        }
        return false;
    }

    /**
     * Detect JS or meta-refresh redirects to homepage/generic pages in HTML.
     */
    _hasJsRedirectToGeneric(html) {
        const metaMatch = html.match(/<meta[^>]*http-equiv\s*=\s*["']refresh["'][^>]*content\s*=\s*["'][^"']*url\s*=\s*([^"'\s>]+)/i);
        if (metaMatch && this._isGenericLandingPage(metaMatch[1])) return true;
        const jsRedirectMatch = html.match(/(?:window|document)\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
        if (jsRedirectMatch && this._isGenericLandingPage(jsRedirectMatch[1])) return true;
        return false;
    }

    /**
     * Validate a URL and return its final resolved URL (after redirects).
     * Returns { valid: boolean, finalUrl: string }
     * Checks: HTTP status, redirects, bot challenges, soft 404s, JS redirects.
     */
    /**
     * Search YouTube for a query and return the first real video URL + title.
     * Parses ytInitialData from the search results page (no API key needed).
     */
    async _searchYouTubeVideo(searchQuery) {
        try {
            const encoded = encodeURIComponent(searchQuery);
            const resp = await axios.get(`https://www.youtube.com/results?search_query=${encoded}`, {
                timeout: 8000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept-Language': 'en-US,en;q=0.9'
                },
                responseType: 'text'
            });
            const html = resp.data || '';
            // Extract video IDs from ytInitialData JSON embedded in the page
            const videoIds = [];
            const regex = /"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/g;
            let match;
            while ((match = regex.exec(html)) !== null) {
                if (!videoIds.includes(match[1])) videoIds.push(match[1]);
                if (videoIds.length >= 3) break;
            }
            if (videoIds.length === 0) return null;

            // Extract title for the first video
            const titleRegex = new RegExp(`"videoId"\\s*:\\s*"${videoIds[0]}"[\\s\\S]*?"title"\\s*:\\s*\\{[\\s\\S]*?"text"\\s*:\\s*"([^"]+)"`);
            const titleMatch = html.match(titleRegex);
            const title = titleMatch ? titleMatch[1] : searchQuery;

            return {
                url: `https://www.youtube.com/watch?v=${videoIds[0]}`,
                title,
                type: 'video'
            };
        } catch (err) {
            logger.debug('YouTube search failed', { query: searchQuery, error: err.message });
            return null;
        }
    }

    async _validateUrl(url) {
        // YouTube search URLs are always valid (they show search results for the query)
        if (url.includes('youtube.com/results?search_query=')) {
            return { valid: true, finalUrl: url };
        }
        if (url.includes('youtube.com/watch?v=') || url.includes('youtu.be/')) {
            const valid = await this._validateYouTubeUrl(url);
            return { valid, finalUrl: url };
        }
        // Reject YouTube channel/playlist pages — AI frequently hallucates channel names
        if (url.includes('youtube.com/@') || url.includes('youtube.com/channel/') || url.includes('youtube.com/playlist')) {
            return { valid: false, finalUrl: url };
        }
        if (this._isGenericLandingPage(url)) return { valid: false, finalUrl: url };

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html'
        };
        try {
            const resp = await axios.get(url, {
                timeout: 8000, maxRedirects: 5,
                validateStatus: () => true,
                headers,
                responseType: 'text'
            });
            const finalUrl = resp.request?.res?.responseUrl || url;

            if (resp.status >= 400) return { valid: false, finalUrl };
            if (finalUrl !== url && this._isGenericLandingPage(finalUrl)) return { valid: false, finalUrl };

            const body = resp.data || '';
            const html = body.substring(0, 15000).toLowerCase();

            if (this._isBotChallenge(html, body.length)) return { valid: false, finalUrl };
            if (this._isSoft404(html)) return { valid: false, finalUrl };
            if (this._hasJsRedirectToGeneric(html)) return { valid: false, finalUrl };

            // Detect Wikipedia disambiguation pages — they return 200 but aren't useful
            if (url.includes('wikipedia.org/wiki/') && (
                html.includes('class="disambiguation"') ||
                html.includes('class="dmbox') ||
                html.includes('may refer to:') ||
                html.includes('can refer to:') ||
                html.includes('disambiguation page')
            )) {
                return { valid: false, finalUrl };
            }

            return { valid: true, finalUrl };
        } catch {
            return { valid: false, finalUrl: url };
        }
    }

    /**
     * Post-process study plan. Enforces two invariants:
     * 1. Every URL is unique (deduplicated by final resolved URL)
     * 2. Every topic has at least one resource (Wikipedia fallback, or topic removed)
     */
    async _resolveStudyPlanUrls(plan) {
        const seenFinalUrls = new Set();

        for (const topic of (plan.topics || [])) {
            if (!topic.resources || topic.resources.length === 0) {
                topic.resources = [];
            } else {
                // Validate all URLs in parallel
                const results = await Promise.allSettled(
                    topic.resources.map(async (r) => {
                        if (!r.url) return { resource: r, valid: false, finalUrl: null };
                        const { valid, finalUrl } = await this._validateUrl(r.url);
                        return { resource: r, valid, finalUrl };
                    })
                );

                // Keep only valid + unique resources (drop invalid ones)
                topic.resources = [];
                for (const result of results) {
                    if (result.status !== 'fulfilled' || !result.value.valid) continue;
                    const finalUrl = result.value.finalUrl || result.value.resource.url;
                    if (seenFinalUrls.has(finalUrl)) continue;
                    seenFinalUrls.add(finalUrl);
                    topic.resources.push(result.value.resource);
                }
            }

            // Wikipedia fallback for topics with no surviving resources
            if (topic.resources.length === 0 && topic.name) {
                const wikiTitle = topic.name.replace(/\s+/g, '_');
                const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(wikiTitle)}`;
                if (!seenFinalUrls.has(wikiUrl)) {
                    const { valid } = await this._validateUrl(wikiUrl);
                    if (valid) {
                        seenFinalUrls.add(wikiUrl);
                        topic.resources.push({ title: `${topic.name} — Wikipedia`, url: wikiUrl, type: 'article' });
                    }
                }
            }

            // YouTube video fallback — if topic has no video resource, search YouTube for one
            const hasVideo = topic.resources.some(r => r.type === 'video');
            if (!hasVideo && topic.name) {
                const domain = plan.domain || '';
                const searchQuery = `${domain} ${topic.name} explained`.trim();
                const video = await this._searchYouTubeVideo(searchQuery);
                if (video && !seenFinalUrls.has(video.url)) {
                    seenFinalUrls.add(video.url);
                    topic.resources.push(video);
                }
            }
        }

        // Remove topics that still have no resources — plan must not contain empty sections
        plan.topics = (plan.topics || []).filter(t => t.resources && t.resources.length > 0);

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
    async buildKnowledgePack(userId, tagId, intentContext = null) {
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

        let intentFocus = '';
        if (intentContext && intentContext.length > 0) {
            const intentList = intentContext.map(i => `- ${i.display_name}: ${i.description || i.intent_name}`).join('\n');
            intentFocus = `\n\nFocus the cards with these learning intents in mind:\n${intentList}\nTailor the content to address these specific focus areas within the domain.\n`;
        }

        const prompt = `Generate a comprehensive knowledge pack for the domain: "${tag.display_name || tag.tag}"
Description: ${tag.description || 'General knowledge about ' + tag.tag}
${intentFocus}
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
    async generateStudyPlan(userId, tagId, options = {}) {
        const { freeOnly = false } = options;
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
3. Links to real, publicly accessible resources
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

Provide 4-6 resources per topic. Use DIVERSE sources — do NOT rely heavily on any one site. Wikipedia should be at most ~30% of total resources.

CRITICAL URL RULES — broken links are automatically removed, so only include links you are CERTAIN exist:
- Recommended platforms (mix these for variety):
  * Investopedia: https://www.investopedia.com/terms/... or https://www.investopedia.com/articles/... (great for finance/economics)
  * Wikipedia: https://en.wikipedia.org/wiki/Article_Name (use underscores, match real titles exactly)
  * GeeksforGeeks: https://www.geeksforgeeks.org/topic-name/ (great for CS/programming)
  * Coursera: https://www.coursera.org/learn/course-slug (use real slugs like "machine-learning", "financial-markets")
  * MIT OCW: https://ocw.mit.edu/courses/...
  * MDN: https://developer.mozilla.org/en-US/docs/Web/...
  * Python docs: https://docs.python.org/3/library/... or https://docs.python.org/3/tutorial/...
  * freeCodeCamp: https://www.freecodecamp.org/learn/... or https://www.freecodecamp.org/news/...
  * Official documentation sites (e.g. https://react.dev, https://nodejs.org/docs/latest/api/)
  * HowStuffWorks: https://www.howstuffworks.com/...
  * Britannica: https://www.britannica.com/topic/...
  * YouTube videos: https://www.youtube.com/watch?v=VIDEO_ID — use real video IDs from well-known educational creators (3Blue1Brown, CrashCourse, Khan Academy, TED-Ed, Veritasium, Wendover Productions, etc.). Only include IDs you are confident are real. The system will automatically find videos for topics that don't have one, so focus on quality article resources.
- DO NOT use: Khan Academy article links (blocked by bot protection), Fidelity links, YouTube CHANNEL pages (youtube.com/@anything), YouTube playlist links, YouTube search URLs
- Wikipedia: Use SPECIFIC article titles that exactly match the real page. E.g. "Travel_planning" not "Travel" or "Accommodation_(lodging)" not "Accommodation". Check that the title is specific enough to avoid disambiguation pages.
- DO NOT guess or fabricate URLs. If you are not sure a specific page exists, do NOT include it. Only include URLs for pages you are highly confident exist.

${freeOnly ? `
IMPORTANT — FREE RESOURCES ONLY:
Only include resources that are 100% free to access. DO NOT include:
- Coursera courses that require payment (audit-only free courses are OK)
- Udemy paid courses
- Any paywall-gated content or paid textbooks
ONLY include free resources: Wikipedia, freeCodeCamp, MIT OCW, YouTube, MDN, GeeksforGeeks, official docs, Khan Academy, arXiv, GitHub repos, free blog posts.
` : ''}Optimize for efficient learning — build on foundations, avoid redundancy.
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

        // Validate URLs and replace broken ones with real search results
        await this._resolveStudyPlanUrls(plan);

        await this._audit(userId, null, 'study_plan_generated', {
            tag_id: tagId, topics: (plan.topics || []).length, hours: plan.estimated_total_hours
        });

        return plan;
    }

    /**
     * Refine an existing study plan based on user feedback.
     */
    async refineStudyPlan(userId, tagId, currentPlan, feedback, options = {}) {
        const { freeOnly = false } = options;
        const tagResult = await query(
            'SELECT tag, display_name, description FROM dl_domain_tags WHERE tag_id = $1 AND user_id = $2',
            [tagId, userId]
        );
        if (!tagResult.rows.length) throw new Error('Tag not found');
        const tag = tagResult.rows[0];

        // Summarize current plan compactly for context
        const planSummary = (currentPlan.topics || []).map(t =>
            `- ${t.name} (${t.estimated_hours || '?'}h): ${t.description || ''}`
        ).join('\n');

        const prompt = `You previously created a study plan for "${tag.display_name || tag.tag}".

Current plan topics:
${planSummary}

The user wants to refine this plan. Their feedback:
"${feedback}"

Revise the study plan based on the user's feedback. For example:
- If they say they already know a topic, reduce or remove it and reallocate time
- If they want more depth on something, expand that area
- If they want to add a new focus area, include it

Return the COMPLETE revised study plan as a JSON object (same format as before):
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

Provide 4-6 resources per topic so there is a good variety.

Use DIVERSE sources — do NOT rely heavily on any one site. Wikipedia should be at most ~30% of total resources.

CRITICAL URL RULES — broken links are automatically removed:
- Use diverse platforms: Investopedia, Wikipedia, GeeksforGeeks, Coursera, MIT OCW, MDN, freeCodeCamp, HowStuffWorks, Britannica, official docs
- YouTube: ONLY specific video links (youtube.com/watch?v=...) from well-known creators. NO channel pages (@...) or playlists.
- Wikipedia: Use SPECIFIC article titles (e.g. "Accommodation_(lodging)" not "Accommodation") to avoid disambiguation pages.
- DO NOT use: Khan Academy article links, Fidelity links
- DO NOT guess or fabricate URLs. If not sure a page exists, do NOT include it.
${freeOnly ? `
IMPORTANT — FREE RESOURCES ONLY:
Only include resources that are 100% free to access. No paid courses, subscriptions, or paywalled content.
ONLY use: Wikipedia, freeCodeCamp, MIT OCW, YouTube, MDN, GeeksforGeeks, official docs, Khan Academy, arXiv, GitHub repos, free blog posts.
` : ''}
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
        providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'studyPlanRefine', result.tokens_used, result.latency_ms, true, null);

        let plan;
        try {
            plan = JSON.parse(this._cleanJson(result.text));
        } catch {
            throw new Error('Failed to parse refined study plan from LLM');
        }

        // Validate URLs and replace broken ones with real search results
        await this._resolveStudyPlanUrls(plan);

        await this._audit(userId, null, 'study_plan_refined', {
            tag_id: tagId, feedback, topics: (plan.topics || []).length, hours: plan.estimated_total_hours
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
