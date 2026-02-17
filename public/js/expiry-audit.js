/**
 * Expiry Audit page JavaScript
 * Externalized from expiry-audit.html for CSP compliance (P0-4 Phase 2)
 */

let allItems = [];
let currentFilter = 'all';
let sessionConfirmed = {};  // { variation_id: tier_code } - items confirmed THIS session (avoids flicker)

// Modal state
let currentItem = null;

// Tier configuration - loaded dynamically from database
let tierRanges = {};
let tierNames = {};  // tier_code -> display name mapping

// Get today's date at midnight for comparison
function getTodayStart() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

// Check if a timestamp is from today
function isFromToday(timestamp) {
  if (!timestamp) return false;
  const reviewDate = new Date(timestamp);
  const todayStart = getTodayStart();
  return reviewDate >= todayStart;
}

// Tier-specific configurations (names will be updated from settings)
const tierConfig = {
  EXPIRED: {
    title: 'Pull from Shelf - EXPIRED',
    displayLabel: 'Status',
    displayClass: 'discount-50',
    buttonText: 'Pulled from Shelf',
    successMessage: 'Item confirmed pulled from shelf!',
    verification: [
      'Remove ALL units of this product from shelf',
      'Check for damaged or opened packaging',
      'Move to disposal or return area',
      'Update inventory count if needed'
    ],
    getDisplayValue: (item) => 'EXPIRED - PULL NOW',
    showUpdateButton: false
  },
  REVIEW: {
    title: 'Confirm Expiry Date',
    displayLabel: 'Expiry Date in System',
    displayClass: 'review',
    buttonText: 'Date is Correct',
    successMessage: 'Expiry date confirmed!',
    verification: [
      'Check the physical product\'s expiry date',
      'Confirm it matches the date shown above',
      'If different, click "Update Date" instead'
    ],
    getDisplayValue: (item) => item.expiration_date ? item.expiration_date.split('T')[0] : 'Not set',
    showUpdateButton: true
  },
  AUTO25: {
    title: 'Confirm Discount Applied',
    displayLabel: 'Required Discount',
    displayClass: 'discount',
    buttonText: 'Sticker Applied',
    successMessage: 'Discount sticker confirmed!',
    verification: [
      'Check product has discount sticker visible',
      'Verify discounted price is shown correctly',
      'If expiry date is WRONG, click "Correct Date" first!'
    ],
    getDisplayValue: (item) => `${item.discount_percent || 25}% OFF`,
    showUpdateButton: true,
    updateButtonText: 'Correct Date'
  },
  AUTO50: {
    title: 'Confirm Discount Applied',
    displayLabel: 'Required Discount',
    displayClass: 'discount-50',
    buttonText: 'Sticker Applied',
    successMessage: 'Discount sticker confirmed!',
    verification: [
      'Check product has discount sticker visible',
      'Verify discounted price is shown correctly',
      'If expiry date is WRONG, click "Correct Date" first!'
    ],
    getDisplayValue: (item) => `${item.discount_percent || 50}% OFF`,
    showUpdateButton: true,
    updateButtonText: 'Correct Date'
  },
  NO_EXPIRY: {
    title: 'Set Expiration Status',
    displayLabel: 'Current Status',
    displayClass: 'review',
    buttonText: 'Does Not Expire',
    successMessage: 'Marked as does not expire!',
    verification: [
      'Check if product has an expiry date printed',
      'If yes, click "Set Date" to enter it',
      'If no expiry date exists, confirm below'
    ],
    getDisplayValue: (item) => 'No expiry date set',
    showUpdateButton: true,
    updateButtonText: 'Set Date'
  }
};

// Load tier configuration from database (ensures manual tier changes are respected)
async function loadTierConfig() {
  try {
    const response = await fetch('/api/expiry-discounts/tiers');
    const data = await response.json();

    // Build tierRanges and tierNames from database config
    tierRanges = {};
    tierNames = {};
    for (const tier of data.tiers || data) {
      tierRanges[tier.tier_code] = {
        min: tier.min_days_to_expiry,
        max: tier.max_days_to_expiry
      };
      // Use tier_name if set, otherwise use tier_code
      tierNames[tier.tier_code] = tier.tier_name || tier.tier_code;
    }
    console.log('Loaded tier config from database:', tierRanges, tierNames);

    // Update filter tab labels with dynamic names
    updateFilterTabLabels();
  } catch (error) {
    console.error('Failed to load tier config, using defaults:', error);
    // Fallback to defaults only if API fails
    tierRanges = {
      'EXPIRED': { min: null, max: 0 },
      'AUTO50': { min: 1, max: 30 },
      'AUTO25': { min: 31, max: 89 },
      'REVIEW': { min: 90, max: 120 },
      'OK': { min: 121, max: null }
    };
    tierNames = {
      'EXPIRED': 'Pull from Shelf',
      'AUTO50': '50% Off',
      'AUTO25': '25% Off',
      'REVIEW': 'Review',
      'OK': 'OK'
    };
  }
}

// Update filter tab labels with names from settings
function updateFilterTabLabels() {
  const labelMappings = {
    'EXPIRED': 'label-EXPIRED',
    'AUTO50': 'label-AUTO50',
    'AUTO25': 'label-AUTO25',
    'REVIEW': 'label-REVIEW'
  };

  for (const [tierCode, labelId] of Object.entries(labelMappings)) {
    const labelEl = document.getElementById(labelId);
    if (labelEl && tierNames[tierCode]) {
      labelEl.textContent = tierNames[tierCode];
    }
  }
}

// Get tier code from days until expiry
function getTierFromDays(daysUntilExpiry) {
  if (daysUntilExpiry === null || daysUntilExpiry === undefined) return null;
  for (const [tierCode, range] of Object.entries(tierRanges)) {
    const minOk = range.min === null || daysUntilExpiry >= range.min;
    const maxOk = range.max === null || daysUntilExpiry <= range.max;
    if (minOk && maxOk) {
      return tierCode;
    }
  }
  return null;
}

// Check if item is confirmed - uses server's reviewed_at field
// Item is confirmed if it was reviewed while in the SAME tier
function isConfirmed(variationId, tierCode) {
  // First check if confirmed this session (for immediate feedback)
  if (sessionConfirmed[variationId] === tierCode) {
    return true;
  }

  // Check server-side reviewed_at from the item data
  const item = allItems.find(i => i.variation_id === variationId);
  if (!item || !item.reviewed_at) {
    return false;
  }

  // NO_EXPIRY items are NEVER confirmed - they must get a date or "does not expire" flag
  // They should always be visible until the issue is resolved
  if (tierCode === 'NO_EXPIRY') {
    return false;
  }

  // For items with expiration, check if reviewed in same tier
  if (item.days_until_expiry !== null && item.days_until_expiry !== undefined) {
    // Calculate days until expiry at the time of review
    // Current days + days elapsed since review = days at review time
    const reviewDate = new Date(item.reviewed_at);
    const now = new Date();
    const daysSinceReview = Math.floor((now - reviewDate) / (1000 * 60 * 60 * 24));
    const daysAtReview = item.days_until_expiry + daysSinceReview;

    // Get tier at review time
    const tierAtReview = getTierFromDays(daysAtReview);

    // If reviewed in the same tier, it's confirmed
    if (tierAtReview === tierCode) {
      return true;
    }
  }

  return false;
}

// Get count of items confirmed today (from server data)
function getConfirmedTodayCount() {
  return allItems.filter(item => item.reviewed_at && isFromToday(item.reviewed_at)).length;
}

// Load items on page load
async function loadItems() {
  const container = document.getElementById('items-container');
  container.innerHTML = '<div class="loading"><div class="loading-spinner"></div><p>Loading items to audit...</p></div>';

  try {
    // Load items from all tiers plus items with no expiry
    const [expired, auto50, auto25, review, noExpiry] = await Promise.all([
      fetch('/api/expiry-discounts/variations?tier_code=EXPIRED&limit=500').then(r => r.json()),
      fetch('/api/expiry-discounts/variations?tier_code=AUTO50&limit=500').then(r => r.json()),
      fetch('/api/expiry-discounts/variations?tier_code=AUTO25&limit=500').then(r => r.json()),
      fetch('/api/expiry-discounts/variations?tier_code=REVIEW&limit=500').then(r => r.json()),
      fetch('/api/expirations?expiry=no-expiry').then(r => r.json())
    ]);

    // Map no-expiry items to have tier_code
    // Note: API returns image_urls (plural) already resolved, so we just keep it from spread
    const noExpiryItems = (noExpiry.items || []).map(item => ({
      ...item,
      tier_code: 'NO_EXPIRY',
      variation_id: item.id || item.identifier,
      item_name: item.item_name || item.name,
      variation_name: item.variation_name || item.variation,
      current_stock: item.quantity || 0
      // image_urls comes from ...item spread (API returns it as array)
    }));

    const combinedItems = [
      ...(expired.variations || []),
      ...(auto50.variations || []),
      ...(auto25.variations || []),
      ...(review.variations || []),
      ...noExpiryItems
    ];

    // Deduplicate by variation_id - keep the most urgent (lowest days_until_expiry)
    const itemMap = new Map();
    for (const item of combinedItems) {
      const existing = itemMap.get(item.variation_id);
      if (!existing) {
        itemMap.set(item.variation_id, item);
      } else {
        // Keep the one with fewer days until expiry (more urgent)
        const existingDays = existing.days_until_expiry ?? 999;
        const newDays = item.days_until_expiry ?? 999;
        if (newDays < existingDays) {
          itemMap.set(item.variation_id, item);
        }
      }
    }
    allItems = Array.from(itemMap.values());

    // Filter out items with 0 stock
    allItems = allItems.filter(item => (item.current_stock || 0) > 0);

    // Sort: EXPIRED first, NO_EXPIRY items last, then by days until expiry (most urgent first)
    allItems.sort((a, b) => {
      // EXPIRED items always first (most urgent)
      if (a.tier_code === 'EXPIRED' && b.tier_code !== 'EXPIRED') return -1;
      if (a.tier_code !== 'EXPIRED' && b.tier_code === 'EXPIRED') return 1;
      // NO_EXPIRY items last
      if (a.tier_code === 'NO_EXPIRY' && b.tier_code !== 'NO_EXPIRY') return 1;
      if (a.tier_code !== 'NO_EXPIRY' && b.tier_code === 'NO_EXPIRY') return -1;
      // Then by days until expiry (most urgent first)
      return (a.days_until_expiry || 999) - (b.days_until_expiry || 999);
    });

    updateCounts();
    updateStats();
    renderItems();

  } catch (error) {
    console.error('Failed to load items:', error);
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">!</div>
        <h3>Error Loading Items</h3>
        <p>${escapeHtml(error.message)}</p>
      </div>
    `;
  }
}

function updateCounts() {
  const counts = { all: 0, EXPIRED: 0, REVIEW: 0, AUTO25: 0, AUTO50: 0, NO_EXPIRY: 0 };

  allItems.forEach(item => {
    if (!isConfirmed(item.variation_id, item.tier_code)) {
      counts.all++;
      if (counts[item.tier_code] !== undefined) {
        counts[item.tier_code]++;
      }
    }
  });

  document.getElementById('count-all').textContent = counts.all;
  document.getElementById('count-EXPIRED').textContent = counts.EXPIRED;
  document.getElementById('count-REVIEW').textContent = counts.REVIEW;
  document.getElementById('count-AUTO25').textContent = counts.AUTO25;
  document.getElementById('count-AUTO50').textContent = counts.AUTO50;
  document.getElementById('count-NO_EXPIRY').textContent = counts.NO_EXPIRY;
}

function updateStats() {
  const filteredItems = getFilteredItems();
  const pending = filteredItems.filter(item => !isConfirmed(item.variation_id, item.tier_code)).length;
  const confirmedInTier = filteredItems.length - pending;
  const total = filteredItems.length;
  const completion = total > 0 ? Math.round((confirmedInTier / total) * 100) : 0;

  document.getElementById('pending-count').textContent = pending;
  document.getElementById('confirmed-today').textContent = confirmedInTier;
  document.getElementById('completion-rate').textContent = `${completion}%`;
}

function getFilteredItems() {
  if (currentFilter === 'all') {
    return allItems;
  }
  return allItems.filter(item => item.tier_code === currentFilter);
}

// Navigation helper for CSP compliant redirects
function navigateTo(elementOrPath, event, param) {
  const path = param || elementOrPath;
  window.location.href = path;
}

function filterByTier(elementOrTier, event, param) {
  // Support both: filterByTier('tier') and filterByTier(element, event, param)
  const tier = param || elementOrTier;
  currentFilter = tier;

  // Update active tab
  document.querySelectorAll('.filter-tab').forEach(tab => tab.classList.remove('active'));
  document.querySelector(`.filter-tab.tab-${tier}`).classList.add('active');

  updateStats();
  renderItems();
}

function renderItems() {
  const container = document.getElementById('items-container');
  const items = getFilteredItems();

  if (items.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">All Done</div>
        <h3>No Items to Audit</h3>
        <p>All items in this category have been audited or there are no items needing attention.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = items.map((item) => {
    const confirmed = isConfirmed(item.variation_id, item.tier_code);
    const config = tierConfig[item.tier_code];
    const expiryDate = item.expiration_date ? item.expiration_date.split('T')[0] : 'Not set';
    const originalPrice = item.original_price_cents || item.current_price_cents || 0;
    const discountedPrice = item.discounted_price_cents || originalPrice;
    const discountPercent = item.discount_percent || 0;

    let tierIndicator = '';
    let priceDisplay = '';

    // Get dynamic tier name or use default
    const tierDisplayName = tierNames[item.tier_code] || item.tier_code;

    if (item.tier_code === 'EXPIRED') {
      tierIndicator = `
        <div class="tier-indicator tier-EXPIRED">
          EXPIRED - PULL FROM SHELF IMMEDIATELY
        </div>
      `;
    } else if (item.tier_code === 'REVIEW') {
      tierIndicator = `
        <div class="tier-indicator tier-REVIEW">
          ${item.days_until_expiry}d to expiry - verify date
        </div>
      `;
    } else if (item.tier_code === 'NO_EXPIRY') {
      tierIndicator = `
        <div class="tier-indicator tier-NO_EXPIRY">
          No expiry date - needs review
        </div>
      `;
    } else {
      const discountClass = item.tier_code === 'AUTO50' ? 'discount-50' : 'discount-25';
      tierIndicator = `
        <div class="tier-indicator tier-${item.tier_code}">
          ${item.days_until_expiry}d left - verify ${discountPercent}% sticker
        </div>
      `;
      priceDisplay = `
        <div class="price-display ${discountClass}">
          <span class="original-price">$${(originalPrice / 100).toFixed(2)}</span>
          <span class="discounted-price ${discountClass}">$${(discountedPrice / 100).toFixed(2)}</span>
          <span class="discount-badge ${discountClass}">${discountPercent}% OFF</span>
        </div>
      `;
    }

    const updateButtonText = config.updateButtonText || 'Update Date';
    const updateButton = config.showUpdateButton && !confirmed ? `
      <button class="action-btn update-btn"
              data-action="showUpdateModal" data-action-param="${escapeHtml(item.variation_id)}">
        ${updateButtonText}
      </button>
    ` : '';

    return `
      <div class="item-card tier-${item.tier_code} ${confirmed ? 'confirmed' : ''}" id="item-${item.variation_id}">
        <div class="item-header">
          <div class="item-image-container">
            ${item.image_urls && item.image_urls[0]
              ? `<img src="${item.image_urls[0]}" class="item-image" data-fallback="true"><div class="no-image" style="display:none;">Box</div>`
              : '<div class="no-image">Box</div>'}
          </div>
          <div class="item-info">
            <div class="item-name">${escapeHtml(item.item_name)}</div>
            ${item.variation_name ? `<div class="item-variation">${escapeHtml(item.variation_name)}</div>` : ''}

            <div class="item-details">
              <div class="detail-item">
                <span class="detail-label">SKU</span>
                <span class="detail-value">${escapeHtml(item.sku || 'N/A')}</span>
              </div>
              <div class="detail-item ${item.tier_code === 'EXPIRED' ? 'discount-critical' : (item.tier_code === 'REVIEW' ? 'highlight' : (item.tier_code === 'NO_EXPIRY' ? '' : (item.tier_code === 'AUTO50' ? 'discount-critical' : 'discount-highlight')))}">
                <span class="detail-label">${item.tier_code === 'EXPIRED' ? 'Status' : (item.tier_code === 'REVIEW' ? 'Expiry Date' : (item.tier_code === 'NO_EXPIRY' ? 'Status' : 'Discount'))}</span>
                <span class="detail-value">${item.tier_code === 'EXPIRED' ? 'EXPIRED' : (item.tier_code === 'REVIEW' ? expiryDate : (item.tier_code === 'NO_EXPIRY' ? 'Not Set' : discountPercent + '% OFF'))}</span>
              </div>
              ${(item.tier_code === 'AUTO25' || item.tier_code === 'AUTO50') ? `
              <div class="detail-item">
                <span class="detail-label">Expiry Date</span>
                <span class="detail-value">${expiryDate}</span>
              </div>
              ` : ''}
            </div>

            ${priceDisplay}
            ${tierIndicator}

            <div class="item-meta">
              ${item.category_name ? `<span class="badge badge-category">${escapeHtml(item.category_name)}</span>` : ''}
              <span class="badge badge-stock">${item.current_stock || 0} in stock</span>
              ${confirmed ? '<span class="badge badge-confirmed">Confirmed</span>' : ''}
            </div>
          </div>
        </div>
        <div class="item-actions">
          ${updateButton}
          <button class="action-btn confirm-btn ${confirmed ? 'disabled' : ''}"
                  ${confirmed ? '' : `data-action="showConfirmModal" data-action-param="${escapeHtml(item.variation_id)}"`}
                  ${confirmed ? 'disabled' : ''}>
            ${confirmed ? 'Confirmed' : config.buttonText}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function showConfirmModal(elementOrId, event, param) {
  // Support both: showConfirmModal('id') and showConfirmModal(element, event, param)
  const variationId = param || elementOrId;
  const item = allItems.find(i => i.variation_id === variationId);
  if (!item) {
    showToast('Item not found. Please refresh the page.', 'error');
    return;
  }

  currentItem = item;
  const config = tierConfig[item.tier_code];

  // Set modal title
  document.getElementById('modal-title').textContent = config.title;

  // Populate item info
  document.getElementById('modal-item-name').textContent = item.item_name;
  document.getElementById('modal-item-sku').textContent = `SKU: ${item.sku || 'N/A'}`;

  // Set display
  const displayEl = document.getElementById('modal-confirm-display');
  displayEl.className = `confirm-display ${config.displayClass}`;
  document.getElementById('modal-display-label').textContent = config.displayLabel;
  document.getElementById('modal-display-value').textContent = config.getDisplayValue(item);

  // Show expiry date for discount tiers so user can verify before applying sticker
  const expiryDisplayEl = document.getElementById('modal-expiry-display');
  if (item.tier_code === 'AUTO25' || item.tier_code === 'AUTO50') {
    const expiryDate = item.expiration_date ? item.expiration_date.split('T')[0] : 'Not set';
    document.getElementById('modal-expiry-value').textContent = expiryDate;
    expiryDisplayEl.style.display = 'block';
  } else {
    expiryDisplayEl.style.display = 'none';
  }

  // Set verification list
  const listEl = document.getElementById('modal-verification-list');
  listEl.innerHTML = config.verification.map(v => `<li>${v}</li>`).join('');

  // Set button text
  document.getElementById('confirm-btn').textContent = config.buttonText;

  // Reset notes
  document.getElementById('confirm-notes').value = '';

  // Show modal
  document.getElementById('confirm-modal').classList.add('active');
}

function closeConfirmModal() {
  document.getElementById('confirm-modal').classList.remove('active');
  currentItem = null;
}

function showUpdateModal(elementOrId, event, param) {
  // Support both: showUpdateModal('id') and showUpdateModal(element, event, param)
  const variationId = param || elementOrId;
  const item = allItems.find(i => i.variation_id === variationId);
  if (!item) {
    showToast('Item not found. Please refresh the page.', 'error');
    return;
  }

  currentItem = item;

  // Populate modal
  document.getElementById('update-modal-item-name').textContent = item.item_name;
  document.getElementById('update-modal-item-sku').textContent = `SKU: ${item.sku || 'N/A'}`;

  const expiryDate = item.expiration_date ? item.expiration_date.split('T')[0] : 'Not set';
  document.getElementById('update-modal-old-date').textContent = expiryDate;

  document.getElementById('new-expiry-date').value = '';
  document.getElementById('update-notes').value = '';

  // Show modal
  document.getElementById('update-modal').classList.add('active');
}

function closeUpdateModal() {
  document.getElementById('update-modal').classList.remove('active');
  currentItem = null;
}

async function confirmItem() {
  if (!currentItem) {
    showToast('No item selected. Please try again.', 'error');
    return;
  }

  const notes = document.getElementById('confirm-notes').value.trim();
  const config = tierConfig[currentItem.tier_code];
  const btn = document.getElementById('confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Confirming...';

  try {
    // For NO_EXPIRY items, mark as "does not expire" first
    if (currentItem.tier_code === 'NO_EXPIRY') {
      const expiryResponse = await fetch('/api/expirations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{
          variation_id: currentItem.variation_id,
          expiration_date: null,
          does_not_expire: true
        }])
      });

      if (!expiryResponse.ok) {
        const expiryData = await expiryResponse.json();
        throw new Error(expiryData.details || expiryData.error || 'Failed to mark as does not expire');
      }
    }

    // Record the confirmation via the review API
    const response = await fetch('/api/expirations/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        variation_ids: [currentItem.variation_id],
        reviewed_by: 'Audit User',
        notes: notes || `${currentItem.tier_code} audit: ${config.successMessage}`
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.details || data.error || 'Failed to record confirmation');
    }

    // Mark as confirmed in session cache for immediate UI feedback
    sessionConfirmed[currentItem.variation_id] = currentItem.tier_code;
    // Also update the item's reviewed_at so stats are accurate
    currentItem.reviewed_at = new Date().toISOString();

    closeConfirmModal();
    updateCounts();
    updateStats();

    // Re-render to ensure confirmed items are properly styled
    renderItems();

    showToast(config.successMessage, 'success');

  } catch (error) {
    console.error('Failed to confirm:', error);
    showToast('Failed to record confirmation: ' + error.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = config.buttonText;
  }
}

async function updateDate() {
  if (!currentItem) {
    showToast('No item selected. Please try again.', 'error');
    return;
  }

  const newDate = document.getElementById('new-expiry-date').value;
  const notes = document.getElementById('update-notes').value.trim();

  if (!newDate) {
    showToast('Please enter the new expiry date.', 'error');
    return;
  }

  const btn = document.getElementById('update-date-btn');
  btn.disabled = true;
  btn.textContent = 'Updating...';

  try {
    // Update the expiration date
    const response = await fetch('/api/expirations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        variation_id: currentItem.variation_id,
        expiration_date: newDate,
        does_not_expire: false
      }])
    });

    if (!response.ok) {
      throw new Error('Failed to update expiration date');
    }

    // Calculate new days until expiry
    const newExpiryDate = new Date(newDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    newExpiryDate.setHours(0, 0, 0, 0);
    const newDaysUntil = Math.ceil((newExpiryDate - today) / (1000 * 60 * 60 * 24));

    // Determine new tier based on updated date
    const newTier = getTierFromDays(newDaysUntil);

    // Save item reference before closing modal (closeUpdateModal sets currentItem to null)
    const item = currentItem;
    const variationId = item.variation_id;

    // Update the item's data
    item.expiration_date = newDate;
    item.days_until_expiry = newDaysUntil;

    // Close the update modal
    document.getElementById('update-modal').classList.remove('active');

    // If new tier requires sticker confirmation (AUTO25 or AUTO50), show confirm modal
    if (newTier === 'AUTO25' || newTier === 'AUTO50') {
      item.tier_code = newTier;
      item.discount_percent = newTier === 'AUTO25' ? 25 : 50;
      currentItem = item; // Restore for confirm modal
      showToast(`Date updated! Now ${newDaysUntil} days until expiry. Please confirm ${item.discount_percent}% sticker.`, 'success');
      // Show the sticker confirmation modal
      setTimeout(() => showConfirmModal(variationId), 300);
    } else {
      // Not in a discount tier - just mark as reviewed and remove
      currentItem = null;
      await fetch('/api/expirations/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variation_ids: [variationId],
          reviewed_by: 'Audit User',
          notes: notes || `Date updated from audit: ${item.expiration_date?.split('T')[0]} -> ${newDate}`
        })
      });

      // Remove from list since it's no longer in an audit tier
      allItems = allItems.filter(i => i.variation_id !== variationId);
      showToast(`Expiry date updated to ${newDate}. Item moved to ${newTier || 'FRESH'} tier.`, 'success');
    }

    updateCounts();
    updateStats();
    renderItems();

  } catch (error) {
    console.error('Failed to update date:', error);
    showToast('Failed to update date: ' + error.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Update Date';
  }
}

function showToast(message, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.classList.add('active');

  setTimeout(() => {
    toast.classList.remove('active');
  }, 3000);
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

// Global error handler for images with fallback (CSP compliant - replaces inline onerror)
document.addEventListener('error', function(e) {
  if (e.target.tagName === 'IMG' && e.target.dataset.fallback) {
    e.target.style.display = 'none';
    const fallback = e.target.nextElementSibling;
    if (fallback) {
      fallback.style.display = 'flex';
    }
  }
}, true);

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  // Check for URL parameters to pre-set filter
  const urlParams = new URLSearchParams(window.location.search);
  const filterParam = urlParams.get('filter');
  if (filterParam) {
    // Map friendly names to tier codes
    const filterMap = {
      'expired': 'EXPIRED',
      'auto50': 'AUTO50',
      'auto25': 'AUTO25',
      'review': 'REVIEW',
      'no-data': 'NO_EXPIRY',
      'no-expiry': 'NO_EXPIRY',
      'missing': 'NO_EXPIRY',
      'all': 'all'
    };
    const tierCode = filterMap[filterParam.toLowerCase()] || filterParam.toUpperCase();
    if (['all', 'EXPIRED', 'AUTO50', 'AUTO25', 'REVIEW', 'NO_EXPIRY'].includes(tierCode)) {
      currentFilter = tierCode;
    }
  }
  // Load tier config first (ensures manual tier changes from settings are respected)
  await loadTierConfig();
  // Then load items for audit
  loadItems();
});

// Close modals on background click
document.getElementById('confirm-modal').addEventListener('click', (e) => {
  if (e.target.id === 'confirm-modal') {
    closeConfirmModal();
  }
});

document.getElementById('update-modal').addEventListener('click', (e) => {
  if (e.target.id === 'update-modal') {
    closeUpdateModal();
  }
});

// Refresh data when tab becomes visible
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    loadItems();
  }
});

// Expose functions to global scope for event delegation
window.navigateTo = navigateTo;
window.loadItems = loadItems;
window.filterByTier = filterByTier;
window.showConfirmModal = showConfirmModal;
window.showUpdateModal = showUpdateModal;
window.closeConfirmModal = closeConfirmModal;
window.closeUpdateModal = closeUpdateModal;
window.confirmItem = confirmItem;
window.updateDate = updateDate;
