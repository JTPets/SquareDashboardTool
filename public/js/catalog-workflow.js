/**
 * Catalog Workflow - AI Content Autofill JavaScript
 * Handles item status loading, content generation via Claude API, and applying to Square
 */

// State
let statusData = null;
let selectedItems = {
    description: new Set(),
    seo_title: new Set(),
    seo_description: new Set()
};
let generatedResults = [];
let currentFieldType = null;

// LocalStorage keys (API key is now stored server-side, not in localStorage)
const STORAGE_CONTEXT = 'ai_autofill_context';
const STORAGE_KEYWORDS = 'ai_autofill_keywords';
const STORAGE_TONE = 'ai_autofill_tone';

// Initialize
document.addEventListener('DOMContentLoaded', function() {
    loadSavedSettings();
    loadStatus();
    checkApiKeyStatus();
});

// ==================== Settings Management ====================

function loadSavedSettings() {
    // API key is now stored server-side (not in localStorage)
    // Check status via API instead

    // Load context
    const savedContext = localStorage.getItem(STORAGE_CONTEXT);
    if (savedContext) {
        document.getElementById('business-context').value = savedContext;
    }

    // Load keywords
    const savedKeywords = localStorage.getItem(STORAGE_KEYWORDS);
    if (savedKeywords) {
        document.getElementById('target-keywords').value = savedKeywords;
    }

    // Load tone
    const savedTone = localStorage.getItem(STORAGE_TONE);
    if (savedTone) {
        document.getElementById('tone').value = savedTone;
    }
}

/**
 * Check if API key is stored server-side
 */
async function checkApiKeyStatus() {
    try {
        const response = await fetch('/api/ai-autofill/api-key/status', { credentials: 'include' });
        const result = await response.json();
        if (result.success && result.data.hasKey) {
            updateApiStatus(true);
        } else {
            updateApiStatus(false);
        }
    } catch (error) {
        console.error('Failed to check API key status:', error);
        updateApiStatus(false);
    }
}

/**
 * Save API key to secure server-side storage
 */
async function saveApiKey() {
    const apiKey = document.getElementById('api-key').value.trim();
    if (!apiKey) {
        showAlert('Please enter an API key.', 'warning');
        return;
    }

    if (!apiKey.startsWith('sk-ant-')) {
        showAlert('Invalid API key format. Claude API keys start with sk-ant-', 'warning');
        return;
    }

    try {
        const response = await fetch('/api/ai-autofill/api-key', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey })
        });

        const result = await response.json();

        if (!response.ok || !result.success) {
            throw new Error(result.error || 'Failed to save API key');
        }

        // Clear the input field (key is now stored server-side, not shown again)
        document.getElementById('api-key').value = '';
        updateApiStatus(true);
        showAlert('API key saved securely on server.', 'success');

    } catch (error) {
        console.error('Failed to save API key:', error);
        showAlert('Failed to save API key: ' + error.message, 'error');
    }
}

/**
 * Delete API key from server-side storage
 */
async function clearApiKey() {
    try {
        const response = await fetch('/api/ai-autofill/api-key', {
            method: 'DELETE',
            credentials: 'include'
        });

        const result = await response.json();

        if (!response.ok || !result.success) {
            throw new Error(result.error || 'Failed to delete API key');
        }

        document.getElementById('api-key').value = '';
        updateApiStatus(false);
        showAlert('API key deleted from server.', 'info');

    } catch (error) {
        console.error('Failed to delete API key:', error);
        showAlert('Failed to delete API key: ' + error.message, 'error');
    }
}

function toggleApiKeyVisibility(element) {
    const input = document.getElementById('api-key');
    if (input.type === 'password') {
        input.type = 'text';
        element.textContent = 'Hide';
    } else {
        input.type = 'password';
        element.textContent = 'Show';
    }
}

function updateApiStatus(connected) {
    const statusEl = document.getElementById('api-status');
    if (connected) {
        statusEl.className = 'api-status connected';
        statusEl.textContent = 'Key Saved (Server)';
    } else {
        statusEl.className = 'api-status not-connected';
        statusEl.textContent = 'Not Connected';
    }
}

function getGenerationOptions() {
    const context = document.getElementById('business-context').value.trim();
    const keywordsStr = document.getElementById('target-keywords').value.trim();
    const tone = document.getElementById('tone').value;

    // Save settings
    localStorage.setItem(STORAGE_CONTEXT, context);
    localStorage.setItem(STORAGE_KEYWORDS, keywordsStr);
    localStorage.setItem(STORAGE_TONE, tone);

    const keywords = keywordsStr ? keywordsStr.split(',').map(k => k.trim()).filter(k => k) : [];

    return { context, keywords, tone };
}

// ==================== Data Loading ====================

async function loadStatus() {
    try {
        const response = await fetch('/api/ai-autofill/status', { credentials: 'include' });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const result = await response.json();

        if (!result.success) {
            throw new Error(result.error || 'Failed to load status');
        }

        statusData = result.data;
        updateSummaryCounts();
        renderAllTabs();
    } catch (error) {
        console.error('Failed to load status:', error);
        showAlert('Failed to load item status: ' + error.message, 'error');
    }
}

function updateSummaryCounts() {
    if (!statusData) return;

    const counts = {
        'not-ready': statusData.notReady?.length || 0,
        'needs-description': statusData.needsDescription?.length || 0,
        'needs-seo-title': statusData.needsSeoTitle?.length || 0,
        'needs-seo-desc': statusData.needsSeoDescription?.length || 0,
        'complete': statusData.complete?.length || 0
    };

    for (const [key, count] of Object.entries(counts)) {
        const countEl = document.getElementById(`count-${key}`);
        const badgeEl = document.getElementById(`badge-${key}`);
        if (countEl) countEl.textContent = count;
        if (badgeEl) badgeEl.textContent = count;
    }
}

// ==================== Tab Rendering ====================

function renderAllTabs() {
    renderNotReadyTab();
    renderNeedsDescriptionTab();
    renderNeedsSeoTitleTab();
    renderNeedsSeoDescTab();
    renderCompleteTab();
}

function renderNotReadyTab() {
    const tbody = document.getElementById('not-ready-body');
    const items = statusData?.notReady || [];

    if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state"><h3>All items have prerequisites!</h3><p>Move to the next tab to generate content.</p></td></tr>';
        return;
    }

    tbody.innerHTML = items.map(item => `
        <tr>
            <td>${item.image_url
                ? `<img src="${escapeHtml(item.image_url)}" class="thumbnail" alt="">`
                : '<div class="thumbnail-placeholder">?</div>'}</td>
            <td>
                <div class="item-name">${escapeHtml(item.name)}</div>
                ${item.variations?.length > 1 ? `<div class="item-variations">${item.variations.length} variations</div>` : ''}
            </td>
            <td>${item.category_name ? escapeHtml(item.category_name) : '<span class="missing-badge category">No Category</span>'}</td>
            <td>
                ${item.missingPrereqs?.includes('image') ? '<span class="missing-badge image">Image</span> ' : ''}
                ${item.missingPrereqs?.includes('category') ? '<span class="missing-badge category">Category</span>' : ''}
            </td>
            <td>
                <a href="https://squareup.com/dashboard/items/library" target="_blank" class="btn btn-secondary" style="font-size: 12px; padding: 4px 8px;">
                    Edit in Square
                </a>
            </td>
        </tr>
    `).join('');
}

function renderNeedsDescriptionTab() {
    const tbody = document.getElementById('needs-description-body');
    const items = statusData?.needsDescription || [];

    if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state"><h3>All items have descriptions!</h3><p>Move to the next tab to generate SEO titles.</p></td></tr>';
        return;
    }

    tbody.innerHTML = items.map(item => `
        <tr>
            <td><input type="checkbox" data-item-id="${escapeHtml(item.id)}" data-change="toggleItemDescription"></td>
            <td>${item.image_url
                ? `<img src="${escapeHtml(item.image_url)}" class="thumbnail" alt="">`
                : '<div class="thumbnail-placeholder">?</div>'}</td>
            <td>
                <div class="item-name">${escapeHtml(item.name)}</div>
            </td>
            <td>${escapeHtml(item.category_name || 'N/A')}</td>
            <td class="text-preview">${item.variations?.map(v => v.name).join(', ') || '-'}</td>
        </tr>
    `).join('');

    updateSelectionCount('description');
}

function renderNeedsSeoTitleTab() {
    const tbody = document.getElementById('needs-seo-title-body');
    const items = statusData?.needsSeoTitle || [];

    if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state"><h3>All items have SEO titles!</h3><p>Move to the next tab to generate SEO descriptions.</p></td></tr>';
        return;
    }

    tbody.innerHTML = items.map(item => `
        <tr>
            <td><input type="checkbox" data-item-id="${escapeHtml(item.id)}" data-change="toggleItemSeoTitle"></td>
            <td>${item.image_url
                ? `<img src="${escapeHtml(item.image_url)}" class="thumbnail" alt="">`
                : '<div class="thumbnail-placeholder">?</div>'}</td>
            <td>
                <div class="item-name">${escapeHtml(item.name)}</div>
            </td>
            <td>${escapeHtml(item.category_name || 'N/A')}</td>
            <td class="text-preview">${escapeHtml(item.description?.substring(0, 100) || 'N/A')}${item.description?.length > 100 ? '...' : ''}</td>
        </tr>
    `).join('');

    updateSelectionCount('seo_title');
}

function renderNeedsSeoDescTab() {
    const tbody = document.getElementById('needs-seo-desc-body');
    const items = statusData?.needsSeoDescription || [];

    if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state"><h3>All items have SEO descriptions!</h3><p>All content is complete. Check the Complete tab.</p></td></tr>';
        return;
    }

    tbody.innerHTML = items.map(item => `
        <tr>
            <td><input type="checkbox" data-item-id="${escapeHtml(item.id)}" data-change="toggleItemSeoDesc"></td>
            <td>${item.image_url
                ? `<img src="${escapeHtml(item.image_url)}" class="thumbnail" alt="">`
                : '<div class="thumbnail-placeholder">?</div>'}</td>
            <td>
                <div class="item-name">${escapeHtml(item.name)}</div>
            </td>
            <td class="text-preview">${escapeHtml(item.seo_title || 'N/A')}</td>
            <td class="text-preview">${escapeHtml(item.description?.substring(0, 100) || 'N/A')}${item.description?.length > 100 ? '...' : ''}</td>
        </tr>
    `).join('');

    updateSelectionCount('seo_description');
}

function renderCompleteTab() {
    const tbody = document.getElementById('complete-body');
    const items = statusData?.complete || [];

    if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state"><h3>No items complete yet</h3><p>Generate content for items in the other tabs.</p></td></tr>';
        return;
    }

    tbody.innerHTML = items.map(item => `
        <tr>
            <td>${item.image_url
                ? `<img src="${escapeHtml(item.image_url)}" class="thumbnail" alt="">`
                : '<div class="thumbnail-placeholder">?</div>'}</td>
            <td>
                <div class="item-name">${escapeHtml(item.name)}</div>
            </td>
            <td>${escapeHtml(item.category_name || 'N/A')}</td>
            <td class="text-preview">${escapeHtml(item.seo_title || 'N/A')}</td>
            <td class="text-preview">${escapeHtml(item.seo_description || 'N/A')}</td>
        </tr>
    `).join('');
}

// ==================== Tab Navigation ====================

function switchTab(element, event, tabName) {
    if (typeof element === 'string') {
        tabName = element;
    }
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');
}

// ==================== Selection Management ====================

function toggleItemDescription(element) {
    toggleItem(element, 'description');
}

function toggleItemSeoTitle(element) {
    toggleItem(element, 'seo_title');
}

function toggleItemSeoDesc(element) {
    toggleItem(element, 'seo_description');
}

function toggleItem(element, fieldType) {
    const itemId = element.dataset.itemId;
    if (element.checked) {
        if (selectedItems[fieldType].size < 10) {
            selectedItems[fieldType].add(itemId);
        } else {
            element.checked = false;
            showAlert('Maximum 10 items can be selected at once.', 'warning');
        }
    } else {
        selectedItems[fieldType].delete(itemId);
    }
    updateSelectionCount(fieldType);
}

function toggleSelectAllDescription(element) {
    toggleSelectAll(element, 'description', 'needs-description-body');
}

function toggleSelectAllSeoTitle(element) {
    toggleSelectAll(element, 'seo_title', 'needs-seo-title-body');
}

function toggleSelectAllSeoDesc(element) {
    toggleSelectAll(element, 'seo_description', 'needs-seo-desc-body');
}

function toggleSelectAll(selectAllElement, fieldType, tbodyId) {
    const checkboxes = document.querySelectorAll(`#${tbodyId} input[type="checkbox"]`);
    const shouldSelect = selectAllElement.checked;

    selectedItems[fieldType].clear();

    checkboxes.forEach((cb, index) => {
        if (shouldSelect && index < 10) {
            cb.checked = true;
            selectedItems[fieldType].add(cb.dataset.itemId);
        } else {
            cb.checked = false;
        }
    });

    updateSelectionCount(fieldType);
}

function updateSelectionCount(fieldType) {
    const count = selectedItems[fieldType].size;
    const fieldMap = {
        'description': { countId: 'selected-count-description', btnId: 'btn-generate-descriptions' },
        'seo_title': { countId: 'selected-count-seo-title', btnId: 'btn-generate-seo-titles' },
        'seo_description': { countId: 'selected-count-seo-desc', btnId: 'btn-generate-seo-desc' }
    };

    const { countId, btnId } = fieldMap[fieldType];
    document.getElementById(countId).textContent = `${count} selected`;
    document.getElementById(btnId).disabled = count === 0;
}

// ==================== Content Generation ====================

async function generateDescriptions() {
    await generateContent('description', Array.from(selectedItems.description));
}

async function generateSeoTitles() {
    await generateContent('seo_title', Array.from(selectedItems.seo_title));
}

async function generateSeoDescriptions() {
    await generateContent('seo_description', Array.from(selectedItems.seo_description));
}

async function generateContent(fieldType, itemIds) {
    // API key is stored server-side, no need to pass it from frontend

    if (itemIds.length === 0) {
        showAlert('Please select at least one item.', 'warning');
        return;
    }

    currentFieldType = fieldType;
    const options = getGenerationOptions();

    // Show loading state
    const fieldLabels = {
        'description': 'descriptions',
        'seo_title': 'SEO titles',
        'seo_description': 'SEO descriptions'
    };

    showAlert(`Generating ${fieldLabels[fieldType]} for ${itemIds.length} item(s)... This may take a moment.`, 'info');

    try {
        const response = await fetch('/api/ai-autofill/generate', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                itemIds,
                fieldType,
                context: options.context,
                keywords: options.keywords,
                tone: options.tone
            })
        });

        const result = await response.json();

        if (!response.ok || !result.success) {
            throw new Error(result.error || result.details?.join(', ') || 'Generation failed');
        }

        generatedResults = result.data.results;
        renderReviewTab(fieldType);
        switchTab(null, null, 'review');
        showAlert(`Generated ${fieldLabels[fieldType]} for ${generatedResults.length} item(s). Review and apply.`, 'success');

    } catch (error) {
        console.error('Generation failed:', error);
        showAlert('Generation failed: ' + error.message, 'error');
    }
}

// ==================== Review Tab ====================

function renderReviewTab(fieldType) {
    const container = document.getElementById('review-content');

    if (!generatedResults || generatedResults.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>No Content to Review</h3>
                <p>Select items from another tab and generate content to review it here.</p>
            </div>
        `;
        return;
    }

    const fieldLabels = {
        'description': 'Description',
        'seo_title': 'SEO Title',
        'seo_description': 'SEO Description'
    };

    const charLimits = {
        'description': { warn: 200, max: 5000 },
        'seo_title': { warn: 55, max: 60 },
        'seo_description': { warn: 155, max: 160 }
    };

    const limit = charLimits[fieldType];

    container.innerHTML = `
        <div class="selection-controls">
            <input type="checkbox" id="select-all-review" checked data-change="toggleSelectAllReview">
            <label for="select-all-review">Include All</label>
            <span id="review-count">${generatedResults.length} item(s)</span>
            <button class="btn btn-success" data-action="applyGenerated" id="btn-apply">
                Apply to Square
            </button>
        </div>
        <div id="review-items">
            ${generatedResults.map((item, index) => `
                <div class="generated-item" data-index="${index}">
                    <div class="generated-item-header">
                        <input type="checkbox" checked class="review-checkbox" data-index="${index}" data-change="toggleReviewItem">
                        <strong>${escapeHtml(item.name)}</strong>
                    </div>
                    <div class="generated-item-body">
                        <div class="field-group">
                            <label>Original ${fieldLabels[fieldType]}</label>
                            <div class="original">${escapeHtml(item.original) || '<em>None</em>'}</div>
                        </div>
                        <div class="field-group">
                            <label>Generated ${fieldLabels[fieldType]}</label>
                            <textarea class="generated-textarea" data-index="${index}" data-input="updateCharCount">${escapeHtml(item.generated || '')}</textarea>
                            <div class="char-count" id="char-count-${index}">${(item.generated || '').length} / ${limit.max} chars</div>
                        </div>
                    </div>
                </div>
            `).join('')}
        </div>
    `;

    // Update char counts
    generatedResults.forEach((item, index) => {
        updateCharCountForIndex(index, limit);
    });
}

function updateCharCount(element) {
    const index = parseInt(element.dataset.index);
    const fieldType = currentFieldType;
    const charLimits = {
        'description': { warn: 200, max: 5000 },
        'seo_title': { warn: 55, max: 60 },
        'seo_description': { warn: 155, max: 160 }
    };
    const limit = charLimits[fieldType];
    updateCharCountForIndex(index, limit);
}

function updateCharCountForIndex(index, limit) {
    const textarea = document.querySelector(`.generated-textarea[data-index="${index}"]`);
    const countEl = document.getElementById(`char-count-${index}`);
    if (!textarea || !countEl) return;

    const len = textarea.value.length;
    countEl.textContent = `${len} / ${limit.max} chars`;

    if (len > limit.max) {
        countEl.className = 'char-count error';
    } else if (len > limit.warn) {
        countEl.className = 'char-count warning';
    } else {
        countEl.className = 'char-count';
    }
}

function toggleReviewItem(element) {
    // Just for visual tracking, actual values come from checkboxes on apply
}

function toggleSelectAllReview(element) {
    const checkboxes = document.querySelectorAll('.review-checkbox');
    checkboxes.forEach(cb => cb.checked = element.checked);
}

// ==================== Apply to Square ====================

async function applyGenerated() {
    if (!generatedResults || generatedResults.length === 0) {
        showAlert('No content to apply.', 'warning');
        return;
    }

    // Collect selected items with their edited values
    const updates = [];
    const checkboxes = document.querySelectorAll('.review-checkbox:checked');

    checkboxes.forEach(cb => {
        const index = parseInt(cb.dataset.index);
        const item = generatedResults[index];
        const textarea = document.querySelector(`.generated-textarea[data-index="${index}"]`);
        const value = textarea ? textarea.value.trim() : item.generated;

        if (value) {
            updates.push({
                itemId: item.itemId,
                fieldType: currentFieldType,
                value: value
            });
        }
    });

    if (updates.length === 0) {
        showAlert('No items selected or all values are empty.', 'warning');
        return;
    }

    showAlert(`Applying ${updates.length} update(s) to Square...`, 'info');

    try {
        const response = await fetch('/api/ai-autofill/apply', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ updates })
        });

        const result = await response.json();

        if (!response.ok || !result.success) {
            throw new Error(result.error || 'Apply failed');
        }

        const { succeeded, failed } = result.data;

        if (failed.length > 0) {
            showAlert(`Applied ${succeeded.length} update(s). ${failed.length} failed: ${failed.map(f => f.error).join(', ')}`, 'warning');
        } else {
            showAlert(`Successfully applied ${succeeded.length} update(s) to Square!`, 'success');
        }

        // Clear state and refresh
        generatedResults = [];
        selectedItems[currentFieldType].clear();
        currentFieldType = null;

        // Reload data
        await loadStatus();
        switchTab(null, null, 'complete');

    } catch (error) {
        console.error('Apply failed:', error);
        showAlert('Apply failed: ' + error.message, 'error');
    }
}

// ==================== Utility Functions ====================

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function showAlert(message, type) {
    // Remove existing alerts
    const existingAlerts = document.querySelectorAll('.floating-alert');
    existingAlerts.forEach(a => a.remove());

    const alert = document.createElement('div');
    alert.className = `alert alert-${type} floating-alert`;
    alert.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 1000; max-width: 400px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);';
    alert.textContent = message;

    document.body.appendChild(alert);

    // Auto-remove after 5 seconds for success/info, longer for errors
    const timeout = (type === 'error' || type === 'warning') ? 8000 : 5000;
    setTimeout(() => alert.remove(), timeout);
}
