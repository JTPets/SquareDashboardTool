/**
 * Bundle Manager Page JavaScript
 * Externalized from bundle-manager.html for CSP compliance
 */

let allBundles = [];
let editingBundleId = null;
let pendingComponents = [];
let selectedBundleItem = null;
let searchTimeout = null;

// ==================== INITIALIZATION ====================

async function loadBundles() {
    try {
        const response = await fetch('/api/bundles');
        const data = await response.json();
        allBundles = data.bundles || [];
        renderBundleList();
    } catch (error) {
        console.error('Failed to load bundles:', error);
        document.getElementById('bundle-list').innerHTML = `
            <div class="empty-state"><h3>Failed to load bundles</h3><p>${escapeHtml(error.message)}</p></div>`;
    }
}

async function loadVendors() {
    try {
        const response = await fetch('/api/vendors?status=ACTIVE');
        const data = await response.json();
        const vendors = Array.isArray(data) ? data : (data.vendors || []);
        const select = document.getElementById('bundle-vendor');
        select.innerHTML = '<option value="">No vendor</option>';
        vendors.forEach(v => {
            const option = document.createElement('option');
            option.value = v.id;
            option.textContent = v.name;
            select.appendChild(option);
        });
    } catch (error) {
        console.error('Failed to load vendors:', error);
    }
}

// ==================== RENDER ====================

function renderBundleList() {
    const container = document.getElementById('bundle-list');
    if (allBundles.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>No Bundles Defined</h3>
                <p>Create your first bundle to start optimizing reorder suggestions.</p>
            </div>`;
        return;
    }

    container.innerHTML = allBundles.map(bundle => {
        const components = bundle.components || [];
        const statusClass = bundle.is_active ? 'active' : 'inactive';
        const statusText = bundle.is_active ? 'Active' : 'Inactive';
        const cost = (bundle.bundle_cost_cents / 100).toFixed(2);

        return `
            <div class="bundle-card" data-bundle-id="${bundle.id}">
                <div class="bundle-card-header" data-action="toggleBundleCard" data-action-param="${bundle.id}">
                    <div class="bundle-info">
                        <div class="bundle-name">${escapeHtml(bundle.bundle_item_name)}</div>
                        <div class="bundle-meta">
                            $${cost} | ${components.length} components |
                            ${bundle.vendor_name ? escapeHtml(bundle.vendor_name) : 'No vendor'} |
                            <span class="bundle-status ${statusClass}">${statusText}</span>
                        </div>
                    </div>
                    <div class="bundle-actions">
                        <button class="btn btn-edit" data-action="editBundle" data-action-param="${bundle.id}">Edit</button>
                        ${bundle.is_active
                            ? `<button class="btn btn-delete" data-action="deactivateBundle" data-action-param="${bundle.id}">Deactivate</button>`
                            : ''}
                    </div>
                </div>
                <div class="bundle-components" id="bundle-detail-${bundle.id}" style="display: none;">
                    <table class="component-table">
                        <thead>
                            <tr><th>Component</th><th>SKU</th><th>Qty per Bundle</th><th>Individual Cost</th></tr>
                        </thead>
                        <tbody>
                            ${components.map(c => `
                                <tr>
                                    <td>${escapeHtml(c.child_item_name || 'Unknown')}</td>
                                    <td style="font-family: monospace; color: #6b7280;">${escapeHtml(c.child_sku || '-')}</td>
                                    <td>${c.quantity_in_bundle}</td>
                                    <td>${c.individual_cost_cents ? '$' + (c.individual_cost_cents / 100).toFixed(2) : '-'}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>`;
    }).join('');
}

// ==================== ACTIONS ====================

function toggleBundleCard(element, event, bundleId) {
    // Don't toggle if clicking action buttons
    if (event.target.closest('.bundle-actions')) return;
    const detail = document.getElementById(`bundle-detail-${bundleId}`);
    if (detail) {
        detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
    }
}

function showCreateForm() {
    editingBundleId = null;
    selectedBundleItem = null;
    pendingComponents = [];
    document.getElementById('form-title').textContent = 'Create New Bundle';
    document.getElementById('bundle-item-search').value = '';
    document.getElementById('bundle-variation-id').value = '';
    document.getElementById('bundle-item-id').value = '';
    document.getElementById('bundle-item-name-hidden').value = '';
    document.getElementById('bundle-cost').value = '';
    document.getElementById('bundle-sell-price').value = '';
    document.getElementById('bundle-vendor').value = '';
    document.getElementById('bundle-notes').value = '';
    document.getElementById('bundle-item-search').disabled = false;
    renderComponentEditor();
    document.getElementById('bundle-form').classList.add('visible');
}

function editBundle(element, event, bundleId) {
    event.stopPropagation();
    const bundle = allBundles.find(b => b.id === parseInt(bundleId));
    if (!bundle) return;

    editingBundleId = bundle.id;
    selectedBundleItem = {
        variation_id: bundle.bundle_variation_id,
        item_id: bundle.bundle_item_id,
        name: bundle.bundle_item_name
    };
    pendingComponents = (bundle.components || []).map(c => ({
        child_variation_id: c.child_variation_id,
        child_item_name: c.child_item_name,
        child_sku: c.child_sku,
        quantity_in_bundle: c.quantity_in_bundle,
        individual_cost_cents: c.individual_cost_cents
    }));

    document.getElementById('form-title').textContent = 'Edit Bundle';
    document.getElementById('bundle-item-search').value = bundle.bundle_item_name;
    document.getElementById('bundle-item-search').disabled = true;
    document.getElementById('bundle-variation-id').value = bundle.bundle_variation_id;
    document.getElementById('bundle-item-id').value = bundle.bundle_item_id || '';
    document.getElementById('bundle-item-name-hidden').value = bundle.bundle_item_name;
    document.getElementById('bundle-cost').value = (bundle.bundle_cost_cents / 100).toFixed(2);
    document.getElementById('bundle-sell-price').value = bundle.bundle_sell_price_cents
        ? (bundle.bundle_sell_price_cents / 100).toFixed(2) : '';
    document.getElementById('bundle-vendor').value = bundle.vendor_id || '';
    document.getElementById('bundle-notes').value = bundle.notes || '';
    renderComponentEditor();
    document.getElementById('bundle-form').classList.add('visible');
}

function cancelForm() {
    document.getElementById('bundle-form').classList.remove('visible');
    editingBundleId = null;
    pendingComponents = [];
    selectedBundleItem = null;
}

async function deactivateBundle(element, event, bundleId) {
    event.stopPropagation();
    const bundle = allBundles.find(b => b.id === parseInt(bundleId));
    if (!bundle) return;

    if (!confirm(`Deactivate "${bundle.bundle_item_name}"? It will no longer appear in reorder suggestions.`)) {
        return;
    }

    try {
        const response = await fetch(`/api/bundles/${bundleId}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('Failed to deactivate bundle');
        showToast('Bundle deactivated', 'success');
        await loadBundles();
    } catch (error) {
        console.error('Failed to deactivate:', error);
        showToast('Failed to deactivate bundle', 'error');
    }
}

// ==================== CATALOG SEARCH ====================

async function searchCatalog(query) {
    if (!query || query.length < 2) return [];
    try {
        const response = await fetch(`/api/variations?search=${encodeURIComponent(query)}&limit=20`);
        const data = await response.json();
        const variations = data.variations || [];
        return variations.map(v => ({
            variation_id: v.id,
            item_id: v.item_id,
            name: v.item_name || v.name,
            variation_name: v.name,
            sku: v.sku || null
        }));
    } catch (error) {
        console.error('Catalog search failed:', error);
        return [];
    }
}

function searchBundleItem(element) {
    clearTimeout(searchTimeout);
    const query = element.value.trim();
    const dropdown = document.getElementById('bundle-item-dropdown');

    if (query.length < 2) {
        dropdown.classList.remove('visible');
        return;
    }

    searchTimeout = setTimeout(async () => {
        const results = await searchCatalog(query);
        if (results.length === 0) {
            dropdown.innerHTML = '<div class="search-option">No results found</div>';
        } else {
            dropdown.innerHTML = results.map((r, i) => `
                <div class="search-option" data-action="selectBundleItem" data-action-param="${i}">
                    <div class="option-name">${escapeHtml(r.name)}${r.variation_name ? ' - ' + escapeHtml(r.variation_name) : ''}</div>
                    <div class="option-sku">${r.sku ? 'SKU: ' + escapeHtml(r.sku) : 'No SKU'} | ${r.variation_id}</div>
                </div>
            `).join('');
        }
        dropdown.classList.add('visible');
        // Store results for selection
        dropdown._results = results;
    }, 300);
}

function selectBundleItem(element, event, index) {
    const dropdown = document.getElementById('bundle-item-dropdown');
    const results = dropdown._results || [];
    const item = results[parseInt(index)];
    if (!item) return;

    selectedBundleItem = item;
    document.getElementById('bundle-item-search').value = item.name + (item.variation_name ? ' - ' + item.variation_name : '');
    document.getElementById('bundle-variation-id').value = item.variation_id;
    document.getElementById('bundle-item-id').value = item.item_id;
    document.getElementById('bundle-item-name-hidden').value = item.name + (item.variation_name ? ' - ' + item.variation_name : '');
    dropdown.classList.remove('visible');
}

function searchComponentItem(element) {
    clearTimeout(searchTimeout);
    const query = element.value.trim();
    const dropdown = document.getElementById('comp-item-dropdown');

    if (query.length < 2) {
        dropdown.classList.remove('visible');
        return;
    }

    searchTimeout = setTimeout(async () => {
        const results = await searchCatalog(query);
        if (results.length === 0) {
            dropdown.innerHTML = '<div class="search-option">No results found</div>';
        } else {
            dropdown.innerHTML = results.map((r, i) => `
                <div class="search-option" data-action="selectComponentItem" data-action-param="${i}">
                    <div class="option-name">${escapeHtml(r.name)}${r.variation_name ? ' - ' + escapeHtml(r.variation_name) : ''}</div>
                    <div class="option-sku">${r.sku ? 'SKU: ' + escapeHtml(r.sku) : 'No SKU'}</div>
                </div>
            `).join('');
        }
        dropdown.classList.add('visible');
        dropdown._results = results;
    }, 300);
}

let selectedComponent = null;

function selectComponentItem(element, event, index) {
    const dropdown = document.getElementById('comp-item-dropdown');
    const results = dropdown._results || [];
    const item = results[parseInt(index)];
    if (!item) return;

    selectedComponent = item;
    document.getElementById('comp-item-search').value = item.name + (item.variation_name ? ' - ' + item.variation_name : '');
    dropdown.classList.remove('visible');
}

// ==================== COMPONENT EDITOR ====================

function addComponent() {
    if (!selectedComponent) {
        showToast('Please select a component item first', 'error');
        return;
    }

    // Check for duplicates
    if (pendingComponents.some(c => c.child_variation_id === selectedComponent.variation_id)) {
        showToast('This component is already added', 'error');
        return;
    }

    const qty = parseInt(document.getElementById('comp-qty').value) || 1;
    const costDollars = parseFloat(document.getElementById('comp-cost').value) || 0;

    pendingComponents.push({
        child_variation_id: selectedComponent.variation_id,
        child_item_name: selectedComponent.name + (selectedComponent.variation_name ? ' - ' + selectedComponent.variation_name : ''),
        child_sku: selectedComponent.sku,
        quantity_in_bundle: qty,
        individual_cost_cents: Math.round(costDollars * 100)
    });

    // Reset inputs
    document.getElementById('comp-item-search').value = '';
    document.getElementById('comp-qty').value = '1';
    document.getElementById('comp-cost').value = '';
    selectedComponent = null;

    renderComponentEditor();
}

function removeComponent(element, event, index) {
    pendingComponents.splice(parseInt(index), 1);
    renderComponentEditor();
}

function renderComponentEditor() {
    const table = document.getElementById('component-table');
    const tbody = document.getElementById('component-tbody');

    if (pendingComponents.length === 0) {
        table.style.display = 'none';
        return;
    }

    table.style.display = 'table';
    tbody.innerHTML = pendingComponents.map((c, i) => `
        <tr>
            <td>${escapeHtml(c.child_item_name || 'Unknown')}</td>
            <td style="font-family: monospace; color: #6b7280;">${escapeHtml(c.child_sku || '-')}</td>
            <td>${c.quantity_in_bundle}</td>
            <td>${c.individual_cost_cents ? '$' + (c.individual_cost_cents / 100).toFixed(2) : '-'}</td>
            <td><button class="btn-remove" data-action="removeComponent" data-action-param="${i}" title="Remove">x</button></td>
        </tr>
    `).join('');
}

// ==================== SAVE ====================

async function saveBundle() {
    const variationId = document.getElementById('bundle-variation-id').value;
    const itemName = document.getElementById('bundle-item-name-hidden').value;
    const costDollars = parseFloat(document.getElementById('bundle-cost').value) || 0;
    const sellDollars = parseFloat(document.getElementById('bundle-sell-price').value) || 0;
    const vendorId = document.getElementById('bundle-vendor').value;
    const notes = document.getElementById('bundle-notes').value;

    if (!variationId) {
        showToast('Please select a bundle item from the catalog', 'error');
        return;
    }
    if (costDollars <= 0) {
        showToast('Please enter the bundle cost', 'error');
        return;
    }
    if (pendingComponents.length === 0) {
        showToast('Please add at least one component', 'error');
        return;
    }

    const payload = {
        bundle_variation_id: variationId,
        bundle_item_id: document.getElementById('bundle-item-id').value || undefined,
        bundle_item_name: itemName,
        bundle_cost_cents: Math.round(costDollars * 100),
        bundle_sell_price_cents: sellDollars > 0 ? Math.round(sellDollars * 100) : undefined,
        vendor_id: vendorId ? parseInt(vendorId) : undefined,
        notes: notes || undefined,
        components: pendingComponents.map(c => ({
            child_variation_id: c.child_variation_id,
            quantity_in_bundle: c.quantity_in_bundle,
            individual_cost_cents: c.individual_cost_cents || undefined
        }))
    };

    try {
        let response;
        if (editingBundleId) {
            response = await fetch(`/api/bundles/${editingBundleId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } else {
            response = await fetch('/api/bundles', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        }

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Failed to save bundle');
        }

        showToast(editingBundleId ? 'Bundle updated' : 'Bundle created', 'success');
        cancelForm();
        await loadBundles();
    } catch (error) {
        console.error('Failed to save bundle:', error);
        showToast(error.message, 'error');
    }
}

// ==================== UTILITIES ====================

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showToast(message, type = '') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast ${type}`;
    toast.classList.add('active');
    setTimeout(() => toast.classList.remove('active'), 3000);
}

// Close dropdowns when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-container')) {
        document.querySelectorAll('.search-dropdown').forEach(d => d.classList.remove('visible'));
    }
});

// ==================== INIT ====================

document.addEventListener('DOMContentLoaded', async () => {
    await Promise.all([loadBundles(), loadVendors()]);
});

// Expose to global scope for event delegation
window.showCreateForm = showCreateForm;
window.toggleBundleCard = toggleBundleCard;
window.editBundle = editBundle;
window.deactivateBundle = deactivateBundle;
window.selectBundleItem = selectBundleItem;
window.searchBundleItem = searchBundleItem;
window.searchComponentItem = searchComponentItem;
window.selectComponentItem = selectComponentItem;
window.addComponent = addComponent;
window.removeComponent = removeComponent;
window.saveBundle = saveBundle;
window.cancelForm = cancelForm;
