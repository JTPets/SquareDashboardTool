/**
 * AI Autofill Service
 *
 * Business logic for AI-powered catalog content generation:
 * - Assess item readiness for content generation
 * - Generate descriptions and SEO content via Claude API
 *
 * Workflow phases:
 * 1. Description - requires image + category
 * 2. SEO Title - requires image + category + description
 * 3. SEO Description - requires image + category + description + SEO title
 */

const db = require('../utils/database');
const logger = require('../utils/logger');

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

/**
 * Get all items with their readiness status for content generation
 * @param {number} merchantId - The merchant ID for multi-tenant isolation
 * @returns {Promise<Object>} - Items grouped by readiness phase
 */
async function getItemsWithReadiness(merchantId) {
    if (!merchantId) {
        throw new Error('merchantId is required for getItemsWithReadiness');
    }

    const result = await db.query(`
        SELECT
            i.id,
            i.name,
            i.description,
            i.seo_title,
            i.seo_description,
            i.category_id,
            i.category_name,
            -- Resolve first image URL from images JSONB array
            (
                SELECT img.url
                FROM jsonb_array_elements_text(COALESCE(i.images, '[]'::jsonb))
                     WITH ORDINALITY AS t(image_id, idx)
                JOIN images img ON img.id = t.image_id
                WHERE img.url IS NOT NULL AND img.merchant_id = $1
                ORDER BY idx
                LIMIT 1
            ) as image_url,
            -- Get variations for context (sizes, flavors, etc.)
            (
                SELECT json_agg(json_build_object(
                    'id', v.id,
                    'name', v.name,
                    'sku', v.sku
                ) ORDER BY v.name)
                FROM variations v
                WHERE v.item_id = i.id
                  AND v.merchant_id = $1
                  AND COALESCE(v.is_deleted, FALSE) = FALSE
            ) as variations
        FROM items i
        WHERE i.merchant_id = $1
          AND COALESCE(i.is_deleted, FALSE) = FALSE
        ORDER BY i.name
    `, [merchantId]);

    const items = result.rows;

    // Group by readiness phase
    const grouped = {
        notReady: [],           // Missing image OR category
        needsDescription: [],   // Has image + category, missing description
        needsSeoTitle: [],      // Has description, missing SEO title
        needsSeoDescription: [],// Has SEO title, missing SEO description
        complete: []            // Has all fields
    };

    for (const item of items) {
        const hasImage = !!item.image_url;
        const hasCategory = !!item.category_name;
        const hasDescription = !!item.description && item.description.trim().length > 0;
        const hasSeoTitle = !!item.seo_title && item.seo_title.trim().length > 0;
        const hasSeoDescription = !!item.seo_description && item.seo_description.trim().length > 0;

        // Parse variations JSON
        item.variations = item.variations || [];

        if (!hasImage || !hasCategory) {
            item.missingPrereqs = [];
            if (!hasImage) item.missingPrereqs.push('image');
            if (!hasCategory) item.missingPrereqs.push('category');
            grouped.notReady.push(item);
        } else if (!hasDescription) {
            grouped.needsDescription.push(item);
        } else if (!hasSeoTitle) {
            grouped.needsSeoTitle.push(item);
        } else if (!hasSeoDescription) {
            grouped.needsSeoDescription.push(item);
        } else {
            grouped.complete.push(item);
        }
    }

    logger.info('AI Autofill: getItemsWithReadiness', {
        merchantId,
        total: items.length,
        notReady: grouped.notReady.length,
        needsDescription: grouped.needsDescription.length,
        needsSeoTitle: grouped.needsSeoTitle.length,
        needsSeoDescription: grouped.needsSeoDescription.length,
        complete: grouped.complete.length
    });

    return grouped;
}

/**
 * Get full item data for generation
 * @param {number} merchantId - The merchant ID
 * @param {string[]} itemIds - Array of item IDs to fetch
 * @returns {Promise<Object[]>} - Array of items with full context
 */
async function getItemsForGeneration(merchantId, itemIds) {
    if (!merchantId) {
        throw new Error('merchantId is required');
    }
    if (!itemIds || itemIds.length === 0) {
        return [];
    }

    const result = await db.query(`
        SELECT
            i.id,
            i.name,
            i.description,
            i.seo_title,
            i.seo_description,
            i.category_name,
            (
                SELECT img.url
                FROM jsonb_array_elements_text(COALESCE(i.images, '[]'::jsonb))
                     WITH ORDINALITY AS t(image_id, idx)
                JOIN images img ON img.id = t.image_id
                WHERE img.url IS NOT NULL AND img.merchant_id = $1
                ORDER BY idx
                LIMIT 1
            ) as image_url,
            (
                SELECT json_agg(json_build_object(
                    'id', v.id,
                    'name', v.name,
                    'sku', v.sku
                ) ORDER BY v.name)
                FROM variations v
                WHERE v.item_id = i.id
                  AND v.merchant_id = $1
                  AND COALESCE(v.is_deleted, FALSE) = FALSE
            ) as variations
        FROM items i
        WHERE i.merchant_id = $1
          AND i.id = ANY($2)
          AND COALESCE(i.is_deleted, FALSE) = FALSE
    `, [merchantId, itemIds]);

    return result.rows.map(item => ({
        ...item,
        variations: item.variations || []
    }));
}

/**
 * Build the prompt for Claude based on field type
 * @param {string} fieldType - description, seo_title, or seo_description
 * @param {Object} options - { context, keywords, tone }
 * @returns {string} - System prompt
 */
function buildSystemPrompt(fieldType, options = {}) {
    const { context = '', keywords = [], tone = 'professional', storeName = '' } = options;

    const toneDescriptions = {
        professional: 'professional and informative',
        friendly: 'friendly and approachable',
        technical: 'detailed and technical'
    };

    const toneDesc = toneDescriptions[tone] || toneDescriptions.professional;
    const keywordList = keywords.length > 0 ? keywords.join(', ') : '';
    const businessContext = context || '';
    const storeLabel = storeName || 'the store';

    const prompts = {
        description: `You are a product copywriter for an e-commerce store. Write compelling product descriptions that highlight key features and benefits.

Tone: ${toneDesc}

For each product, you will see:
- Product name
- Product variations (sizes, flavors, etc.)
- Product image (showing packaging, brand, ingredients if visible)
- Category

Write a description of 2-4 sentences (50-150 words) that:
- Describes what the product is and its key benefits
- Mentions relevant details visible in the image (brand, ingredients, etc.)
- Is suitable for an e-commerce product page${businessContext ? `\n- Business context to inform tone and positioning: ${businessContext}` : ''}${keywordList ? `\n- When natural, incorporate these target keywords: ${keywordList}` : ''}

Respond with a JSON array: [{"itemId": "...", "generated": "..."}]`,

        seo_title: `You are an SEO specialist for an e-commerce store called "${storeLabel}". Write SEO page titles optimized for how customers actually search.

Tone: ${toneDesc}

For each product, you will see:
- Product name (the brand is usually the first word, e.g. "ACANA", "Orijen", "Fromm")
- Product variations (sizes, flavors, etc.)
- Product image
- Category (use this to derive the search term customers would type, e.g. "Cat Food - Wet" → "Wet Cat Food", "Dog Treats" → "Dog Treats", "Cat Litter" → "Cat Litter")
- Product description

Write an SEO title using this format priority:
  [Brand] [Search Term] [Key Differentiator] [Size] | ${storeLabel}

Rules:
- Is 50-60 characters (CRITICAL: stay within this limit)
- ALWAYS start with the brand name extracted from the item name. Never drop the brand
- MUST include a customer search term derived from the category (e.g. "Dog Food", "Wet Cat Food", "Dog Treats", "Cat Litter"). Customers search "kitten wet food" not "chunks broth kitten"
- Include the key differentiator: primary protein or flavor (e.g. "Chicken & Salmon", "Red Meat"). Drop filler words from the product name like "Chunks", "Broth", "Recipe", "Premium", "Classics", "Pate", "Formula" to make room
- Include size/weight if characters allow
- "| ${storeLabel}" goes at the end ONLY if there are characters to spare; drop store name before dropping brand, search term, or differentiator
- Never use generic phrases like "Natural Pet Food" or location names${businessContext ? `\n- Business context to inform tone and positioning: ${businessContext}` : ''}${keywordList ? `\n- When space allows, incorporate these target keywords: ${keywordList}` : ''}

Examples:
- Item: "ACANA Chunks in Broth Kitten Wet Food Chicken + Salmon Recipe 155g" (Category: Cat Food - Wet)
  Good: "ACANA Kitten Wet Food Chicken & Salmon 155g"
  Bad: "ACANA Chunks Broth Kitten Chicken + Salmon"
- Item: "Orijen Pate Wet Dog Chicken Recipe with Liver 363g" (Category: Dog Food - Wet)
  Good: "ORIJEN Chicken & Liver Wet Dog Food 363g"
  Bad: "Orijen Pate Wet Dog Chicken Recipe Liver"
- Item: "Fromm Four-Star Chicken Au Frommage Recipe Dog 11.8kg" (Category: Dog Food - Dry)
  Good: "Fromm Chicken Au Frommage Dog Food 11.8kg"
  Bad: "Fromm Four-Star Chicken Au Frommage Recipe"

Respond with a JSON array: [{"itemId": "...", "generated": "..."}]`,

        seo_description: `You are an SEO specialist for an e-commerce store. Write meta descriptions that drive clicks from search results.

Tone: ${toneDesc}

For each product, you will see:
- Product name
- Product variations (sizes, flavors, etc.)
- Product image
- Category (use this to include search terms customers type, e.g. "dry dog food", "wet cat food")
- Product description
- SEO title (your description should complement this, not duplicate it)

Rules:
- Is 150-160 characters (CRITICAL: stay within this limit)
- NEVER fabricate percentages, nutritional claims, or specific numbers unless they appear verbatim in the provided product description. If the source says "21% fresh chicken", you may use it. If it doesn't state a percentage, do not invent one
- NO generic CTAs: "Order now", "Shop today", "Buy here", "Shop now", "Get yours" are banned
- Include: brand name, primary protein/ingredient, animal type + life stage if applicable
- Focus on what differentiates THIS product from competitors (unique ingredients, recipe style, sourcing)
- Use the category to include search terms customers type (e.g. "dry dog food", "wet cat food")
- Tone should match the merchant's tone setting
- Complement the SEO title without repeating it${businessContext ? `\n- Business context to inform tone and positioning: ${businessContext}` : ''}${keywordList ? `\n- When space allows, incorporate these target keywords: ${keywordList}` : ''}

Examples:
- Item: "ACANA Classics Wild Coast Recipe Dog 9.7kg" (Category: Dog Food - Dry, Description mentions: fresh salmon 21%, herring meal)
  Good: "ACANA Wild Coast dry dog food with fresh salmon & herring. Canadian-made with regional ingredients for whole-body health. 9.7kg bag."
  Bad: "Premium dog nutrition with 50% salmon & herring, supporting immune function, digestion & healthy coat. Order now!"
- Item: "Orijen Pate Wet Dog Chicken Recipe with Liver 363g" (Category: Dog Food - Wet, Description lists: chicken, chicken liver, chicken bone broth)
  Good: "ORIJEN Chicken & Liver wet dog food pâté with bone broth. WholePrey recipe with organs for complete nutrition. 363g can."
  Bad: "Delicious chicken recipe your dog will love! Made with premium ingredients for optimal health. Shop today!"

Respond with a JSON array: [{"itemId": "...", "generated": "..."}]`
    };

    return prompts[fieldType] || prompts.description;
}

/**
 * Build message content for Claude with images
 * @param {Object[]} items - Items with context
 * @param {string} fieldType - The field being generated
 * @param {string} systemPrompt - The system prompt
 * @returns {Object[]} - Content array for Claude message
 */
function buildMessageContent(items, fieldType, systemPrompt) {
    const content = [
        { type: 'text', text: systemPrompt }
    ];

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const variationInfo = item.variations && item.variations.length > 0
            ? `Variations: ${item.variations.map(v => v.name).join(', ')}`
            : '';

        // Add image if available
        if (item.image_url) {
            content.push({
                type: 'image',
                source: { type: 'url', url: item.image_url }
            });
        }

        // Build item context based on field type
        let itemContext = `Item ${i + 1} (ID: ${item.id}):
Name: ${item.name}
Category: ${item.category_name || 'N/A'}
${variationInfo}`;

        if (fieldType === 'seo_title' || fieldType === 'seo_description') {
            itemContext += `\nDescription: ${item.description || 'N/A'}`;
        }

        if (fieldType === 'seo_description') {
            itemContext += `\nSEO Title: ${item.seo_title || 'N/A'}`;
        }

        content.push({ type: 'text', text: itemContext });
    }

    content.push({
        type: 'text',
        text: `\nGenerate content for ${items.length} item(s). Respond ONLY with a valid JSON array.`
    });

    return content;
}

/**
 * Generate content using Claude API
 * @param {Object[]} items - Items to generate content for
 * @param {string} fieldType - description, seo_title, or seo_description
 * @param {Object} options - { context, keywords, tone }
 * @param {string} apiKey - Claude API key
 * @returns {Promise<Object[]>} - Generated content results
 */
async function generateContent(items, fieldType, options, apiKey) {
    if (!items || items.length === 0) {
        return [];
    }
    if (!apiKey) {
        throw new Error('API key is required');
    }

    const systemPrompt = buildSystemPrompt(fieldType, options);
    const messageContent = buildMessageContent(items, fieldType, systemPrompt);

    logger.info('AI Autofill: calling Claude API', {
        fieldType,
        itemCount: items.length,
        hasImages: items.filter(i => i.image_url).length
    });

    const response = await fetch(CLAUDE_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: CLAUDE_MODEL,
            max_tokens: 4096,
            messages: [{
                role: 'user',
                content: messageContent
            }]
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        logger.error('AI Autofill: Claude API error', {
            status: response.status,
            error: errorText
        });

        if (response.status === 401) {
            throw new Error('Invalid Claude API key');
        }
        if (response.status === 429) {
            throw new Error('Claude API rate limit exceeded. Please try again later.');
        }
        throw new Error(`Claude API error: ${response.status}`);
    }

    const data = await response.json();

    // Extract text content from response
    const textContent = data.content?.find(c => c.type === 'text')?.text;
    if (!textContent) {
        throw new Error('No text content in Claude response');
    }

    // Parse JSON from response (may be wrapped in markdown code block)
    let generated;
    try {
        // Try direct parse first
        generated = JSON.parse(textContent);
    } catch {
        // Try extracting from markdown code block
        const jsonMatch = textContent.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            generated = JSON.parse(jsonMatch[1].trim());
        } else {
            throw new Error('Could not parse Claude response as JSON');
        }
    }

    if (!Array.isArray(generated)) {
        throw new Error('Claude response is not an array');
    }

    // Map results back to items with original values
    const results = items.map(item => {
        const match = generated.find(g => g.itemId === item.id);
        return {
            itemId: item.id,
            name: item.name,
            original: item[fieldType === 'seo_title' ? 'seo_title' :
                        fieldType === 'seo_description' ? 'seo_description' : 'description'] || '',
            generated: match?.generated || null
        };
    });

    logger.info('AI Autofill: generation complete', {
        fieldType,
        successCount: results.filter(r => r.generated).length,
        totalCount: results.length
    });

    return results;
}

/**
 * Validate items are ready for the specified field type
 * @param {Object[]} items - Items to validate
 * @param {string} fieldType - The field being generated
 * @returns {Object} - { valid: boolean, errors: string[] }
 */
function validateReadiness(items, fieldType) {
    const errors = [];

    for (const item of items) {
        const hasImage = !!item.image_url;
        const hasCategory = !!item.category_name;
        const hasDescription = !!item.description && item.description.trim().length > 0;
        const hasSeoTitle = !!item.seo_title && item.seo_title.trim().length > 0;

        if (!hasImage) {
            errors.push(`"${item.name}" is missing an image`);
        }
        if (!hasCategory) {
            errors.push(`"${item.name}" is missing a category`);
        }

        if (fieldType === 'seo_title' && !hasDescription) {
            errors.push(`"${item.name}" needs a description before generating SEO title`);
        }

        if (fieldType === 'seo_description') {
            if (!hasDescription) {
                errors.push(`"${item.name}" needs a description before generating SEO description`);
            }
            if (!hasSeoTitle) {
                errors.push(`"${item.name}" needs an SEO title before generating SEO description`);
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

module.exports = {
    getItemsWithReadiness,
    getItemsForGeneration,
    generateContent,
    validateReadiness
};
