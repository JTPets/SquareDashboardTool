/**
 * Loyalty Program Manager Page Script
 * Handles loyalty offers, customer lookup, rewards, redemptions, and reports
 */

let allOffers = [];
let allVariations = [];
let selectedVariations = new Set();
let variationAssignments = {}; // Maps variation_id to offer info
let currentOfferId = null; // Track which offer we're editing

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  loadOffers();
});

// Handle image error - hide image and show placeholder
document.addEventListener('error', function(event) {
  if (event.target.tagName === 'IMG' && event.target.dataset.errorAction === 'hideImageShowPlaceholder') {
    event.target.style.display = 'none';
    if (event.target.nextElementSibling) {
      event.target.nextElementSibling.style.display = 'block';
    }
  }
}, true);

// Helper functions for event delegation
function switchTabFromClick(element) {
  const tabName = element.dataset.tab;
  switchTab(tabName);
}

function deleteOfferFromButton(element) {
  const offerId = element.dataset.offerId;
  const offerName = element.dataset.offerName;
  deleteOffer(offerId, offerName);
}

function toggleVariationCardStop(element, event) {
  event.stopPropagation();
  const variationId = element.dataset.actionParam;
  toggleVariationCard(variationId);
}

function viewOrderAuditHistoryFromButton(element) {
  const customerId = element.dataset.customerId;
  const displayName = element.dataset.displayName;
  viewOrderAuditHistory(customerId, displayName);
}

function showRedeemModalFromButton(element) {
  const rewardId = element.dataset.rewardId;
  const offerName = element.dataset.offerName;
  const customerId = element.dataset.customerId;
  showRedeemModal(rewardId, offerName, customerId);
}

function toggleAllAuditOrdersFromCheckbox(element) {
  toggleAllAuditOrders(element.checked);
}

function toggleAuditOrderFromCheckbox(element) {
  const orderId = element.dataset.orderId;
  toggleAuditOrder(orderId, element.checked);
}

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');
  document.getElementById(`tab-${tabName}`).classList.add('active');

  if (tabName === 'rewards') loadRewards();
  if (tabName === 'redemptions') loadRedemptions();
  if (tabName === 'settings') loadSettings();
}

// Stats
async function loadStats() {
  try {
    const response = await fetch('/api/loyalty/stats');
    const data = await response.json();
    const stats = data.stats;

    document.getElementById('stat-offers').textContent = stats.offers?.active || 0;
    document.getElementById('stat-earned').textContent = stats.rewards?.earned || 0;
    document.getElementById('stat-redeemed').textContent = stats.last30Days?.redeemed || 0;
    document.getElementById('stat-value').textContent = '$' + ((stats.totalRedemptionValueCents || 0) / 100).toFixed(2);
  } catch (error) {
    console.error('Failed to load stats:', error);
  }
}

// Offers
async function loadOffers() {
  const tbody = document.getElementById('offers-table-body');
  tbody.innerHTML = '<tr><td colspan="10" class="loading"><div class="spinner"></div><br>Loading...</td></tr>';

  try {
    const activeOnly = document.getElementById('offer-filter-active').checked;
    const response = await fetch(`/api/loyalty/offers?activeOnly=${activeOnly}`);
    const data = await response.json();
    allOffers = data.offers;

    // Populate brand filter
    const brands = [...new Set(allOffers.map(o => o.brand_name))];
    const brandFilter = document.getElementById('offer-filter-brand');
    brandFilter.innerHTML = '<option value="">All Brands</option>' +
      brands.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');

    // Also populate reward filter
    const rewardFilter = document.getElementById('reward-filter-offer');
    const redemptionFilter = document.getElementById('redemption-filter-offer');
    const offerOptions = '<option value="">All Offers</option>' +
      allOffers.map(o => `<option value="${o.id}">${escapeHtml(o.offer_name)}</option>`).join('');
    rewardFilter.innerHTML = offerOptions;
    redemptionFilter.innerHTML = offerOptions;

    if (allOffers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" class="empty-state"><h3>No Offers Yet</h3><p>Create your first loyalty offer to get started.</p></td></tr>';
      return;
    }

    tbody.innerHTML = allOffers.map(offer => `
      <tr>
        <td><strong>${escapeHtml(offer.offer_name)}</strong></td>
        <td>${escapeHtml(offer.brand_name)}</td>
        <td>${escapeHtml(offer.size_group)}</td>
        <td>Buy ${offer.required_quantity} Get 1</td>
        <td>${offer.window_months} months</td>
        <td class="text-center">${offer.variation_count || 0}</td>
        <td class="text-center">${offer.pending_rewards || 0}</td>
        <td class="text-center">${offer.total_redeemed || 0}</td>
        <td><span class="status-badge ${offer.is_active ? 'active' : 'inactive'}">${offer.is_active ? 'Active' : 'Inactive'}</span></td>
        <td>
          <button class="action-btn view" data-action="showVariationsModal" data-action-param="${escapeJsString(offer.id)}">Variations</button>
          <button class="action-btn edit" data-action="editOffer" data-action-param="${escapeJsString(offer.id)}">Edit</button>
          <button class="action-btn danger" data-action="deleteOfferFromButton" data-offer-id="${escapeJsString(offer.id)}" data-offer-name="${escapeJsString(offer.offer_name)}">Delete</button>
        </td>
      </tr>
    `).join('');

  } catch (error) {
    console.error('Failed to load offers:', error);
    tbody.innerHTML = '<tr><td colspan="10" class="empty-state">Failed to load offers. Please try again.</td></tr>';
  }
}

async function loadVendorsDropdown() {
  try {
    const response = await fetch('/api/vendors');
    if (response.ok) {
      const data = await response.json();
      const select = document.getElementById('offer-vendor');
      select.innerHTML = '<option value="">-- Select Vendor --</option>';
      for (const vendor of (data.vendors || data || [])) {
        select.innerHTML += `<option value="${vendor.id}">${vendor.name}</option>`;
      }
    }
  } catch (error) {
    console.error('Failed to load vendors:', error);
  }
}

async function showCreateOfferModal() {
  document.getElementById('offer-modal-title').textContent = 'Create Loyalty Offer';
  document.getElementById('offer-edit-id').value = '';
  document.getElementById('offer-name').value = '';
  document.getElementById('offer-brand').value = '';
  document.getElementById('offer-size').value = '';
  document.getElementById('offer-quantity').value = '12';
  document.getElementById('offer-window').value = '12';
  document.getElementById('offer-description').value = '';
  document.getElementById('offer-vendor').value = '';
  // Re-enable fields (may be disabled from previous edit)
  document.getElementById('offer-brand').disabled = false;
  document.getElementById('offer-size').disabled = false;
  document.getElementById('offer-quantity').disabled = false;
  document.getElementById('offer-window').disabled = false;
  await loadVendorsDropdown();
  showModal('offer-modal');
}

async function editOffer(element, event, offerId) {
  const offer = allOffers.find(o => o.id === offerId);
  if (!offer) return;

  document.getElementById('offer-modal-title').textContent = 'Edit Loyalty Offer';
  document.getElementById('offer-edit-id').value = offer.id;
  document.getElementById('offer-name').value = offer.offer_name;
  document.getElementById('offer-brand').value = offer.brand_name;
  document.getElementById('offer-size').value = offer.size_group;
  document.getElementById('offer-quantity').value = offer.required_quantity;
  document.getElementById('offer-window').value = offer.window_months;
  document.getElementById('offer-description').value = offer.description || '';

  // Disable brand/quantity for existing offers (size_group and window_months remain editable)
  document.getElementById('offer-brand').disabled = true;
  document.getElementById('offer-size').disabled = false;
  document.getElementById('offer-quantity').disabled = true;
  document.getElementById('offer-window').disabled = false;

  // Load vendors and set current selection
  await loadVendorsDropdown();
  document.getElementById('offer-vendor').value = offer.vendor_id || '';

  showModal('offer-modal');
}

async function deleteOffer(offerId, offerName) {
  const confirmed = confirm(
    `Are you sure you want to delete "${offerName}"?\n\n` +
    `This will:\n` +
    `- Remove the offer and all its qualifying variations\n` +
    `- Any customers with in-progress rewards will lose their progress\n\n` +
    `Historical redemptions will be preserved for audit purposes.\n\n` +
    `This action cannot be undone.`
  );

  if (!confirmed) return;

  try {
    const response = await fetch(`/api/loyalty/offers/${offerId}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to delete offer');
    }

    const result = await response.json();

    if (result.hadActiveRewards) {
      alert(`Offer deleted.\n\nNote: ${result.activeRewardsCount} customer(s) had active rewards in progress that are now orphaned.`);
    } else {
      alert('Offer deleted successfully!');
    }

    loadOffers();
    loadStats();

  } catch (error) {
    console.error('Failed to delete offer:', error);
    alert('Error: ' + error.message);
  }
}

async function saveOffer() {
  const editId = document.getElementById('offer-edit-id').value;
  const vendorId = document.getElementById('offer-vendor').value;
  const data = {
    offerName: document.getElementById('offer-name').value,
    brandName: document.getElementById('offer-brand').value,
    sizeGroup: document.getElementById('offer-size').value,
    requiredQuantity: parseInt(document.getElementById('offer-quantity').value),
    windowMonths: parseInt(document.getElementById('offer-window').value),
    description: document.getElementById('offer-description').value,
    vendorId: vendorId || null
  };

  if (!data.brandName || !data.sizeGroup || !data.requiredQuantity) {
    alert('Please fill in all required fields (Brand, Size Group, Required Quantity)');
    return;
  }

  try {
    let response;
    if (editId) {
      response = await fetch(`/api/loyalty/offers/${editId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offer_name: data.offerName,
          description: data.description,
          window_months: data.windowMonths,
          vendor_id: data.vendorId,
          size_group: data.sizeGroup
        })
      });
    } else {
      response = await fetch('/api/loyalty/offers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    }

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to save offer');
    }

    closeModal('offer-modal');
    loadOffers();
    loadStats();
    alert(editId ? 'Offer updated successfully!' : 'Offer created successfully!');

  } catch (error) {
    console.error('Failed to save offer:', error);
    alert('Error: ' + error.message);
  }

  // Re-enable fields
  document.getElementById('offer-brand').disabled = false;
  document.getElementById('offer-size').disabled = false;
  document.getElementById('offer-quantity').disabled = false;
  document.getElementById('offer-window').disabled = false;
}

// Variations
async function showVariationsModal(element, event, offerId) {
  document.getElementById('variations-offer-id').value = offerId;
  currentOfferId = offerId;
  selectedVariations.clear();
  showModal('variations-modal');

  // Load current variations and assignments in parallel
  try {
    const [variationsResponse, assignmentsResponse] = await Promise.all([
      fetch(`/api/loyalty/offers/${offerId}/variations`),
      fetch('/api/loyalty/variations/assignments')
    ]);

    const variationsData = await variationsResponse.json();
    const assignmentsData = await assignmentsResponse.json();

    variationAssignments = assignmentsData.assignments || {};

    variationsData.variations.forEach(v => selectedVariations.add(v.variation_id));
    updateCurrentVariationsDisplay(variationsData.variations);
  } catch (error) {
    console.error('Failed to load variations:', error);
  }

  // Load all variations for selection
  await loadAllVariations();
}

async function loadAllVariations() {
  const listEl = document.getElementById('variation-list');
  listEl.innerHTML = '<div class="loading" style="grid-column: 1/-1;"><div class="spinner"></div><br>Loading catalog...</div>';

  try {
    // Use /api/variations endpoint which includes images and UPC
    const response = await fetch('/api/variations');
    const data = await response.json();

    allVariations = (data.variations || []).map(v => ({
      variationId: v.id,
      itemId: v.item_id,
      itemName: v.item_name,
      variationName: v.name,
      sku: v.sku,
      upc: v.upc,
      imageUrls: v.image_urls || []
    }));

    renderVariationList();

  } catch (error) {
    console.error('Failed to load variations:', error);
    listEl.innerHTML = '<div class="empty-state" style="grid-column: 1/-1;">Failed to load variations</div>';
  }
}

function searchVariations() {
  renderVariationList();
}

function renderVariationList() {
  const listEl = document.getElementById('variation-list');
  const search = document.getElementById('variation-search').value.toLowerCase().trim();

  const filtered = allVariations.filter(v =>
    !search ||
    v.itemName?.toLowerCase().includes(search) ||
    v.variationName?.toLowerCase().includes(search) ||
    v.sku?.toLowerCase().includes(search) ||
    v.upc?.toLowerCase().includes(search)
  ).slice(0, 100); // Limit to 100 results

  document.getElementById('variation-count').textContent = `${filtered.length}${filtered.length === 100 ? '+' : ''} variations found`;
  updateSelectedCount();

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="empty-state" style="grid-column: 1/-1;"><h3>No variations found</h3><p>Try a different search term.</p></div>';
    return;
  }

  listEl.innerHTML = filtered.map(v => {
    const isSelected = selectedVariations.has(v.variationId);
    const imageUrl = v.imageUrls && v.imageUrls.length > 0 ? v.imageUrls[0] : null;
    const displayName = v.itemName || 'Unknown Item';
    const displayVariation = v.variationName || '';
    const displaySku = v.sku || '';
    const displayUpc = v.upc || '';

    // Check if assigned to another offer (not the current one)
    const assignment = variationAssignments[v.variationId];
    const isAssignedToOther = assignment && assignment.offerId !== currentOfferId;

    return `
      <div class="variation-item ${isSelected ? 'selected' : ''} ${isAssignedToOther ? 'assigned-other' : ''}" data-action="toggleVariationCard" data-action-param="${escapeJsString(v.variationId)}">
        <input type="checkbox" class="item-checkbox"
          id="var-${v.variationId}"
          ${isSelected ? 'checked' : ''}
          data-action="toggleVariationCardStop" data-action-param="${escapeJsString(v.variationId)}"
        >
        <div class="image-container">
          ${imageUrl
            ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(displayName)}" data-error-action="hideImageShowPlaceholder"><div class="no-image" style="display:none;">No image</div>`
            : `<div class="no-image">No image</div>`
          }
        </div>
        <div class="info">
          <div class="name">${escapeHtml(displayName)}</div>
          ${displayVariation ? `<div class="variation-name">${escapeHtml(displayVariation)}</div>` : ''}
          <div class="sku-gtin">
            ${displaySku ? `<span>SKU: ${escapeHtml(displaySku)}</span>` : ''}
            ${displayUpc ? `<span>UPC: ${escapeHtml(displayUpc)}</span>` : ''}
            ${!displaySku && !displayUpc ? '<span style="color: #d1d5db;">No SKU/UPC</span>' : ''}
          </div>
          ${isAssignedToOther ? `<div class="assigned-badge">Already in: ${escapeHtml(assignment.offerName)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function toggleVariationCard(elementOrVariationId, event, variationId) {
  // Handle both direct calls and event delegation
  const varId = variationId !== undefined ? variationId : elementOrVariationId;
  if (selectedVariations.has(varId)) {
    selectedVariations.delete(varId);
  } else {
    selectedVariations.add(varId);
  }

  // Update UI without full re-render
  const card = document.querySelector(`#var-${varId}`)?.closest('.variation-item');
  const checkbox = document.getElementById(`var-${varId}`);
  if (card && checkbox) {
    const isSelected = selectedVariations.has(varId);
    card.classList.toggle('selected', isSelected);
    checkbox.checked = isSelected;
  }

  updateSelectedCount();
  updateCurrentVariationsDisplayFromSelection();
}

function updateSelectedCount() {
  document.getElementById('selected-count').textContent = `${selectedVariations.size} selected`;
  document.getElementById('current-count').textContent = selectedVariations.size;
}

function updateCurrentVariationsDisplayFromSelection() {
  const el = document.getElementById('current-variations');
  if (selectedVariations.size === 0) {
    el.innerHTML = '<span style="color: #6b7280;">None selected</span>';
    return;
  }

  const selectedVars = Array.from(selectedVariations).map(varId => {
    const v = allVariations.find(av => av.variationId === varId);
    return v ? `${v.itemName}${v.variationName ? ' - ' + v.variationName : ''}` : varId;
  });

  el.innerHTML = selectedVars.map(name => `
    <span style="display: inline-block; background: #e0e7ff; padding: 4px 8px; border-radius: 4px; margin: 2px; font-size: 12px;">
      ${escapeHtml(name)}
    </span>
  `).join('');
}

// Legacy function - redirect to new one
function toggleVariation(variationId) {
  toggleVariationCard(variationId);
}

function updateCurrentVariationsDisplay(variations) {
  const el = document.getElementById('current-variations');
  document.getElementById('current-count').textContent = variations.length;
  document.getElementById('selected-count').textContent = `${variations.length} selected`;

  if (variations.length === 0) {
    el.innerHTML = '<span style="color: #6b7280;">None selected</span>';
    return;
  }

  el.innerHTML = variations.map(v => `
    <span style="display: inline-block; background: #e0e7ff; padding: 4px 8px; border-radius: 4px; margin: 2px; font-size: 12px;">
      ${escapeHtml(v.item_name || '')}${v.variation_name ? ' - ' + escapeHtml(v.variation_name) : ''}
    </span>
  `).join('');
}

async function saveVariations() {
  const offerId = document.getElementById('variations-offer-id').value;

  if (!offerId) {
    alert('Error: No offer selected. Please close and try again.');
    return;
  }

  const variations = Array.from(selectedVariations).map(varId => {
    const v = allVariations.find(av => av.variationId === varId);
    return {
      variationId: varId,
      itemId: v?.itemId,
      itemName: v?.itemName,
      variationName: v?.variationName,
      sku: v?.sku,
      upc: v?.upc
    };
  });

  if (variations.length === 0) {
    alert('Please select at least one variation to save.');
    return;
  }

  try {
    const response = await fetch(`/api/loyalty/offers/${offerId}/variations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variations })
    });

    if (!response.ok) {
      const errorData = await response.json();
      // Handle variation conflict error with detailed message
      if (response.status === 409 && errorData.code === 'VARIATION_CONFLICT') {
        const conflictList = errorData.conflicts.map(c =>
          `• "${c.item_name}${c.variation_name ? ' - ' + c.variation_name : ''}" is already assigned to "${c.offer_name}"`
        ).join('\n');
        alert(`Cannot save - these variations are already assigned to other offers:\n\n${conflictList}\n\nEach variation can only belong to one offer. Please remove the conflicting variations first.`);
        return;
      }
      // Handle validation errors with details
      if (response.status === 400 && errorData.details && errorData.details.length > 0) {
        const detailMsg = errorData.details.map(d => `• ${d.field}: ${d.message}`).join('\n');
        alert(`Validation error:\n\n${detailMsg}`);
        return;
      }
      throw new Error(errorData.error || 'Failed to save variations');
    }

    closeModal('variations-modal');
    loadOffers();
    alert('Variations saved successfully!');

  } catch (error) {
    console.error('Failed to save variations:', error);
    alert('Error saving variations: ' + error.message);
  }
}

// Customer Search
function handleCustomerSearchKeyup(event) {
  if (event.key === 'Enter') searchCustomer();
}

async function searchCustomer() {
  const query = document.getElementById('customer-search').value.trim();
  const searchResults = document.getElementById('customer-search-results');
  const container = document.getElementById('customer-result-container');

  if (!query) {
    alert('Please enter a phone number, email, or name');
    return;
  }

  searchResults.style.display = 'none';
  container.innerHTML = '<div class="loading"><div class="spinner"></div><br>Searching...</div>';

  try {
    // Search for customers by phone/email/name
    const response = await fetch(`/api/loyalty/customers/search?q=${encodeURIComponent(query)}`);
    const data = await response.json();

    if (data.error) {
      container.innerHTML = `<div class="empty-state"><p style="color: #dc2626;">${escapeHtml(data.error)}</p></div>`;
      return;
    }

    if (!data.customers || data.customers.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <h3>No customers found</h3>
          <p>No customers match "${escapeHtml(query)}". Try a different search term.</p>
        </div>
      `;
      return;
    }

    // If only one result, show their loyalty status directly
    if (data.customers.length === 1) {
      await showCustomerLoyalty(data.customers[0].id, data.customers[0]);
      return;
    }

    // Multiple results - show list to pick from
    searchResults.style.display = 'block';
    searchResults.innerHTML = `
      <div style="background: #f9fafb; padding: 12px; border-radius: 8px;">
        <strong>Found ${data.customers.length} customers:</strong>
        <div style="margin-top: 10px; display: flex; flex-wrap: wrap; gap: 10px;">
          ${data.customers.map(c => `
            <button class="btn-secondary" data-action="showCustomerLoyalty" data-action-param="${escapeJsString(c.id)}" style="text-align: left; padding: 10px 15px;">
              <strong>${escapeHtml(c.displayName || 'Unknown')}</strong><br>
              <small style="color: #6b7280;">
                ${c.phone ? escapeHtml(c.phone) : ''}
                ${c.phone && c.email ? ' • ' : ''}
                ${c.email ? escapeHtml(c.email) : ''}
              </small>
            </button>
          `).join('')}
        </div>
      </div>
    `;
    container.innerHTML = '<div class="empty-state"><p>Select a customer above to view their loyalty status.</p></div>';

  } catch (error) {
    console.error('Failed to search customers:', error);
    container.innerHTML = '<div class="empty-state">Failed to search customers. Please try again.</div>';
  }
}

async function showCustomerLoyalty(elementOrCustomerId, eventOrCustomerInfo = null, customerId) {
  // Handle both direct calls and event delegation
  let actualCustomerId, actualCustomerInfo;
  if (elementOrCustomerId instanceof HTMLElement) {
    // Called via event delegation: (element, event, customerId)
    actualCustomerId = customerId;
    actualCustomerInfo = null;
  } else {
    // Called directly: (customerId, customerInfo?)
    actualCustomerId = elementOrCustomerId;
    actualCustomerInfo = eventOrCustomerInfo;
  }

  const searchResults = document.getElementById('customer-search-results');
  const container = document.getElementById('customer-result-container');

  searchResults.style.display = 'none';
  container.innerHTML = '<div class="loading"><div class="spinner"></div><br>Loading loyalty status...</div>';

  try {
    const response = await fetch(`/api/loyalty/customer/${actualCustomerId}`);
    const data = await response.json();

    // Use customer info from search or from API response
    const customer = data.customer || actualCustomerInfo || { id: actualCustomerId };
    const displayName = customer.displayName || customer.givenName || 'Unknown Customer';
    const offers = data.loyalty?.offers || data.offers || [];

    if (offers.length === 0) {
      container.innerHTML = `
        <div class="customer-result">
          <h4>${escapeHtml(displayName)}</h4>
          <p style="color: #6b7280; font-size: 13px;">
            ${customer.phone ? escapeHtml(customer.phone) : ''}
            ${customer.phone && customer.email ? ' • ' : ''}
            ${customer.email ? escapeHtml(customer.email) : ''}
          </p>
          <p style="color: #6b7280; margin-top: 10px;">No loyalty activity found for this customer.</p>
          <div style="margin-top: 15px;">
            <button class="btn-primary" data-action="viewOrderAuditHistoryFromButton" data-customer-id="${escapeJsString(actualCustomerId)}" data-display-name="${escapeJsString(displayName)}">
              Check for Missed Loyalty Items (91 Days)
            </button>
          </div>
        </div>
      `;
      return;
    }

    const offersHtml = offers.map(offer => {
      const progress = offer.current_quantity / offer.required_quantity;
      const progressPct = Math.min(progress * 100, 100);
      const isComplete = progressPct >= 100;
      const hasReward = offer.has_earned_reward;

      return `
        <div class="offer-progress ${hasReward ? 'reward-available' : ''}">
          <div class="offer-name">
            <span>${escapeHtml(offer.offer_name)}</span>
            <span>${offer.current_quantity}/${offer.required_quantity}</span>
          </div>
          <div class="progress-container">
            <div class="progress-bar ${isComplete ? 'complete' : ''}" style="width: ${progressPct}%"></div>
          </div>
          <div class="progress-text">
            ${hasReward
              ? '<span style="color: #065f46; font-weight: 700; font-size: 15px;">🎉 FREE ITEM READY TO REDEEM!</span>'
              : isComplete
                ? '<span style="color: #10b981; font-weight: 600;">Reward Available!</span>'
                : `${offer.required_quantity - offer.current_quantity} more to earn reward`}
            ${offer.window_end_date && !hasReward ? ` • Window ends: ${formatDate(offer.window_end_date)}` : ''}
          </div>
          ${hasReward ? `
            <button class="btn-redeem-large" data-action="showRedeemModalFromButton" data-reward-id="${escapeJsString(offer.earned_reward_id)}" data-offer-name="${escapeJsString(offer.offer_name)}" data-customer-id="${escapeJsString(actualCustomerId)}">
              Redeem Free Item Now
            </button>
          ` : ''}
        </div>
      `;
    }).join('');

    container.innerHTML = `
      <div class="customer-result">
        <h4>${escapeHtml(displayName)}</h4>
        <p style="color: #6b7280; font-size: 13px;">
          ${customer.phone ? escapeHtml(customer.phone) : ''}
          ${customer.phone && customer.email ? ' • ' : ''}
          ${customer.email ? escapeHtml(customer.email) : ''}
        </p>
        <div class="customer-offers">
          ${offersHtml}
        </div>
        <div style="margin-top: 20px; display: flex; gap: 10px; flex-wrap: wrap;">
          <button class="btn-secondary" data-action="viewCustomerHistory" data-action-param="${escapeJsString(actualCustomerId)}">View Full History</button>
          <button class="btn-primary" data-action="viewOrderAuditHistoryFromButton" data-customer-id="${escapeJsString(actualCustomerId)}" data-display-name="${escapeJsString(displayName)}">
            View Missed Loyalty Items (91 Days)
          </button>
        </div>
      </div>
    `;

  } catch (error) {
    console.error('Failed to load customer loyalty:', error);
    container.innerHTML = '<div class="empty-state">Failed to load customer data. Please try again.</div>';
  }
}

async function viewCustomerHistory(element, event, customerId) {
  try {
    const response = await fetch(`/api/loyalty/customer/${customerId}/history`);
    const data = await response.json();

    let historyHtml = '<h4 style="margin-bottom: 15px;">Purchase History</h4>';

    if (data.purchases.length === 0) {
      historyHtml += '<p style="color: #6b7280;">No purchase history.</p>';
    } else {
      historyHtml += '<table style="font-size: 12px;"><thead><tr><th>Date</th><th>Offer</th><th>Qty</th><th>Order ID</th></tr></thead><tbody>';
      historyHtml += data.purchases.map(p => `
        <tr${p.is_refund ? ' style="color: #dc2626;"' : ''}>
          <td>${formatDate(p.purchased_at)}</td>
          <td>${escapeHtml(p.offer_name)}</td>
          <td>${p.quantity}</td>
          <td style="font-family: monospace; font-size: 10px;">${p.square_order_id?.slice(0,8) || '-'}...</td>
        </tr>
      `).join('');
      historyHtml += '</tbody></table>';
    }

    const container = document.getElementById('customer-result-container');
    container.innerHTML += `
      <div class="customer-result" style="margin-top: 15px;">
        ${historyHtml}
      </div>
    `;

  } catch (error) {
    console.error('Failed to load history:', error);
    alert('Failed to load customer history');
  }
}

// Order Audit History for Missed Loyalty Items
let auditSelectedOrders = new Set();
let auditOrdersData = null;

async function viewOrderAuditHistory(customerId, customerName = 'Customer') {
  auditSelectedOrders.clear();
  auditOrdersData = null;

  document.getElementById('audit-customer-id').value = customerId;
  document.getElementById('audit-customer-info').innerHTML = `
    <strong>Customer:</strong> ${escapeHtml(customerName)}<br>
    <small style="color: #6b7280;">ID: ${customerId}</small>
  `;
  document.getElementById('audit-summary').innerHTML = '';
  document.getElementById('audit-orders-container').innerHTML = '<div class="loading"><div class="spinner"></div><br>Loading 91-day order history from Square...</div>';
  updateAuditButton();

  showModal('order-audit-modal');

  try {
    const response = await fetch(`/api/loyalty/customer/${customerId}/audit-history?days=91`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to fetch order history');
    }

    auditOrdersData = data;
    renderAuditOrders(data);

  } catch (error) {
    console.error('Failed to load audit history:', error);
    document.getElementById('audit-orders-container').innerHTML = `
      <div class="empty-state" style="color: #dc2626;">
        Failed to load order history: ${escapeHtml(error.message)}
      </div>
    `;
  }
}

function renderAuditOrders(data) {
  const container = document.getElementById('audit-orders-container');
  const summaryDiv = document.getElementById('audit-summary');

  // Calculate offer breakdown from all orders
  const offerBreakdown = {};
  let totalFreeSkipped = 0;

  for (const order of data.orders) {
    // Count qualifying items by offer
    for (const item of order.qualifyingItems) {
      const offerName = item.offer?.name || 'Unknown Offer';
      if (!offerBreakdown[offerName]) {
        offerBreakdown[offerName] = {
          earned: 0,
          canAdd: 0,
          freeSkipped: 0,
          offerId: item.offer?.id
        };
      }
      if (order.isAlreadyTracked) {
        offerBreakdown[offerName].earned += item.quantity;
      } else {
        offerBreakdown[offerName].canAdd += item.quantity;
      }
    }

    // Count free/skipped items
    for (const item of order.nonQualifyingItems || []) {
      if (item.skipReason === 'free_item') {
        totalFreeSkipped += item.quantity;
        // Try to match to an offer by checking if there's a matching variation
        const offerName = item.offer?.name || 'Free Items (No Credit)';
        if (!offerBreakdown[offerName]) {
          offerBreakdown[offerName] = { earned: 0, canAdd: 0, freeSkipped: 0 };
        }
        offerBreakdown[offerName].freeSkipped += item.quantity;
      }
    }
  }

  // Build reward status from currentRewards
  const rewardStatus = {};
  for (const reward of data.currentRewards || []) {
    const offerName = reward.offer_name;
    if (!rewardStatus[offerName]) {
      rewardStatus[offerName] = { inProgress: 0, earned: 0, redeemed: 0, required: reward.required_quantity };
    }
    if (reward.status === 'in_progress') {
      rewardStatus[offerName].inProgress = reward.current_quantity;
    } else if (reward.status === 'earned') {
      rewardStatus[offerName].earned++;
    } else if (reward.status === 'redeemed') {
      rewardStatus[offerName].redeemed++;
    }
  }

  // Build offer breakdown HTML
  let offerBreakdownHtml = '';
  const offerNames = Object.keys(offerBreakdown);
  if (offerNames.length > 0) {
    offerBreakdownHtml = `
      <div style="margin-top: 15px; background: #f8fafc; padding: 12px; border-radius: 8px;">
        <div style="font-weight: 600; margin-bottom: 10px; font-size: 13px;">📊 Offer Unit Breakdown (91 Days)</div>
        <table style="width: 100%; font-size: 12px; border-collapse: collapse;">
          <thead>
            <tr style="background: #e2e8f0;">
              <th style="padding: 6px; text-align: left;">Offer</th>
              <th style="padding: 6px; text-align: center; color: #10b981;">✓ Earned</th>
              <th style="padding: 6px; text-align: center; color: #f59e0b;">+ Can Add</th>
              <th style="padding: 6px; text-align: center; color: #ef4444;">🎁 Free (No Credit)</th>
              <th style="padding: 6px; text-align: center; color: #8b5cf6;">🎉 Rewards</th>
            </tr>
          </thead>
          <tbody>
            ${offerNames.map(name => {
              const b = offerBreakdown[name];
              const r = rewardStatus[name] || { inProgress: 0, earned: 0, redeemed: 0, required: '?' };
              const rewardText = [];
              if (r.inProgress > 0) rewardText.push(`${r.inProgress}/${r.required} in progress`);
              if (r.earned > 0) rewardText.push(`${r.earned} ready`);
              if (r.redeemed > 0) rewardText.push(`${r.redeemed} redeemed`);
              return `
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 6px; font-weight: 500;">${escapeHtml(name)}</td>
                  <td style="padding: 6px; text-align: center; color: #10b981; font-weight: 600;">${b.earned || '-'}</td>
                  <td style="padding: 6px; text-align: center; color: #f59e0b; font-weight: 600;">${b.canAdd || '-'}</td>
                  <td style="padding: 6px; text-align: center; color: #ef4444;">${b.freeSkipped || '-'}</td>
                  <td style="padding: 6px; text-align: center; font-size: 11px; color: #6b7280;">
                    ${rewardText.length > 0 ? rewardText.join(', ') : '-'}
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
        <div style="margin-top: 8px; font-size: 11px; color: #6b7280;">
          <strong>Legend:</strong>
          ✓ Earned = Already counted toward loyalty |
          + Can Add = Missed items you can add |
          🎁 Free = 100% discounted (no loyalty credit)
        </div>
      </div>
    `;
  }

  // Show summary
  summaryDiv.innerHTML = `
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 10px; text-align: center;">
      <div>
        <div style="font-size: 20px; font-weight: 700; color: #2563eb;">${data.summary.totalOrders}</div>
        <div style="font-size: 11px; color: #6b7280;">Total Orders</div>
      </div>
      <div>
        <div style="font-size: 20px; font-weight: 700; color: #10b981;">${data.summary.alreadyTracked}</div>
        <div style="font-size: 11px; color: #6b7280;">Already Tracked</div>
      </div>
      <div>
        <div style="font-size: 20px; font-weight: 700; color: #f59e0b;">${data.summary.canBeAdded}</div>
        <div style="font-size: 11px; color: #6b7280;">Can Be Added</div>
      </div>
      <div>
        <div style="font-size: 20px; font-weight: 700; color: #8b5cf6;">${data.summary.totalQualifyingQtyAvailable}</div>
        <div style="font-size: 11px; color: #6b7280;">Qualifying Items</div>
      </div>
      <div>
        <div style="font-size: 20px; font-weight: 700; color: #ef4444;">${totalFreeSkipped}</div>
        <div style="font-size: 11px; color: #6b7280;">Free (No Credit)</div>
      </div>
    </div>
    <div style="margin-top: 10px; font-size: 11px; color: #6b7280; text-align: center;">
      Period: ${formatDate(data.dateRange.start)} - ${formatDate(data.dateRange.end)}
    </div>
    ${offerBreakdownHtml}
  `;

  if (data.orders.length === 0) {
    container.innerHTML = '<div class="empty-state">No orders found in the last 91 days.</div>';
    return;
  }

  // Build orders table
  let html = `
    <div style="margin-bottom: 10px;">
      <label style="display: inline-flex; align-items: center; gap: 5px; cursor: pointer;">
        <input type="checkbox" id="audit-select-all" data-change="toggleAllAuditOrdersFromCheckbox">
        <span style="font-size: 13px;">Select all eligible orders</span>
      </label>
    </div>
    <table style="font-size: 12px; width: 100%;">
      <thead>
        <tr>
          <th style="width: 30px;"></th>
          <th>Date</th>
          <th>Qualifying Items</th>
          <th>Free/Skipped</th>
          <th>Qty</th>
          <th>Status</th>
          <th>Receipt</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const order of data.orders) {
    const isTracked = order.isAlreadyTracked;
    const canAdd = order.canBeAdded;
    const rowClass = isTracked ? 'style="background: #f0fdf4;"' : (canAdd ? '' : 'style="background: #fef2f2;"');

    // Build qualifying items list
    const qualifyingList = order.qualifyingItems.length > 0
      ? order.qualifyingItems.map(item =>
          `<span style="display: inline-block; background: #dbeafe; padding: 2px 6px; border-radius: 3px; margin: 1px;" title="${escapeHtml(item.offer?.name || '')}">${escapeHtml(item.name)} (${item.quantity})</span>`
        ).join(' ')
      : '<span style="color: #9ca3af;">None</span>';

    // Build free/skipped items list
    const freeItems = (order.nonQualifyingItems || []).filter(i => i.skipReason === 'free_item');
    const freeList = freeItems.length > 0
      ? freeItems.map(item =>
          `<span style="display: inline-block; background: #fee2e2; padding: 2px 6px; border-radius: 3px; margin: 1px;" title="100% discounted - no loyalty credit">🎁 ${escapeHtml(item.name)} (${item.quantity})</span>`
        ).join(' ')
      : '<span style="color: #9ca3af;">-</span>';

    // Check customer ID match
    const expectedCustomerId = document.getElementById('audit-customer-id').value;
    const orderCustId = order.orderCustomerId;
    const custIdMatch = !orderCustId ? 'none' : (orderCustId === expectedCustomerId ? 'match' : 'mismatch');

    // Status badge
    let statusBadge = '';
    if (isTracked) {
      statusBadge = '<span class="status-badge earned" style="font-size: 10px;">✓ Tracked</span>';
    } else if (canAdd) {
      statusBadge = '<span class="status-badge in_progress" style="font-size: 10px;">+ Can Add</span>';
    } else if (freeItems.length > 0) {
      statusBadge = '<span class="status-badge" style="font-size: 10px; background: #fee2e2; color: #dc2626;">🎁 Free Only</span>';
    } else {
      statusBadge = '<span class="status-badge inactive" style="font-size: 10px;">No Items</span>';
    }

    // Customer ID indicator - show how we linked to the customer
    let custIdBadge = '';
    if (isTracked) {
      // Show how we connected this order to the customer
      const sourceLabels = {
        'order': { icon: '✓', text: 'Direct', title: 'Customer ID was on the order' },
        'tender': { icon: '💳', text: 'Payment', title: 'Found via payment tender' },
        'loyalty_api': { icon: '🔗', text: 'Loyalty', title: 'Linked via Square Loyalty API' },
        'manual': { icon: '✏️', text: 'Manual', title: 'Manually added by admin' }
      };
      // Default to 'order' for legacy records without customer_source
      const source = sourceLabels[order.customerSource] || sourceLabels['order'];
      custIdBadge = `<span style="font-size: 9px; color: #059669;" title="${source.title}">${source.icon} ${source.text}</span>`;
    } else if (custIdMatch === 'none') {
      custIdBadge = '<span style="font-size: 9px; color: #f59e0b;" title="Order has no customer_id - will be linked via Loyalty API if added">⚠️ No CustID</span>';
    } else if (custIdMatch === 'mismatch') {
      custIdBadge = `<span style="font-size: 9px; color: #dc2626;" title="Order customer: ${orderCustId}">❌ Wrong CustID</span>`;
    }

    html += `
      <tr ${rowClass}>
        <td>
          ${canAdd ? `
            <input type="checkbox"
                   class="audit-order-checkbox"
                   data-order-id="${order.orderId}"
                   ${auditSelectedOrders.has(order.orderId) ? 'checked' : ''}
                   data-change="toggleAuditOrderFromCheckbox">
          ` : ''}
        </td>
        <td>${formatDate(order.closedAt)}<br>
            <small style="color: #6b7280;">${new Date(order.closedAt).toLocaleTimeString()}</small>
            ${custIdBadge ? `<br>${custIdBadge}` : ''}</td>
        <td style="max-width: 250px;">${qualifyingList}</td>
        <td style="max-width: 150px;">${freeList}</td>
        <td style="text-align: center; font-weight: 600;">${order.totalQualifyingQty}</td>
        <td>${statusBadge}</td>
        <td>
          ${order.receiptUrl
            ? `<a href="${order.receiptUrl}" target="_blank" style="color: #2563eb; text-decoration: none;">View</a>`
            : '-'}
        </td>
      </tr>
    `;
  }

  html += '</tbody></table>';
  container.innerHTML = html;
}

function toggleAuditOrder(orderId, isChecked) {
  if (isChecked) {
    auditSelectedOrders.add(orderId);
  } else {
    auditSelectedOrders.delete(orderId);
  }
  updateAuditButton();
}

function toggleAllAuditOrders(selectAll) {
  if (!auditOrdersData) return;

  auditSelectedOrders.clear();
  if (selectAll) {
    for (const order of auditOrdersData.orders) {
      if (order.canBeAdded) {
        auditSelectedOrders.add(order.orderId);
      }
    }
  }

  // Update all checkboxes
  document.querySelectorAll('.audit-order-checkbox').forEach(cb => {
    cb.checked = selectAll;
  });

  updateAuditButton();
}

function updateAuditButton() {
  const btn = document.getElementById('audit-add-selected-btn');
  const count = auditSelectedOrders.size;
  btn.disabled = count === 0;
  btn.textContent = `Add Selected Orders (${count})`;
}

async function addSelectedOrdersToLoyalty() {
  if (auditSelectedOrders.size === 0) {
    alert('Please select at least one order to add.');
    return;
  }

  const customerId = document.getElementById('audit-customer-id').value;
  const orderIds = Array.from(auditSelectedOrders);

  const btn = document.getElementById('audit-add-selected-btn');
  btn.disabled = true;
  btn.textContent = 'Adding orders...';

  try {
    const response = await fetch(`/api/loyalty/customer/${customerId}/add-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderIds })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to add orders');
    }

    // Show results
    let message = `Successfully processed ${result.processed.length} orders.`;
    if (result.skipped.length > 0) {
      message += `\n${result.skipped.length} orders were already tracked.`;
    }
    if (result.errors.length > 0) {
      message += `\n\n${result.errors.length} orders had errors:`;
      for (const err of result.errors) {
        const shortId = err.orderId ? err.orderId.slice(0,8) + '...' : 'unknown';
        message += `\n• ${shortId}: ${err.error}`;
      }
    }

    alert(message);

    // Close modal and refresh customer view
    closeModal('order-audit-modal');
    showCustomerLoyalty(customerId);

  } catch (error) {
    console.error('Failed to add orders:', error);
    alert('Failed to add orders: ' + error.message);
    btn.disabled = false;
    btn.textContent = `Add Selected Orders (${auditSelectedOrders.size})`;
  }
}

// Rewards
async function loadRewards() {
  const tbody = document.getElementById('rewards-table-body');
  tbody.innerHTML = '<tr><td colspan="7" class="loading"><div class="spinner"></div><br>Loading...</td></tr>';

  try {
    const status = document.getElementById('reward-filter-status').value;
    const offerId = document.getElementById('reward-filter-offer').value;

    let url = '/api/loyalty/rewards?limit=100';
    if (status) url += `&status=${status}`;
    if (offerId) url += `&offerId=${offerId}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.rewards.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No rewards found.</td></tr>';
      return;
    }

    tbody.innerHTML = data.rewards.map(reward => {
      const progress = reward.current_quantity / reward.required_quantity;
      const progressPct = Math.min(progress * 100, 100);
      const phoneDisplay = reward.customer_phone || 'No phone';

      return `
        <tr>
          <td style="font-size: 13px;">${escapeHtml(phoneDisplay)}</td>
          <td>${escapeHtml(reward.offer_name)}<br><small style="color: #6b7280;">${escapeHtml(reward.brand_name)} - ${escapeHtml(reward.size_group)}</small></td>
          <td>
            <div style="display: flex; align-items: center; gap: 10px;">
              <div class="progress-container" style="width: 80px;">
                <div class="progress-bar ${progressPct >= 100 ? 'complete' : ''}" style="width: ${progressPct}%"></div>
              </div>
              <span>${reward.current_quantity}/${reward.required_quantity}</span>
            </div>
          </td>
          <td>${formatDate(reward.window_start_date)} - ${formatDate(reward.window_end_date)}</td>
          <td><span class="status-badge ${reward.status}">${reward.status}</span></td>
          <td>${formatDate(reward.earned_at)}</td>
          <td>
            ${reward.status === 'earned' ? `
              <button class="action-btn redeem" data-action="showRedeemModalFromButton" data-reward-id="${escapeJsString(reward.id)}" data-offer-name="${escapeJsString(reward.offer_name)}" data-customer-id="${escapeJsString(reward.square_customer_id)}">Redeem</button>
            ` : '-'}
          </td>
        </tr>
      `;
    }).join('');

  } catch (error) {
    console.error('Failed to load rewards:', error);
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Failed to load rewards.</td></tr>';
  }
}

function showRedeemModal(rewardId, offerName, customerId) {
  document.getElementById('redeem-reward-id').value = rewardId;
  document.getElementById('redeem-reward-details').innerHTML = `
    <div class="alert alert-info">
      <strong>Offer:</strong> ${escapeHtml(offerName)}<br>
      <strong>Customer:</strong> ${escapeHtml(customerId)}
    </div>
  `;
  document.getElementById('redeem-order-id').value = '';
  document.getElementById('redeem-value').value = '';
  document.getElementById('redeem-notes').value = '';
  showModal('redeem-modal');
}

async function submitRedemption() {
  const rewardId = document.getElementById('redeem-reward-id').value;
  const data = {
    squareOrderId: document.getElementById('redeem-order-id').value || null,
    redeemedValueCents: document.getElementById('redeem-value').value || null,
    adminNotes: document.getElementById('redeem-notes').value || null,
    redemptionType: 'manual_admin'
  };

  try {
    const response = await fetch(`/api/loyalty/rewards/${rewardId}/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to redeem reward');
    }

    closeModal('redeem-modal');
    loadRewards();
    loadStats();
    alert('Reward redeemed successfully!');

  } catch (error) {
    console.error('Failed to redeem:', error);
    alert('Error: ' + error.message);
  }
}

// Redemptions
async function loadRedemptions() {
  const tbody = document.getElementById('redemptions-table-body');
  tbody.innerHTML = '<tr><td colspan="7" class="loading"><div class="spinner"></div><br>Loading...</td></tr>';

  try {
    const startDate = document.getElementById('redemption-start-date').value;
    const endDate = document.getElementById('redemption-end-date').value;
    const offerId = document.getElementById('redemption-filter-offer').value;

    let url = '/api/loyalty/redemptions?limit=100';
    if (startDate) url += `&startDate=${startDate}`;
    if (endDate) url += `&endDate=${endDate}`;
    if (offerId) url += `&offerId=${offerId}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.redemptions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No redemptions found.</td></tr>';
      return;
    }

    tbody.innerHTML = data.redemptions.map(r => {
      const phoneDisplay = r.customer_phone || 'No phone';
      return `
      <tr>
        <td>${new Date(r.redeemed_at).toLocaleString()}</td>
        <td style="font-size: 13px;">${escapeHtml(phoneDisplay)}</td>
        <td>${escapeHtml(r.offer_name)}<br><small style="color: #6b7280;">${escapeHtml(r.brand_name)} - ${escapeHtml(r.size_group)}</small></td>
        <td>${r.redeemed_item_name ? escapeHtml(r.redeemed_item_name) : '-'}</td>
        <td>${r.redeemed_value_cents ? '$' + (r.redeemed_value_cents / 100).toFixed(2) : '-'}</td>
        <td><span class="status-badge ${r.redemption_type}">${r.redemption_type.replace(/_/g, ' ')}</span></td>
        <td>
          <button class="action-btn view" data-action="viewVendorReceipt" data-action-param="${escapeJsString(r.id)}">Receipt</button>
        </td>
      </tr>
    `}).join('');

  } catch (error) {
    console.error('Failed to load redemptions:', error);
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Failed to load redemptions.</td></tr>';
  }
}

function viewVendorReceipt(element, event, rewardId) {
  window.open(`/api/loyalty/reports/vendor-receipt/${rewardId}?format=html`, '_blank');
}

// Reports
function downloadReport(element, event, type) {
  let url = '/api/loyalty/reports/';

  switch (type) {
    case 'redemptions':
      url += 'redemptions/csv';
      const rStart = document.getElementById('report-redemption-start').value;
      const rEnd = document.getElementById('report-redemption-end').value;
      if (rStart) url += `?startDate=${rStart}`;
      if (rEnd) url += (rStart ? '&' : '?') + `endDate=${rEnd}`;
      break;
    case 'audit':
      url += 'audit/csv';
      const aStart = document.getElementById('report-audit-start').value;
      const aEnd = document.getElementById('report-audit-end').value;
      if (aStart) url += `?startDate=${aStart}`;
      if (aEnd) url += (aStart ? '&' : '?') + `endDate=${aEnd}`;
      break;
    case 'summary':
      url += 'summary/csv';
      break;
    case 'customers':
      url += 'customers/csv';
      break;
  }

  window.location.href = url;
}

// Settings
let squareRewardTiers = [];

async function loadSettings() {
  try {
    const response = await fetch('/api/loyalty/settings');
    const data = await response.json();

    document.getElementById('setting-loyalty_enabled').checked = data.settings.loyalty_enabled !== 'false';
    document.getElementById('setting-auto_detect_redemptions').checked = data.settings.auto_detect_redemptions === 'true';
    document.getElementById('setting-send_receipt_messages').checked = data.settings.send_receipt_messages === 'true';

    // Note: Square POS integration is now automatic via Customer Group Discounts
    // No configuration needed - rewards auto-apply at POS when customer is identified

    // Check for pending rewards that need to be synced to POS
    loadPendingSyncCount();
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

// Check for earned rewards sync status (pending and synced counts)
async function loadPendingSyncCount() {
  try {
    const response = await fetch('/api/loyalty/rewards/pending-sync');
    const data = await response.json();

    const pendingSection = document.getElementById('sync-pending-section');
    const pendingCountEl = document.getElementById('pending-count');
    const resyncSection = document.getElementById('resync-section');
    const syncedCountEl = document.getElementById('synced-count');

    // Show pending section if there are unsynced rewards
    if (data.pendingCount > 0) {
      pendingCountEl.textContent = data.pendingCount;
      pendingSection.style.display = 'block';
    } else {
      pendingSection.style.display = 'none';
    }

    // Show re-sync section if there are synced rewards
    if (data.syncedCount > 0) {
      syncedCountEl.textContent = data.syncedCount;
      resyncSection.style.display = 'block';
    } else {
      resyncSection.style.display = 'none';
    }
  } catch (error) {
    console.error('Failed to check pending sync:', error);
  }
}

// Sync earned rewards to Square POS
// force=true will re-sync all, force=false will only sync pending
async function syncRewardsToPOS(force = false) {
  const btn = force ? document.getElementById('resync-btn') : document.getElementById('sync-btn');
  const originalText = btn.textContent;

  const confirmMsg = force
    ? 'Re-sync all earned rewards? This will delete and recreate all discounts in Square.'
    : 'Sync pending rewards to Square POS?';

  if (!confirm(confirmMsg)) return;

  try {
    btn.disabled = true;
    btn.textContent = force ? 'Re-syncing...' : 'Syncing...';

    const response = await fetch('/api/loyalty/rewards/sync-to-pos' + (force ? '?force=true' : ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    const data = await response.json();

    if (data.success) {
      alert(`Synced ${data.synced} of ${data.total} rewards to Square POS!`);
      loadPendingSyncCount();  // Refresh the counts
    } else {
      throw new Error(data.error || 'Sync failed');
    }
  } catch (error) {
    console.error('Failed to sync rewards:', error);
    alert('Error syncing rewards: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function saveSettings() {
  const updates = {
    loyalty_enabled: document.getElementById('setting-loyalty_enabled').checked ? 'true' : 'false',
    auto_detect_redemptions: document.getElementById('setting-auto_detect_redemptions').checked ? 'true' : 'false',
    send_receipt_messages: document.getElementById('setting-send_receipt_messages').checked ? 'true' : 'false'
  };

  try {
    const response = await fetch('/api/loyalty/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });

    if (response.ok) {
      alert('Settings saved successfully!');
    } else {
      throw new Error('Failed to save');
    }
  } catch (error) {
    console.error('Failed to save settings:', error);
    alert('Failed to save settings.');
  }
}

async function processExpired() {
  if (!confirm('Process expired window entries?\n\nThis will remove purchases that have fallen outside the rolling time window and revoke any expired earned rewards.')) {
    return;
  }

  try {
    const response = await fetch('/api/loyalty/process-expired', { method: 'POST' });
    const result = await response.json();

    let message = `Window Entries: Processed ${result.windowEntries?.processedCount || 0} expired entries.`;

    if (result.expiredEarnedRewards) {
      const earned = result.expiredEarnedRewards;
      if (earned.processedCount > 0) {
        message += `\n\nExpired Earned Rewards: Revoked ${earned.processedCount} reward(s) and cleaned up discounts.`;
        if (earned.revokedRewards?.length > 0) {
          message += '\n\nRevoked Rewards:';
          earned.revokedRewards.forEach(r => {
            message += `\n• ${r.offerName}`;
          });
        }
      } else {
        message += '\n\nNo expired earned rewards found.';
      }
    }

    alert(message);
  } catch (error) {
    console.error('Failed to process expired:', error);
    alert('Failed to process expired entries.');
  }
}

async function validateDiscounts(fixIssues = false) {
  const validateBtn = document.getElementById('validate-btn');
  const fixBtn = document.getElementById('validate-fix-btn');
  const resultsDiv = document.getElementById('discount-validation-results');

  validateBtn.disabled = true;
  fixBtn.disabled = true;
  resultsDiv.style.display = 'block';
  resultsDiv.innerHTML = '<div class="loading"><div class="spinner"></div><br>Validating discounts against Square...</div>';

  try {
    const endpoint = fixIssues ? '/api/loyalty/discounts/validate-and-fix' : '/api/loyalty/discounts/validate';
    const response = await fetch(endpoint, { method: fixIssues ? 'POST' : 'GET' });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Validation failed');
    }

    // Build results HTML
    let html = '';

    // Summary stats
    html += `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 10px; margin-bottom: 15px; text-align: center;">
        <div style="padding: 10px; background: #f0fdf4; border-radius: 5px;">
          <div style="font-size: 24px; font-weight: 700; color: #10b981;">${result.validated}</div>
          <div style="font-size: 11px; color: #6b7280;">Valid</div>
        </div>
        <div style="padding: 10px; background: ${result.issues.length > 0 ? '#fef2f2' : '#f3f4f6'}; border-radius: 5px;">
          <div style="font-size: 24px; font-weight: 700; color: ${result.issues.length > 0 ? '#ef4444' : '#6b7280'};">${result.issues.length}</div>
          <div style="font-size: 11px; color: #6b7280;">Issues</div>
        </div>
        ${fixIssues ? `
        <div style="padding: 10px; background: ${result.fixed.length > 0 ? '#dbeafe' : '#f3f4f6'}; border-radius: 5px;">
          <div style="font-size: 24px; font-weight: 700; color: #2563eb;">${result.fixed.length}</div>
          <div style="font-size: 11px; color: #6b7280;">Fixed</div>
        </div>
        ` : ''}
        <div style="padding: 10px; background: #f3f4f6; border-radius: 5px;">
          <div style="font-size: 24px; font-weight: 700; color: #374151;">${result.totalEarned}</div>
          <div style="font-size: 11px; color: #6b7280;">Total Earned</div>
        </div>
      </div>
    `;

    // Show issues if any
    if (result.issues.length > 0) {
      html += `<div class="alert ${fixIssues && result.fixed.length > 0 ? 'alert-success' : 'alert-warning'}" style="margin-bottom: 10px;">`;

      if (fixIssues && result.fixed.length > 0) {
        html += `<strong>Fixed ${result.fixed.length} issue(s)!</strong><br>`;
      }

      if (result.issues.length > result.fixed.length) {
        html += `<strong>${result.issues.length - result.fixed.length} issue(s) ${fixIssues ? 'could not be fixed' : 'found'}:</strong><br>`;
      }

      html += '<ul style="margin: 10px 0 0 20px; padding: 0;">';
      result.issues.forEach(issue => {
        const wasFixed = fixIssues && result.fixed.some(f => f.rewardId === issue.rewardId);
        const fixError = issue.details?.fixError;
        html += `
          <li style="margin-bottom: 8px; ${wasFixed ? 'text-decoration: line-through; color: #6b7280;' : ''}">
            <strong>${escapeHtml(issue.offerName)}</strong>
            <span style="color: #6b7280; font-size: 12px;"> - ${escapeHtml(issue.issue.replace(/_/g, ' '))}</span>
            ${wasFixed ? '<span style="color: #10b981; font-size: 12px;"> (Fixed)</span>' : ''}
            ${fixError ? `<br><small style="color: #dc2626;">Fix failed: ${escapeHtml(fixError)}</small>` : ''}
            <br><small style="color: #9ca3af;">Customer: ${issue.squareCustomerId?.slice(0, 12)}... | Earned: ${formatDate(issue.earnedAt)}</small>
          </li>
        `;
      });
      html += '</ul></div>';
    } else {
      html += '<div class="alert alert-success"><strong>All discounts validated successfully!</strong><br>All earned rewards have properly configured Square discounts.</div>';
    }

    resultsDiv.innerHTML = html;

  } catch (error) {
    console.error('Failed to validate discounts:', error);
    resultsDiv.innerHTML = `<div class="alert alert-danger">Failed to validate discounts: ${escapeHtml(error.message)}</div>`;
  } finally {
    validateBtn.disabled = false;
    fixBtn.disabled = false;
  }
}

// Modal helpers
function showModal(id) {
  document.getElementById(id).classList.add('show');
}

function closeModal(elementOrId, event, modalId) {
  // Handle both direct calls and event delegation
  // Event delegation passes (element, event, param), direct calls pass (id)
  let id;
  if (elementOrId instanceof HTMLElement) {
    id = modalId;
  } else {
    id = elementOrId;
  }
  document.getElementById(id).classList.remove('show');
}

// Escape HTML
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Escape strings for use in JavaScript onclick handlers (single-quoted)
function escapeJsString(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

// Format date consistently as MM/DD/YYYY (US format)
function formatDate(dateStr) {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString('en-US');
}

// Expose functions to global scope for event delegation
window.switchTabFromClick = switchTabFromClick;
window.showCreateOfferModal = showCreateOfferModal;
window.searchCustomer = searchCustomer;
window.downloadReport = downloadReport;
window.saveSettings = saveSettings;
window.syncRewardsToPOS = syncRewardsToPOS;
window.processExpired = processExpired;
window.validateDiscounts = validateDiscounts;
window.closeModal = closeModal;
window.saveOffer = saveOffer;
window.showVariationsModal = showVariationsModal;
window.editOffer = editOffer;
window.deleteOfferFromButton = deleteOfferFromButton;
window.toggleVariationCard = toggleVariationCard;
window.toggleVariationCardStop = toggleVariationCardStop;
window.saveVariations = saveVariations;
window.showCustomerLoyalty = showCustomerLoyalty;
window.viewOrderAuditHistoryFromButton = viewOrderAuditHistoryFromButton;
window.showRedeemModalFromButton = showRedeemModalFromButton;
window.viewCustomerHistory = viewCustomerHistory;
window.submitRedemption = submitRedemption;
window.addSelectedOrdersToLoyalty = addSelectedOrdersToLoyalty;
window.viewVendorReceipt = viewVendorReceipt;
window.loadOffers = loadOffers;
window.loadRewards = loadRewards;
window.loadRedemptions = loadRedemptions;
window.toggleAllAuditOrdersFromCheckbox = toggleAllAuditOrdersFromCheckbox;
window.toggleAuditOrderFromCheckbox = toggleAuditOrderFromCheckbox;
window.searchVariations = searchVariations;
window.handleCustomerSearchKeyup = handleCustomerSearchKeyup;
