/**
 * Reorder Suggestions Page JavaScript
 * Externalized from reorder.html for CSP compliance (P0-4)
 */

let allSuggestions = [];
let selectedItems = new Set();
// Track pending min-stock saves to prevent rapid-fire requests
const pendingMinStockSaves = new Map();
// Track user-edited order quantities (cases) by variation_id
const editedOrderQtys = new Map();
// Bundle analysis data
let bundleAnalysis = [];
let bundleAffiliations = {};
// Track which bundles are expanded
const expandedBundles = new Set();
// Track user-edited bundle child order quantities: variation_id -> units
const editedBundleChildQtys = new Map();
// Set of variation_ids that belong to a bundle (filtered from main table)
let bundleChildVariationIds = new Set();
// Expiry tier config loaded from API (BACKLOG-32: replaces hardcoded thresholds)
let expiryTierRanges = {};

// --- Vendor-First Workflow State ---
// Cached vendor records from /api/vendors (includes schedule, minimum, etc.)
let vendorRecords = [];
// Other vendor items (not in suggestion set) for manual addition
let otherVendorItems = [];
// Manually added items (moved from "other" to main table)
let manualItems = [];
// Current vendor's minimum order amount (cents)
let currentVendorMinimum = 0;
// Track whether the "other items" section is expanded
let otherItemsExpanded = false;

// Load expiry tier configuration from API
async function loadExpiryTierConfig() {
  try {
    const response = await fetch('/api/expiry-discounts/tiers');
    const data = await response.json();
    expiryTierRanges = {};
    for (const tier of data.tiers || []) {
      expiryTierRanges[tier.tier_code] = {
        min: tier.min_days_to_expiry,
        max: tier.max_days_to_expiry,
        discount_percent: tier.discount_percent
      };
    }
  } catch (error) {
    console.error('Failed to load expiry tier config, using defaults:', error);
    expiryTierRanges = {
      'EXPIRED': { min: null, max: 0 },
      'AUTO50': { min: 1, max: 30 },
      'AUTO25': { min: 31, max: 89 },
      'REVIEW': { min: 90, max: 120 },
      'OK': { min: 121, max: null }
    };
  }
}

// Get expiry tier from days using API-loaded config
function getExpiryTierFromDays(daysUntilExpiry) {
  if (daysUntilExpiry === null || daysUntilExpiry === undefined) return null;
  for (const [tierCode, range] of Object.entries(expiryTierRanges)) {
    const minOk = range.min === null || daysUntilExpiry >= range.min;
    const maxOk = range.max === null || daysUntilExpiry <= range.max;
    if (minOk && maxOk) return tierCode;
  }
  return null;
}

// Load configuration from server
async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    const config = await response.json();

    // Set default supply days from environment variable
    const supplyDaysInput = document.getElementById('supply-days');
    supplyDaysInput.value = config.defaultSupplyDays || 45;

    return config;
  } catch (error) {
    console.error('Failed to load config:', error);
    // Fallback to hardcoded default if config fetch fails
    document.getElementById('supply-days').value = 45;
  }
}

// Load locations on page load
async function loadLocations() {
  try {
    const response = await fetch('/api/locations');
    const data = await response.json();

    const locations = data.locations || [];
    const select = document.getElementById('location-select');
    const activeLocations = locations.filter(loc => loc.active);

    // Build options: first location selected by default, "All Locations" at the bottom
    select.innerHTML = '';
    activeLocations.forEach((loc, index) => {
      const option = document.createElement('option');
      option.value = loc.id;
      option.textContent = loc.name;
      if (index === 0) option.selected = true; // Select first location by default
      select.appendChild(option);
    });

    // Add "All Locations" at the bottom (separator style)
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = '── All Locations ──';
    select.appendChild(allOption);
  } catch (error) {
    console.error('Failed to load locations:', error);
    const friendlyMsg = window.ErrorHelper
      ? ErrorHelper.getFriendlyMessage(error)
      : 'Unable to load locations. Please refresh the page.';
    alert(friendlyMsg);
  }
}

// Load vendors on page load
async function loadVendors() {
  try {
    const response = await fetch('/api/vendors?status=ACTIVE');
    const data = await response.json();

    const vendors = Array.isArray(data) ? data : (data.vendors || []);
    vendorRecords = vendors;
    const select = document.getElementById('vendor-select');

    // Default: "Select vendor..." (no data fetch until vendor chosen)
    select.innerHTML = '<option value="__none__">Select vendor...</option>';

    // Add "All Vendors" option
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = '── All Vendors ──';
    select.appendChild(allOption);

    // Add "No Vendor" option for items without vendor assignments
    const noVendorOption = document.createElement('option');
    noVendorOption.value = 'none';
    noVendorOption.textContent = '— No Vendor Assigned —';
    select.appendChild(noVendorOption);

    vendors.forEach(vendor => {
      const option = document.createElement('option');
      option.value = vendor.id;
      option.textContent = vendor.name;
      select.appendChild(option);
    });

    // Restore last selected vendor from sessionStorage
    const savedState = getReorderState();
    if (savedState && savedState.vendorId) {
      const savedOption = select.querySelector(`option[value="${savedState.vendorId}"]`);
      if (savedOption) {
        select.value = savedState.vendorId;
      }
    }
  } catch (error) {
    console.error('Failed to load vendors:', error);
    const friendlyMsg = window.ErrorHelper
      ? ErrorHelper.getFriendlyMessage(error, 'vendor', 'load')
      : 'Unable to load vendors. Please refresh the page.';
    alert(friendlyMsg);
  }
}

async function getSuggestions() {
  const locationId = document.getElementById('location-select').value;
  const vendorId = document.getElementById('vendor-select').value;
  const supplyDays = document.getElementById('supply-days').value;

  // Don't fetch if no vendor selected yet (vendor-first workflow)
  if (vendorId === '__none__') {
    showVendorPrompt();
    return;
  }

  let url = `/api/reorder-suggestions?supply_days=${supplyDays}`;
  if (locationId) url += `&location_id=${locationId}`;
  if (vendorId) url += `&vendor_id=${vendorId}`;
  // Request other vendor items for manual addition when a specific vendor is selected
  if (vendorId && vendorId !== '' && vendorId !== 'none') {
    url += '&include_other=true';
  }

  hideVendorPrompt();
  const tbody = document.getElementById('suggestions-body');
  tbody.innerHTML = '<tr><td colspan="20" class="loading">Loading suggestions...</td></tr>';

  try {
    const response = await fetch(url);
    const data = await response.json();

    allSuggestions = data.suggestions || [];
    bundleAnalysis = data.bundle_analysis || [];
    bundleAffiliations = data.bundle_affiliations || {};
    otherVendorItems = data.other_vendor_items || [];
    // Clear manual items on new fetch (transient per session)
    manualItems = [];

    // Enrich bundle children with fields from allSuggestions
    enrichBundleChildren();

    // Build set of bundle-affiliated variation_ids for filtering
    bundleChildVariationIds = new Set();
    for (const bundle of bundleAnalysis) {
      for (const child of (bundle.children || [])) {
        bundleChildVariationIds.add(child.variation_id);
      }
    }

    // Default all items to selected (excluding bundle children), clear edits
    selectedItems.clear();
    editedOrderQtys.clear();
    editedBundleChildQtys.clear();
    allSuggestions.forEach(item => {
      if (!bundleChildVariationIds.has(item.variation_id)) {
        selectedItems.add(item.variation_id);
      }
    });
    document.getElementById('select-all').checked = true;
    // Default all bundles to expanded
    expandedBundles.clear();
    bundleAnalysis.forEach(b => {
      expandedBundles.add(b.bundle_id);
    });

    if (allSuggestions.length === 0 && bundleAnalysis.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="20" class="empty-state">
            <h3>No Reorder Suggestions</h3>
            <p>No items need reordering for the selected vendor and supply days.</p>
            <p>Try different filters or run a sync to update inventory data.</p>
          </td>
        </tr>
      `;
      updateFooter();
      renderOtherItemsSection();
      return;
    }

    // Apply current sort if set, otherwise use default priority sort
    if (currentSortField) {
      // Re-apply current sort field and direction without toggling
      sortTable(currentSortField, sortDirections[currentSortField]);
    } else {
      // Default: sort by priority descending (URGENT first)
      sortTable('priority', false); // false = descending
    }

    renderOtherItemsSection();

  } catch (error) {
    console.error('Failed to load suggestions:', error);
    const friendlyMsg = window.ErrorHelper
      ? ErrorHelper.getFriendlyMessage(error, 'inventory', 'load')
      : 'Unable to load reorder suggestions. Please refresh the page.';
    tbody.innerHTML = `<tr><td colspan="20" class="loading">${escapeHtml(friendlyMsg)}</td></tr>`;
  }
}

function sortSuggestions() {
  const sortBy = document.getElementById('sort-by').value;

  if (sortBy === 'urgency') {
    // Sort by priority, then days until stockout
    const priorityOrder = { URGENT: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
    allSuggestions.sort((a, b) => {
      if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
        return priorityOrder[b.priority] - priorityOrder[a.priority];
      }
      return a.days_until_stockout - b.days_until_stockout;
    });
  } else if (sortBy === 'alphabetical') {
    // Sort by item name, then variation name
    allSuggestions.sort((a, b) => {
      const nameCompare = a.item_name.localeCompare(b.item_name);
      if (nameCompare !== 0) return nameCompare;
      return (a.variation_name || '').localeCompare(b.variation_name || '');
    });
  } else if (sortBy === 'vendor') {
    // Sort by vendor, then item name
    allSuggestions.sort((a, b) => {
      const vendorCompare = a.vendor_name.localeCompare(b.vendor_name);
      if (vendorCompare !== 0) return vendorCompare;
      return a.item_name.localeCompare(b.item_name);
    });
  }
}

/**
 * Enrich bundle children with fields from allSuggestions that the backend
 * bundle query doesn't provide (stock_alert_max, case_pack_quantity, expiration_date, etc.)
 */
function enrichBundleChildren() {
  const suggestionsMap = new Map();
  for (const item of allSuggestions) {
    suggestionsMap.set(item.variation_id, item);
  }

  for (const bundle of bundleAnalysis) {
    for (const child of (bundle.children || [])) {
      const suggestion = suggestionsMap.get(child.variation_id);
      if (!suggestion) continue;

      // Copy over fields the bundle query doesn't provide
      child.stock_alert_max = suggestion.stock_alert_max;
      child.case_pack_quantity = suggestion.case_pack_quantity;
      child.expiration_date = suggestion.expiration_date;
      child.does_not_expire = suggestion.does_not_expire;
      child.days_until_expiry = suggestion.days_until_expiry;
      child.unit_cost_cents = suggestion.unit_cost_cents;
      child.retail_price_cents = suggestion.retail_price_cents;
      child.gross_margin_percent = suggestion.gross_margin_percent;
      child.image_urls = suggestion.image_urls;
      // Note: current_stock, committed_quantity, available_quantity are provided
      // by the bundle query directly — do NOT overwrite from standalone suggestion
      // (standalone may be for a different location or have stale committed data)
      child.pending_po_quantity = suggestion.pending_po_quantity;
    }
  }
}

/**
 * Build recommendation text for a bundle child based on the optimized order option.
 * The backend's optimized option tells us how many vendor cases + individual topups.
 */
function getBundleChildRecommendation(bundle, child) {
  const opt = bundle.order_options || {};
  const optimized = opt.optimized || {};
  const bundleQty = optimized.bundle_qty || 0;
  const unitsFromCases = bundleQty * child.quantity_in_bundle;
  const topup = (optimized.individual_topups || [])
    .find(t => t.variation_id === child.variation_id);
  const topupQty = topup ? topup.qty : 0;
  const totalUnits = unitsFromCases + topupQty;

  if (totalUnits === 0) return '-';

  const parts = [];
  if (bundleQty > 0 && unitsFromCases > 0) {
    parts.push(`${unitsFromCases} from ${bundleQty} case${bundleQty > 1 ? 's' : ''}`);
  }
  if (topupQty > 0) {
    parts.push(`${topupQty} singles`);
  }
  return parts.join(' + ') + ` = ${totalUnits}`;
}

/**
 * Get the effective order quantity for a bundle child (user-edited or recommended).
 */
function getEffectiveBundleChildQty(child) {
  if (editedBundleChildQtys.has(child.variation_id)) {
    return editedBundleChildQtys.get(child.variation_id);
  }
  return child.individual_need || 0;
}

function renderBundleRows() {
  if (bundleAnalysis.length === 0) return '';

  return bundleAnalysis.map(bundle => {
    const isExpanded = expandedBundles.has(bundle.bundle_id);
    const toggle = isExpanded ? '&#9660;' : '&#9654;';
    const children = bundle.children || [];
    const caseCost = bundle.bundle_cost_cents
      ? '$' + (bundle.bundle_cost_cents / 100).toFixed(2)
      : '-';
    // Count how many units per case (sum of all child quantities)
    const unitsPerCase = children.reduce((sum, c) => sum + c.quantity_in_bundle, 0);

    // Calculate bundle group total cost from child order quantities
    let bundleGroupCost = 0;
    for (const child of children) {
      const qty = getEffectiveBundleChildQty(child);
      bundleGroupCost += qty * (child.individual_cost_cents || 0);
    }

    // Get optimized savings info from backend
    const opt = bundle.order_options || {};
    const optimized = opt.optimized || {};
    const savingsPct = parseFloat(optimized.savings_pct) || 0;
    const savingsHtml = savingsPct > 0
      ? ` | <span style="color:#059669;font-weight:600;">Optimized saves ${savingsPct}%</span>`
      : '';

    // Parent header row
    let html = `
      <tr class="bundle-parent-row" data-bundle-id="${bundle.bundle_id}">
        <td colspan="20" data-action="toggleBundleExpand" data-action-param="${bundle.bundle_id}">
          <span class="bundle-toggle">${toggle}</span>
          <strong>Bundle: ${escapeHtml(bundle.bundle_item_name)}</strong>
          <span class="bundle-header-meta">
            | Case: ${caseCost} (${unitsPerCase} units/case)
            | ${bundle.vendor_name ? escapeHtml(bundle.vendor_name) : 'No vendor'}
            ${bundle.bundle_vendor_code ? ' | <span class="clickable" data-action="copyToClipboard" data-action-param="' + escapeJsString(bundle.bundle_vendor_code) + '" data-copy-label="Case Vendor Code" title="Click to copy Case Vendor Code" style="font-family:monospace;background:rgba(255,255,255,0.3);padding:1px 6px;border-radius:3px;">Case SKU: ' + escapeHtml(bundle.bundle_vendor_code) + '</span>' : ''}
            ${savingsHtml}
            | Group Total: <strong>$${(bundleGroupCost / 100).toFixed(2)}</strong>
          </span>
        </td>
      </tr>`;

    if (isExpanded) {
      // Column headers for bundle children
      html += `
        <tr class="bundle-child-header">
          <td colspan="4" style="font-weight:600;font-size:11px;text-transform:uppercase;color:#6b7280;padding-left:24px;">Component</td>
          <td class="text-right" style="font-weight:600;font-size:11px;text-transform:uppercase;color:#6b7280;">Stock</td>
          <td class="text-right" style="font-weight:600;font-size:11px;text-transform:uppercase;color:#6b7280;">Min</td>
          <td class="text-right" style="font-weight:600;font-size:11px;text-transform:uppercase;color:#6b7280;">Days</td>
          <td class="text-right" style="font-weight:600;font-size:11px;text-transform:uppercase;color:#6b7280;">Velocity</td>
          <td class="text-right" style="font-weight:600;font-size:11px;text-transform:uppercase;color:#6b7280;">Need</td>
          <td class="text-right" style="font-weight:600;font-size:11px;text-transform:uppercase;color:#6b7280;">Recommended</td>
          <td class="text-right" style="font-weight:600;font-size:11px;text-transform:uppercase;color:#6b7280;">Order Qty</td>
          <td class="text-right" style="font-weight:600;font-size:11px;text-transform:uppercase;color:#6b7280;">Unit Cost</td>
          <td class="text-right" style="font-weight:600;font-size:11px;text-transform:uppercase;color:#6b7280;">Line Total</td>
          <td colspan="6" style="font-weight:600;font-size:11px;text-transform:uppercase;color:#6b7280;">Vendor Code</td>
          <td></td>
        </tr>`;

      // Child component rows with editable order qty
      html += children.map(child => {
        const daysClass = child.days_of_stock === 0 ? 'days-critical' :
          child.days_of_stock < 7 ? 'days-critical' :
          child.days_of_stock < 14 ? 'days-warning' : 'days-ok';
        const daysStr = child.days_of_stock < 999 ? child.days_of_stock.toFixed(1) : '-';
        const unitCost = child.individual_cost_cents || 0;
        const costStr = unitCost ? '$' + (unitCost / 100).toFixed(2) : '-';

        const deletedClass = child.is_deleted ? ' bundle-child-deleted' : '';
        const deletedAlert = child.is_deleted
          ? '<br><span class="bundle-deleted-alert">DELETED — Update in Bundle Manager</span>'
          : '';

        // Build recommendation from backend optimized option
        const recommendedText = getBundleChildRecommendation(bundle, child);

        const orderQty = getEffectiveBundleChildQty(child);
        const lineTotalCents = orderQty * unitCost;
        const isEdited = editedBundleChildQtys.has(child.variation_id);

        return `
          <tr class="bundle-child-row${deletedClass}" data-bundle-id="${bundle.bundle_id}" data-variation-id="${child.variation_id}">
            <td colspan="4" style="padding-left:24px;">
              <span class="bundle-child-label">|--</span>
              ${escapeHtml(child.child_item_name || '')}
              ${child.child_variation_name ? '<br><small style="color:#6b7280;padding-left:24px;">' + escapeHtml(child.child_variation_name) + '</small>' : ''}
              <small style="color:#9ca3af;margin-left:6px;">${escapeHtml(child.child_sku || '')}</small>
              ${deletedAlert}
            </td>
            <td class="text-right">${child.committed_quantity > 0 ? child.available_quantity : child.stock}${child.committed_quantity > 0 ? '<br><small style="color:#92400e;">⚠️ ' + child.current_stock + ' on-hand</small>' : ''}</td>
            <td class="text-right">${child.stock_alert_min > 0 ? child.stock_alert_min : '-'}</td>
            <td class="text-right ${daysClass}">${daysStr}</td>
            <td class="text-right">
              <small>
                ${child.total_daily_velocity.toFixed(2)}/day
                <div class="bundle-velocity-split">
                  Ind: ${child.individual_daily_velocity.toFixed(2)} |
                  <span class="bundle-pct">Bndl: ${child.pct_from_bundles}%</span>
                </div>
              </small>
            </td>
            <td class="text-right">${child.individual_need}</td>
            <td class="text-right">
              <small class="bundle-recommended">${escapeHtml(recommendedText)}</small>
            </td>
            <td class="text-right editable-cell">
              <input type="number"
                     class="editable-input order-qty-input bundle-child-qty-input"
                     value="${orderQty}"
                     placeholder="${child.individual_need}"
                     min="0"
                     data-field="bundle_child_qty"
                     data-variation-id="${child.variation_id}"
                     data-bundle-id="${bundle.bundle_id}"
                     data-suggested="${child.individual_need}"
                     data-change="updateBundleChildQty"
                     data-blur="updateBundleChildQty"
                     data-keydown="blurOnEnter">
              ${isEdited ? '<br><small style="color:#059669;font-weight:600;">edited</small>' : ''}
              ${child.pending_po_quantity > 0 ? '<br><small style="color:#3b82f6;" title="' + child.pending_po_quantity + ' units pending in unreceived POs">📦 ' + child.pending_po_quantity + ' on order</small>' : ''}
            </td>
            <td class="text-right">${costStr}</td>
            <td class="text-right"><strong>$${(lineTotalCents / 100).toFixed(2)}</strong></td>
            <td colspan="6" class="clickable" data-action="copyToClipboard" data-action-param="${escapeJsString(child.vendor_code || '')}" data-copy-label="Vendor Code" title="Click to copy Vendor Code">${escapeHtml(child.vendor_code || '-')}</td>
            <td></td>
          </tr>`;
      }).join('');

      // Summary row
      html += `
        <tr class="bundle-summary-row" data-bundle-id="${bundle.bundle_id}">
          <td colspan="12" style="text-align:right;font-weight:600;color:#374151;padding-right:12px;">
            Bundle Group Total:
          </td>
          <td class="text-right" style="font-weight:700;color:#059669;font-size:15px;">
            $${(bundleGroupCost / 100).toFixed(2)}
          </td>
          <td colspan="7"></td>
        </tr>`;
    }

    // Separator
    html += `<tr class="bundle-separator"><td colspan="20"></td></tr>`;

    return html;
  }).join('');
}

function toggleBundleExpand(element, event, bundleId) {
  const bid = parseInt(bundleId);
  if (expandedBundles.has(bid)) {
    expandedBundles.delete(bid);
  } else {
    expandedBundles.add(bid);
  }
  renderTable();
}

/**
 * Update bundle child order quantity when user edits
 */
function updateBundleChildQty(input) {
  const variationId = input.dataset.variationId;
  const value = input.value.trim();
  const suggested = parseInt(input.dataset.suggested, 10) || 0;

  if (value === '' || parseInt(value, 10) === suggested) {
    editedBundleChildQtys.delete(variationId);
    input.value = suggested;
  } else {
    const newQty = parseInt(value, 10);
    if (isNaN(newQty) || newQty < 0) {
      input.value = editedBundleChildQtys.get(variationId) || suggested;
      return;
    }
    editedBundleChildQtys.set(variationId, newQty);
  }

  renderTable();
  updateFooter();
}

function renderTable() {
  const tbody = document.getElementById('suggestions-body');

  // Render bundle groups first, then standalone items
  const bundleHtml = renderBundleRows();

  // Filter out bundle-affiliated items from the main table
  const standaloneItems = allSuggestions.filter(item => !bundleChildVariationIds.has(item.variation_id));

  const itemsHtml = standaloneItems.map((item, index) => {
    const daysClass = item.days_until_stockout === 0 ? 'days-critical' :
                     item.days_until_stockout < 7 ? 'days-critical' :
                     item.days_until_stockout < 14 ? 'days-warning' : 'days-ok';
    const daysText = item.days_until_stockout === 0 ? '0' :
                    item.days_until_stockout < 999 ?
                    item.days_until_stockout.toFixed(1) : '∞';
    const isSelected = selectedItems.has(item.variation_id);

    // Get velocity class based on 91-day average (daily rate)
    const dailyVelocity = (item.weekly_avg_91d || 0) / 7;
    const getVelocityClass = (velocity) => {
      if (!velocity || velocity === 0) return 'velocity-none';
      if (velocity >= 1) return 'velocity-fast';
      if (velocity >= 0.1) return 'velocity-moderate';
      return 'velocity-slow';
    };
    const velocityClass = getVelocityClass(dailyVelocity);

    // Display velocity data with proper precision
    // Show actual values even if very small (e.g., 0.011/day for slow movers)
    const formatVelocity = (weeklyVal) => {
      if (weeklyVal === null || weeklyVal === undefined || weeklyVal === 0) {
        return 'No data';
      }
      // Show 2 decimal places for weekly, but show very small values too
      return weeklyVal.toFixed(2);
    };

    // New variation warning badge (BACKLOG-30): velocity data may be unreliable
    const NEW_VARIATION_DAYS = 7;
    const newVariationBadge = (item.variation_age_days !== null && item.variation_age_days < NEW_VARIATION_DAYS)
      ? '<span class="new-variation-badge" title="Variation created within the last 7 days. Velocity data may be unreliable due to Square ID reassignment when variations are reordered in POS.">&#9888;&#65039; &lt;7d</span> '
      : '';

    const velocityText = `${newVariationBadge}<span class="${velocityClass}">${formatVelocity(item.weekly_avg_91d)} / ${formatVelocity(item.weekly_avg_182d)} / ${formatVelocity(item.weekly_avg_365d)}</span>`;

    // Calculate order quantity respecting stock maximum
    let suggestedQty = item.final_suggested_qty;
    let cappedByMax = false;

    // If stock_alert_max is set, don't order beyond it
    if (item.stock_alert_max && item.stock_alert_max > 0) {
      const projectedStock = item.current_stock + suggestedQty;
      if (projectedStock > item.stock_alert_max) {
        // Cap at maximum, but don't go negative
        suggestedQty = Math.max(0, item.stock_alert_max - item.current_stock);
        cappedByMax = true;
      }
    }

    // Calculate cases to order (round up)
    const casePack = item.case_pack_quantity || 1;
    const casesToOrder = suggestedQty > 0 ? Math.ceil(suggestedQty / casePack) : 0;
    const actualUnits = casesToOrder * casePack;
    const totalCost = (actualUnits * item.unit_cost_cents / 100).toFixed(2);

    // Check if there's actually no velocity data (all periods are null/0)
    const hasNoVelocityData = (!item.weekly_avg_91d || item.weekly_avg_91d === 0) &&
                                (!item.weekly_avg_182d || item.weekly_avg_182d === 0) &&
                                (!item.weekly_avg_365d || item.weekly_avg_365d === 0);

    // Add visual indicator for items without velocity
    const priorityClass = hasNoVelocityData && item.priority === 'MEDIUM'
      ? 'priority-MEDIUM'
      : `priority-${item.priority}`;

    // Secondary vendor highlighting
    const rowClass = item.is_primary_vendor ? '' : 'secondary-vendor';
    const primaryCostDisplay = (item.primary_vendor_cost / 100).toFixed(2);
    const vendorWarning = !item.is_primary_vendor
      ? `<br><span class="vendor-warning" title="Primary vendor: ${escapeHtml(item.primary_vendor_name)} @ $${primaryCostDisplay}">⚠️ Alt ($${primaryCostDisplay})</span>`
      : '';

    // Get image URL
    const imageUrl = item.image_urls && item.image_urls[0] ? item.image_urls[0] : null;
    const imageHtml = imageUrl
      ? `<img src="${imageUrl}" class="product-image" alt="Product" data-error-action="hideImageShowPlaceholder">
         <div class="no-image" style="display:none;">📦</div>`
      : `<div class="no-image">📦</div>`;

    // Expiration date handling
    const expiresWithin120Days = item.days_until_expiry !== null && item.days_until_expiry <= 120;
    const expiryRowClass = expiresWithin120Days ? 'expiry-warning' : '';

    // Determine expiry tier for visual indicators (uses API-loaded tier config)
    const daysLeft = item.days_until_expiry;
    let expiryTier = null;
    let expiryTierLabel = '';
    let needsReorderResistance = false;

    if (item.does_not_expire) {
      expiryTier = null;
    } else if (daysLeft !== null) {
      expiryTier = getExpiryTierFromDays(daysLeft) || 'OK';
      const tierLabelMap = { 'EXPIRED': 'EXP', 'AUTO50': '50%', 'AUTO25': '25%', 'REVIEW': 'REV', 'OK': 'OK' };
      expiryTierLabel = tierLabelMap[expiryTier] || expiryTier;
      needsReorderResistance = expiryTier === 'EXPIRED' || expiryTier === 'AUTO50' || expiryTier === 'AUTO25';
    }

    // Add reorder resistance class for expiring items
    const resistanceClass = needsReorderResistance ? 'reorder-resistance' : '';
    const combinedRowClass = `${rowClass} ${expiryRowClass} ${resistanceClass}`.trim();

    // Build expiry tier circle HTML with friendly tooltips
    const tierTooltips = {
      'EXPIRED': 'Expired - Pull from shelf',
      'AUTO50': `Clearance sale - ${daysLeft} days until expiry`,
      'AUTO25': `Discount applied - ${daysLeft} days until expiry`,
      'REVIEW': `Under review - ${daysLeft} days until expiry`,
      'OK': `OK - ${daysLeft} days until expiry`
    };
    const tierCircleHtml = expiryTier
      ? `<span class="expiry-tier-circle tier-${expiryTier}" title="${tierTooltips[expiryTier] || ''}">${expiryTierLabel}</span>`
      : '';

    // Reorder warning HTML
    const reorderWarningHtml = needsReorderResistance
      ? `<span class="reorder-resistance-warning" title="This item is expiring - consider if reorder is necessary">⚠ EXPIRING</span>`
      : '';

    let expiryHtml = '';
    if (item.does_not_expire) {
      expiryHtml = '<span class="expiry-none">Never</span>';
    } else if (item.expiration_date) {
      const expiryDate = new Date(item.expiration_date);
      const formattedDate = expiryDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const expiryBadgeTier = getExpiryTierFromDays(daysLeft);
      if (expiryBadgeTier === 'EXPIRED' || expiryBadgeTier === 'AUTO50') {
        expiryHtml = `<span class="expiry-badge critical" title="${daysLeft} days until expiry">${formattedDate}</span>`;
      } else if (expiryBadgeTier === 'AUTO25' || expiryBadgeTier === 'REVIEW') {
        expiryHtml = `<span class="expiry-badge warning" title="${daysLeft} days until expiry">${formattedDate}</span>`;
      } else {
        expiryHtml = `<span class="expiry-ok">${formattedDate}</span>`;
      }
    } else {
      expiryHtml = '<span class="expiry-none">-</span>';
    }

    // Build expiry info section showing days + tier
    let expiryInfoHtml = '';
    if (expiryTier && daysLeft !== null) {
      const daysClassTier = getExpiryTierFromDays(daysLeft) || 'OK';
      const daysClass = (daysClassTier === 'EXPIRED' || daysClassTier === 'AUTO50') ? 'critical' : daysClassTier === 'AUTO25' ? 'warning' : daysClassTier === 'REVIEW' ? 'review' : 'ok';
      expiryInfoHtml = `
        <div class="expiry-info">
          <span class="expiry-days ${daysClass}">${daysLeft}d</span>
        </div>`;
    }

    return `
      <tr class="${isSelected ? 'selected' : 'unchecked'} ${combinedRowClass}" data-id="${item.variation_id}" data-expiry-tier="${expiryTier || ''}">
        <td class="text-center">
          <input type="checkbox"
                 ${isSelected ? 'checked' : ''}
                 data-change="toggleItemFromCheckbox"
                 data-variation-id="${item.variation_id}">
        </td>
        <td>
          <span class="priority-badge ${priorityClass}">${item.priority}</span>
          ${hasNoVelocityData ? '<br><small style="color: #ef4444;">⚠ No Data</small>' : ''}
          ${velocityClass === 'velocity-slow' && dailyVelocity > 0 ? '<br><small style="color: #6b7280;">Slow mover</small>' : ''}
          ${vendorWarning}
          ${reorderWarningHtml}
        </td>
        <td>${imageHtml}</td>
        <td>
          <div class="product-name">
            ${tierCircleHtml}${escapeHtml(item.item_name)}
            ${bundleAffiliations[item.variation_id] ? '<span class="bundle-badge" title="Part of: ' + escapeHtml(bundleAffiliations[item.variation_id].join(', ')) + '">BUNDLE</span>' : ''}
          </div>
          ${item.variation_name ? `<div class="variation-name">${escapeHtml(item.variation_name)}</div>` : ''}
          ${expiryInfoHtml}
        </td>
        <td class="sku clickable" data-action="copyToClipboard" data-action-param="${escapeJsString(item.sku || '')}" data-copy-label="SKU" title="Click to copy SKU">${escapeHtml(item.sku || '-')}</td>
        <td class="text-right">
          ${item.committed_quantity > 0 ? item.available_quantity : item.current_stock}
          ${item.committed_quantity > 0 ? `<br><small style="color: #92400e;" title="${item.current_stock} on-hand, ${item.committed_quantity} committed to invoices">⚠️ ${item.current_stock} on-hand</small>` : ''}
        </td>
        <td class="text-right editable-cell">
          <div class="editable-display ${item.stock_alert_min ? 'has-value' : ''}"
               data-action="enterEditMode"
               data-variation-id="${escapeJsString(item.variation_id)}"
               data-field="stock_alert_min"
               data-value="${item.stock_alert_min || ''}"
               title="Click to edit - syncs to Square">
            ${item.stock_alert_min ? item.stock_alert_min : '-'}
          </div>
        </td>
        <td class="text-right editable-cell">
          <div class="editable-display ${item.stock_alert_max ? 'has-value' : ''}"
               data-action="enterEditMode"
               data-variation-id="${escapeJsString(item.variation_id)}"
               data-field="stock_alert_max"
               data-value="${item.stock_alert_max || ''}">
            ${item.stock_alert_max ? item.stock_alert_max : '<span class="infinity-symbol">∞</span>'}
          </div>
        </td>
        <td class="text-right ${daysClass}">${daysText}</td>
        <td class="text-right">${expiryHtml}</td>
        <td class="text-right"><small>${velocityText}</small></td>
        <td class="text-right editable-cell">
          <input type="number"
                 class="editable-input order-qty-input"
                 value="${editedOrderQtys.has(item.variation_id) ? editedOrderQtys.get(item.variation_id) : casesToOrder}"
                 placeholder="${casesToOrder}"
                 min="0"
                 data-field="order_qty"
                 data-variation-id="${item.variation_id}"
                 data-suggested="${casesToOrder}"
                 data-change="updateOrderQty"
                 data-blur="updateOrderQty"
                 data-keydown="blurOnEnter">
          <br><small style="color: #6b7280;" id="units-${item.variation_id}">(${actualUnits} units)</small>
          ${cappedByMax ? '<br><small style="color: #f59e0b;">⚠️ Capped at max</small>' : ''}
          ${item.pending_po_quantity > 0 ? `<br><small style="color: #3b82f6;" title="${item.pending_po_quantity} units pending in unreceived POs">📦 ${item.pending_po_quantity} on order</small>` : ''}
        </td>
        <td class="text-right editable-cell">
          <input type="number"
                 class="editable-input"
                 value="${item.case_pack_quantity || ''}"
                 placeholder="-"
                 min="1"
                 data-field="case_pack_quantity"
                 data-variation-id="${item.variation_id}"
                 data-blur="saveField"
                 data-keydown="blurOnEnter">
        </td>
        <td class="text-right editable-cell">
          <input type="number"
                 class="editable-input cost-input"
                 value="${item.unit_cost_cents ? (item.unit_cost_cents / 100).toFixed(2) : ''}"
                 placeholder="0.00"
                 min="0"
                 step="0.01"
                 data-field="unit_cost_cents"
                 data-variation-id="${item.variation_id}"
                 data-vendor-id="${item.current_vendor_id || ''}"
                 data-original-value="${item.unit_cost_cents || 0}"
                 data-blur="saveCost"
                 data-keydown="blurOnEnter"
                 style="width: 70px;">
        </td>
        <td class="text-right">${item.retail_price_cents ? '$' + (item.retail_price_cents / 100).toFixed(2) : '-'}</td>
        <td class="text-right ${item.gross_margin_percent !== null ? (item.gross_margin_percent >= 40 ? 'velocity-fast' : item.gross_margin_percent >= 20 ? 'velocity-moderate' : 'days-critical') : ''}">${item.gross_margin_percent !== null ? item.gross_margin_percent.toFixed(1) + '%' : '-'}</td>
        <td class="text-right" id="line-total-${item.variation_id}"><strong>$${totalCost}</strong></td>
        <td>${escapeHtml(item.vendor_name)}</td>
        <td class="clickable ${needsReorderResistance ? 'vendor-code-expiring' : ''}" data-action="copyToClipboard" data-action-param="${escapeJsString(item.vendor_code || '')}" data-copy-label="Vendor Code" title="${needsReorderResistance ? 'EXPIRING ITEM - Click to copy Vendor Code (still works)' : 'Click to copy Vendor Code'}">${escapeHtml(item.vendor_code)}</td>
        <td class="text-right">${item.lead_time_days > 0 ? item.lead_time_days + 'd' : '-'}</td>
      </tr>
    `;
  }).join('');

  // Manual items divider and rows (Feature 4)
  let manualHtml = '';
  if (manualItems.length > 0) {
    manualHtml += '<tr class="manual-divider"><td colspan="20"></td></tr>';
    manualHtml += manualItems.map(item => renderManualItemRow(item)).join('');
  }

  tbody.innerHTML = bundleHtml + itemsHtml + manualHtml;
}

function toggleSelectAll(checked) {
  selectedItems.clear();
  if (checked) {
    // Only select standalone items, not bundle children
    allSuggestions.forEach(item => {
      if (!bundleChildVariationIds.has(item.variation_id)) {
        selectedItems.add(item.variation_id);
      }
    });
  }
  renderTable();
  updateFooter();
}

// --- Event delegation helper functions ---

// Toggle select all from checkbox (for data-change handler)
function toggleSelectAllFromCheckbox(element) {
  toggleSelectAll(element.checked);
}

// Toggle item from checkbox (for data-change handler)
function toggleItemFromCheckbox(element) {
  const variationId = element.dataset.variationId;
  toggleItem(variationId, element.checked);
}

// Copy to clipboard (for data-action handler)
// Parameter order: (element, event, param) to match PageActions convention
function copyToClipboard(element, event, param) {
  const value = param || '';
  const label = element.dataset.copyLabel || 'Text';
  if (!value || value === '-') return;

  // Try modern clipboard API first, with fallback
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value).then(() => {
      showToast(`${label} copied: ${value}`, 'success');
    }).catch(() => {
      fallbackCopy(value, label);
    });
  } else {
    fallbackCopy(value, label);
  }
}

// Fallback copy method for older browsers
function fallbackCopy(text, label) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    showToast(`${label} copied: ${text}`, 'success');
  } catch (err) {
    showToast('Failed to copy', 'error');
  }
  document.body.removeChild(textarea);
}

// Enter edit mode (for data-action handler)
function enterEditMode(element, event, param) {
  const variationId = element.dataset.variationId;
  const field = element.dataset.field;
  const value = element.dataset.value || null;
  enterEditModeImpl(element, variationId, field, value);
}

// Blur on Enter key (for data-keydown handler)
function blurOnEnter(element, event) {
  if (event.key === 'Enter') {
    element.blur();
  }
}

// Handle image error - hide image and show placeholder
document.addEventListener('error', function(event) {
  if (event.target.tagName === 'IMG' && event.target.dataset.errorAction === 'hideImageShowPlaceholder') {
    event.target.style.display = 'none';
    if (event.target.nextElementSibling) {
      event.target.nextElementSibling.style.display = 'flex';
    }
  }
}, true);

function toggleItem(variationId, checked) {
  // Check if this is an expiring item being selected
  if (checked) {
    const row = document.querySelector(`tr[data-id="${variationId}"]`);
    const expiryTier = row?.getAttribute('data-expiry-tier');

    if (['EXPIRED', 'AUTO50', 'AUTO25'].includes(expiryTier)) {
      const item = allSuggestions.find(s => s.variation_id === variationId);
      const itemName = item ? item.item_name : 'This item';
      const daysLeft = item?.days_until_expiry;

      const tierMessages = {
        'EXPIRED': `"${itemName}" is EXPIRED and should be pulled from shelves. Are you sure you want to reorder?`,
        'AUTO50': `"${itemName}" expires in ${daysLeft} days and is on clearance sale (50% off). Consider if reorder is necessary.`,
        'AUTO25': `"${itemName}" expires in ${daysLeft} days and has a discount applied (25% off). Consider if reorder is necessary.`
      };

      if (!confirm(tierMessages[expiryTier] + '\n\nClick OK to select anyway, or Cancel to skip.')) {
        // Uncheck the checkbox visually
        const checkbox = row.querySelector('input[type="checkbox"]');
        if (checkbox) checkbox.checked = false;
        return;
      }
    }
    selectedItems.add(variationId);
  } else {
    selectedItems.delete(variationId);
  }

  // Update select-all checkbox (only considers standalone items)
  const standaloneCount = allSuggestions.filter(s => !bundleChildVariationIds.has(s.variation_id)).length;
  document.getElementById('select-all').checked =
    selectedItems.size === standaloneCount && standaloneCount > 0;

  // Update row styling
  const row = document.querySelector(`tr[data-id="${variationId}"]`);
  if (row) {
    row.classList.toggle('selected', checked);
    row.classList.toggle('unchecked', !checked);
  }

  updateFooter();
}

function updateFooter() {
  // Standalone items cost (non-bundle)
  const standaloneItems = allSuggestions.filter(s =>
    selectedItems.has(s.variation_id) && !bundleChildVariationIds.has(s.variation_id)
  );
  const standaloneCost = standaloneItems.reduce((sum, item) => {
    const casePack = item.case_pack_quantity || 1;
    let casesToOrder;

    if (editedOrderQtys.has(item.variation_id)) {
      casesToOrder = editedOrderQtys.get(item.variation_id);
    } else {
      let suggestedQty = item.final_suggested_qty;
      if (item.stock_alert_max && item.stock_alert_max > 0) {
        const projectedStock = item.current_stock + suggestedQty;
        if (projectedStock > item.stock_alert_max) {
          suggestedQty = Math.max(0, item.stock_alert_max - item.current_stock);
        }
      }
      casesToOrder = suggestedQty > 0 ? Math.ceil(suggestedQty / casePack) : 0;
    }

    const actualUnits = casesToOrder * casePack;
    return sum + (actualUnits * item.unit_cost_cents / 100);
  }, 0);

  // Bundle child items cost
  let bundleCost = 0;
  let bundleChildCount = 0;
  for (const bundle of bundleAnalysis) {
    for (const child of (bundle.children || [])) {
      const qty = getEffectiveBundleChildQty(child);
      if (qty > 0) {
        bundleCost += (qty * (child.individual_cost_cents || 0)) / 100;
        bundleChildCount++;
      }
    }
  }

  // Manual items cost
  let manualCost = 0;
  const manualCount = manualItems.length;
  for (const item of manualItems) {
    const casePack = item.case_pack_quantity || 1;
    const casesToOrder = editedOrderQtys.has(item.variation_id)
      ? editedOrderQtys.get(item.variation_id)
      : 1;
    const actualUnits = casesToOrder * casePack;
    manualCost += (actualUnits * (item.unit_cost_cents || 0)) / 100;
  }

  const totalItems = standaloneItems.length + bundleChildCount + manualCount;
  const totalCost = standaloneCost + bundleCost + manualCost;

  document.getElementById('selected-count').textContent = totalItems;
  document.getElementById('total-cost').textContent = '$' + totalCost.toFixed(2);

  // Manual count display
  const manualCountDisplay = document.getElementById('manual-count-display');
  const manualCountEl = document.getElementById('manual-count');
  if (manualCountDisplay && manualCountEl) {
    if (manualCount > 0) {
      manualCountDisplay.style.display = '';
      manualCountEl.textContent = manualCount;
    } else {
      manualCountDisplay.style.display = 'none';
    }
  }

  // Vendor minimum shortfall badge
  const shortfallBadge = document.getElementById('shortfall-badge');
  if (shortfallBadge && currentVendorMinimum > 0) {
    const totalCostCents = Math.round(totalCost * 100);
    const minimumCents = Math.round(currentVendorMinimum * 100);
    if (totalCostCents >= minimumCents) {
      shortfallBadge.style.display = '';
      shortfallBadge.className = 'shortfall-badge met';
      shortfallBadge.textContent = 'Minimum met';
    } else {
      const shortfall = ((minimumCents - totalCostCents) / 100).toFixed(2);
      shortfallBadge.style.display = '';
      shortfallBadge.className = 'shortfall-badge';
      shortfallBadge.textContent = '$' + shortfall + ' below minimum';
    }
  } else if (shortfallBadge) {
    shortfallBadge.style.display = 'none';
  }

  // Update vendor info bar running total
  updateVendorRunningTotal(totalCost);

  // Disable PO button if no items or below vendor minimum
  const createBtn = document.getElementById('create-po-btn');
  const belowMinimum = currentVendorMinimum > 0 && totalCost < currentVendorMinimum;
  createBtn.disabled = totalItems === 0 || belowMinimum;
  if (belowMinimum && totalItems > 0) {
    createBtn.title = 'Order total is below vendor minimum ($' + currentVendorMinimum.toFixed(2) + ')';
  } else {
    createBtn.title = '';
  }
}

async function createPurchaseOrder() {
  // Standalone items (non-bundle)
  const standaloneItems = allSuggestions.filter(s =>
    selectedItems.has(s.variation_id) && !bundleChildVariationIds.has(s.variation_id)
  );

  // Bundle child items - collect from all bundles
  const bundleChildItems = [];
  for (const bundle of bundleAnalysis) {
    for (const child of (bundle.children || [])) {
      const qty = getEffectiveBundleChildQty(child);
      if (qty > 0) {
        bundleChildItems.push({
          variation_id: child.variation_id,
          quantity_ordered: qty,
          unit_cost_cents: child.individual_cost_cents || 0
        });
      }
    }
  }

  // Aggregate bundle children that appear in multiple bundles
  const bundleItemMap = new Map();
  for (const item of bundleChildItems) {
    if (bundleItemMap.has(item.variation_id)) {
      const existing = bundleItemMap.get(item.variation_id);
      existing.quantity_ordered += item.quantity_ordered;
    } else {
      bundleItemMap.set(item.variation_id, { ...item });
    }
  }

  const hasBundleItems = bundleItemMap.size > 0;
  const hasStandaloneItems = standaloneItems.length > 0;

  if (!hasBundleItems && !hasStandaloneItems) {
    alert('Please select at least one item to create a purchase order.');
    return;
  }

  const vendorId = document.getElementById('vendor-select').value;
  if (!vendorId || vendorId === 'none') {
    alert('Please select a specific vendor to create a purchase order.');
    return;
  }

  // Check if all selected standalone items are from the same vendor
  if (hasStandaloneItems) {
    const vendors = new Set(standaloneItems.map(s => s.vendor_name));
    if (vendors.size > 1) {
      alert('Selected items are from multiple vendors. Please select items from a single vendor or filter by vendor first.');
      return;
    }
  }

  // Check for expiring items (standalone) and warn — uses API-loaded tier config
  const expiringItems = standaloneItems.filter(item => {
    const daysLeft = item.days_until_expiry;
    if (daysLeft === null) return false;
    const tier = getExpiryTierFromDays(daysLeft);
    return tier === 'EXPIRED' || tier === 'AUTO50' || tier === 'AUTO25';
  });

  if (expiringItems.length > 0) {
    const expiredCount = expiringItems.filter(i => getExpiryTierFromDays(i.days_until_expiry) === 'EXPIRED').length;
    const auto50Count = expiringItems.filter(i => getExpiryTierFromDays(i.days_until_expiry) === 'AUTO50').length;
    const auto25Count = expiringItems.filter(i => getExpiryTierFromDays(i.days_until_expiry) === 'AUTO25').length;

    let warningMessage = `⚠️ WARNING: You are about to create a PO with ${expiringItems.length} expiring item(s):\n\n`;
    if (expiredCount > 0) warningMessage += `• ${expiredCount} EXPIRED item(s) - should be pulled from shelves\n`;
    if (auto50Count > 0) warningMessage += `• ${auto50Count} item(s) on clearance sale\n`;
    if (auto25Count > 0) warningMessage += `• ${auto25Count} item(s) with discount applied\n`;
    warningMessage += '\n📋 IMPORTANT: Expiry dates and discounts will be REMOVED for these items when the PO is created.\n';
    warningMessage += 'Remember to enter new expiry dates after receiving the stock.\n';
    warningMessage += '\nAre you sure you want to proceed?';

    if (!confirm(warningMessage)) {
      return;
    }
  }

  // Get the selected location from the dropdown
  const locationId = document.getElementById('location-select').value;
  if (!locationId) {
    alert('Please select a location from the dropdown above before creating a purchase order.');
    return;
  }

  const supplyDays = parseInt(document.getElementById('supply-days').value);

  // Build standalone item entries
  const standaloneEntries = standaloneItems.map(item => {
    const casePack = item.case_pack_quantity || 1;
    let casesToOrder;

    if (editedOrderQtys.has(item.variation_id)) {
      casesToOrder = editedOrderQtys.get(item.variation_id);
    } else {
      let suggestedQty = item.final_suggested_qty;
      if (item.stock_alert_max && item.stock_alert_max > 0) {
        const projectedStock = item.current_stock + suggestedQty;
        if (projectedStock > item.stock_alert_max) {
          suggestedQty = Math.max(0, item.stock_alert_max - item.current_stock);
        }
      }
      casesToOrder = suggestedQty > 0 ? Math.ceil(suggestedQty / casePack) : 0;
    }

    const actualUnits = casesToOrder * casePack;

    return {
      variation_id: item.variation_id,
      quantity_ordered: actualUnits,
      unit_cost_cents: item.unit_cost_cents
    };
  }).filter(item => item.quantity_ordered > 0);

  // Build manual item entries
  const manualEntries = manualItems.map(item => {
    const casePack = item.case_pack_quantity || 1;
    const casesToOrder = editedOrderQtys.has(item.variation_id)
      ? editedOrderQtys.get(item.variation_id)
      : 1;
    const actualUnits = casesToOrder * casePack;
    return {
      variation_id: item.variation_id,
      quantity_ordered: actualUnits,
      unit_cost_cents: item.unit_cost_cents || 0
    };
  }).filter(item => item.quantity_ordered > 0);

  // Merge standalone + bundle + manual items, aggregating duplicates
  const mergedMap = new Map();
  for (const item of standaloneEntries) {
    mergedMap.set(item.variation_id, { ...item });
  }
  for (const [vid, item] of bundleItemMap) {
    if (mergedMap.has(vid)) {
      mergedMap.get(vid).quantity_ordered += item.quantity_ordered;
    } else {
      mergedMap.set(vid, { ...item });
    }
  }
  for (const item of manualEntries) {
    if (mergedMap.has(item.variation_id)) {
      mergedMap.get(item.variation_id).quantity_ordered += item.quantity_ordered;
    } else {
      mergedMap.set(item.variation_id, { ...item });
    }
  }

  const items = Array.from(mergedMap.values()).filter(item => item.quantity_ordered > 0);

  if (items.length === 0) {
    alert('No items to order. All items have zero quantity.');
    return;
  }

  const bundleCount = bundleItemMap.size;
  const standaloneCount = standaloneEntries.filter(i => i.quantity_ordered > 0).length;
  const manualEntryCount = manualEntries.filter(i => i.quantity_ordered > 0).length;
  const noteParts = [];
  if (standaloneCount > 0) noteParts.push(`${standaloneCount} standalone`);
  if (bundleCount > 0) noteParts.push(`${bundleCount} bundle components`);
  if (manualEntryCount > 0) noteParts.push(`${manualEntryCount} manual`);

  const poData = {
    vendor_id: vendorId,
    location_id: locationId,
    supply_days_override: supplyDays,
    items: items,
    notes: `Auto-generated from reorder suggestions (${noteParts.join(' + ')}, ${items.length} total lines)`,
    created_by: 'Reorder System'
  };

  const btn = document.getElementById('create-po-btn');
  btn.disabled = true;
  btn.textContent = 'Creating PO...';

  try {
    const response = await fetch('/api/purchase-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(poData)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to create purchase order');
    }

    const result = await response.json();
    const po = result.data?.purchase_order || result.purchase_order;
    const clearedItems = result.data?.expiry_discounts_cleared || [];

    // Build success message
    let successMessage = `Purchase Order ${po.po_number} created successfully!\nTotal: $${(po.total_cents / 100).toFixed(2)}`;

    // If expiry discounts were cleared, show which items
    if (clearedItems.length > 0) {
      successMessage += `\n\n📋 Expiry discounts cleared for ${clearedItems.length} item(s):`;
      clearedItems.forEach(item => {
        const name = item.variation_name
          ? `${item.item_name} - ${item.variation_name}`
          : item.item_name;
        successMessage += `\n• ${name} (was ${item.previous_tier})`;
      });
      successMessage += '\n\n⚠️ Remember to enter new expiry dates after receiving the stock.';
    }

    alert(successMessage);

    // Reset selections and edited quantities
    selectedItems.clear();
    editedOrderQtys.clear();
    editedBundleChildQtys.clear();
    // Return manual items to "other" pool and clear
    for (const item of manualItems) {
      otherVendorItems.push(item);
    }
    manualItems = [];
    document.getElementById('select-all').checked = false;
    renderTable();
    renderOtherItemsSection();
    updateFooter();

  } catch (error) {
    console.error('Failed to create PO:', error);
    const friendlyMsg = window.ErrorHelper
      ? ErrorHelper.getFriendlyMessage(error, 'orders', 'create')
      : 'Unable to create purchase order. Please check your selection and try again.';
    alert(friendlyMsg);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Purchase Order';
  }
}

// Click-to-sort functionality
let currentSortField = null;
let sortDirections = {}; // Track direction for each field

// Parameter order: (element, event, param) to match PageActions convention
// param is the field name from data-action-param
function sortTable(element, event, param) {
  const field = param;
  // Toggle sort direction
  sortDirections[field] = !sortDirections[field];
  const ascending = sortDirections[field];

  // Update current sort field
  currentSortField = field;

  // Clear all sort indicators
  document.querySelectorAll('.sort-indicator').forEach(el => {
    el.className = 'sort-indicator';
  });

  // Set current indicator
  const indicator = document.getElementById(`sort-${field}`);
  if (indicator) {
    indicator.className = `sort-indicator ${ascending ? 'asc' : 'desc'}`;
  }

  // Sort the data
  allSuggestions.sort((a, b) => {
    let aVal = a[field];
    let bVal = b[field];

    // Handle special cases
    switch(field) {
      case 'priority':
        // Priority order: URGENT=4, HIGH=3, MEDIUM=2, LOW=1
        const priorityOrder = { URGENT: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
        aVal = priorityOrder[a.priority] || 0;
        bVal = priorityOrder[b.priority] || 0;
        break;

      case 'item_name':
      case 'vendor_name':
      case 'sku':
      case 'vendor_code':
        // String comparison (case-insensitive)
        aVal = (aVal || '').toString().toLowerCase();
        bVal = (bVal || '').toString().toLowerCase();
        break;

      case 'current_stock':
      case 'stock_alert_min':
      case 'days_until_stockout':
      case 'days_until_expiry':
      case 'daily_avg_quantity':
      case 'weekly_avg_91d':
      case 'weekly_avg_182d':
      case 'weekly_avg_365d':
      case 'final_suggested_qty':
      case 'case_pack_quantity':
      case 'unit_cost_cents':
      case 'retail_price_cents':
      case 'gross_margin_percent':
      case 'order_cost':
        // Numeric comparison (handle null/undefined, put nulls at end)
        aVal = aVal !== null && aVal !== undefined ? parseFloat(aVal) : Infinity;
        bVal = bVal !== null && bVal !== undefined ? parseFloat(bVal) : Infinity;
        break;
    }

    // Compare values
    if (aVal === bVal) return 0;

    if (ascending) {
      return aVal > bVal ? 1 : -1;
    } else {
      return aVal < bVal ? 1 : -1;
    }
  });

  // Re-render table with sorted data
  renderTable();
  updateFooter();
  saveReorderState();
}

// Save editable field to database
async function saveField(input) {
  const variationId = input.dataset.variationId;
  const field = input.dataset.field;
  const value = input.value.trim();

  // Don't save if value is empty or unchanged
  const item = allSuggestions.find(s => s.variation_id === variationId);
  if (!item) return;

  const currentValue = item[field];
  const newValue = value === '' ? null : parseInt(value, 10);

  // Check if value actually changed
  if (currentValue === newValue || (currentValue == null && newValue == null)) {
    return;
  }

  // Validate
  if (value !== '' && (isNaN(newValue) || newValue < 0)) {
    input.classList.add('error');
    setTimeout(() => input.classList.remove('error'), 2000);
    input.value = currentValue || '';
    return;
  }

  // Show saving state
  input.classList.add('saving');
  input.disabled = true;

  try {
    const response = await fetch(`/api/variations/${variationId}/extended`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        [field]: newValue
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Update local data
    item[field] = newValue;

    // If we updated stock_alert_max or case_pack_quantity, re-render to recalculate order quantities
    if (field === 'stock_alert_max' || field === 'case_pack_quantity') {
      renderTable();
      updateFooter();
    }

    // Show success state
    input.classList.remove('saving');
    input.classList.add('saved');
    setTimeout(() => input.classList.remove('saved'), 2000);

    // Show toast notification
    const fieldLabels = {
      case_pack_quantity: 'Case pack',
      stock_alert_max: 'Max stock'
    };
    const label = fieldLabels[field] || field;
    showToast(`${label} updated to ${newValue}`, 'success');

  } catch (error) {
    console.error('Failed to save field:', error);
    input.classList.remove('saving');
    input.classList.add('error');
    setTimeout(() => input.classList.remove('error'), 2000);

    // Revert to original value
    input.value = currentValue || '';
    showToast(`Failed to save ${field}: ${error.message}`, 'error');
  } finally {
    input.disabled = false;
  }
}

// Save unit cost and push to Square
async function saveCost(input) {
  const variationId = input.dataset.variationId;
  const vendorId = input.dataset.vendorId;
  const originalValue = parseFloat(input.dataset.originalValue) || 0;
  const value = input.value.trim();

  // Convert dollars to cents
  const newValueDollars = parseFloat(value) || 0;
  const newValueCents = Math.round(newValueDollars * 100);

  // Check if value actually changed
  if (newValueCents === originalValue) {
    return;
  }

  // Validate
  if (newValueDollars < 0) {
    input.classList.add('error');
    setTimeout(() => input.classList.remove('error'), 2000);
    input.value = (originalValue / 100).toFixed(2);
    return;
  }

  // Show saving state
  input.classList.add('saving');
  input.disabled = true;

  try {
    const response = await fetch(`/api/variations/${variationId}/cost`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        cost_cents: newValueCents,
        vendor_id: vendorId || null
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));

      // Handle parent item not active at location
      if (errorData.code === 'ITEM_NOT_AT_LOCATION' && errorData.parent_item_id) {
        input.classList.remove('saving');
        input.disabled = false;

        const activate = confirm(
          'This product is not active at all store locations, which prevents cost updates.\n\n' +
          'Press OK to activate it at all locations and retry, or Cancel to discard the change.'
        );

        if (activate) {
          input.classList.add('saving');
          input.disabled = true;

          // Enable the parent item at all locations
          const enableResponse = await fetch('/api/catalog-audit/enable-item-at-locations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item_id: errorData.parent_item_id })
          });

          if (!enableResponse.ok) {
            const enableError = await enableResponse.json().catch(() => ({}));
            throw new Error(enableError.error || 'Failed to activate product at locations');
          }

          const enableResult = await enableResponse.json();
          if (typeof showToast === 'function') {
            showToast(`Activated "${enableResult.itemName}" at all locations`, 'success');
          }

          // Retry the cost update
          const retryResponse = await fetch(`/api/variations/${variationId}/cost`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cost_cents: newValueCents, vendor_id: vendorId || null })
          });

          if (!retryResponse.ok) {
            const retryError = await retryResponse.json().catch(() => ({}));
            throw new Error(retryError.error || `HTTP ${retryResponse.status}`);
          }

          // Use the retry result as our successful result
          const retryResult = await retryResponse.json();
          handleCostSaveSuccess(input, variationId, newValueCents, newValueDollars, retryResult);
          return;
        }

        // User cancelled - revert input
        input.value = (originalValue / 100).toFixed(2);
        return;
      }

      throw new Error(errorData.error || `HTTP ${response.status}`);
    }

    const result = await response.json();
    handleCostSaveSuccess(input, variationId, newValueCents, newValueDollars, result);

  } catch (error) {
    console.error('Failed to save cost:', error);
    input.classList.remove('saving');
    input.classList.add('error');
    setTimeout(() => input.classList.remove('error'), 2000);

    // Revert to original value
    input.value = (originalValue / 100).toFixed(2);

    const friendlyMsg = window.ErrorHelper
      ? ErrorHelper.getFriendlyMessage(error)
      : 'Failed to update cost. Please try again.';
    alert(friendlyMsg);
  } finally {
    input.disabled = false;
  }
}

// Handle successful cost save (shared between initial save and retry after location fix)
function handleCostSaveSuccess(input, variationId, newValueCents, newValueDollars, result) {
    // Update local data
    const item = allSuggestions.find(s => s.variation_id === variationId);
    if (item) {
      item.unit_cost_cents = newValueCents;
    }

    // Update the original value data attribute
    input.dataset.originalValue = newValueCents;

    // Re-render to update total cost column
    renderTable();
    updateFooter();

    // Show success feedback
    const updatedInput = document.querySelector(`input[data-variation-id="${variationId}"][data-field="unit_cost_cents"]`);
    if (updatedInput) {
      updatedInput.classList.add('saved');
      setTimeout(() => updatedInput.classList.remove('saved'), 2000);
    }

    // Show toast notification based on whether it synced to Square
    if (typeof showToast === 'function') {
      if (result.synced_to_square) {
        showToast(`Cost updated to $${newValueDollars.toFixed(2)} and synced to Square`, 'success');
      } else {
        showToast(`Cost updated locally. ${result.warning || 'Not synced to Square.'}`, 'warning');
      }
    }

    // Remove saving state
    input.classList.remove('saving');
}

// Update order quantity (cases) when user edits
function updateOrderQty(input) {
  const variationId = input.dataset.variationId;
  const value = input.value.trim();
  const suggestedQty = parseInt(input.dataset.suggested, 10) || 0;

  const item = allSuggestions.find(s => s.variation_id === variationId);
  if (!item) return;

  const casePack = item.case_pack_quantity || 1;

  if (value === '' || parseInt(value, 10) === suggestedQty) {
    // Revert to suggested - remove from edited map
    editedOrderQtys.delete(variationId);
    input.value = suggestedQty;
    input.classList.remove('saved');
  } else {
    const newCases = parseInt(value, 10);
    if (isNaN(newCases) || newCases < 0) {
      input.value = editedOrderQtys.get(variationId) || suggestedQty;
      return;
    }
    editedOrderQtys.set(variationId, newCases);
    input.classList.add('saved');
    setTimeout(() => input.classList.remove('saved'), 1500);
  }

  // Update units display
  const finalCases = editedOrderQtys.has(variationId) ? editedOrderQtys.get(variationId) : suggestedQty;
  const actualUnits = finalCases * casePack;
  const unitsEl = document.getElementById(`units-${variationId}`);
  if (unitsEl) {
    unitsEl.textContent = `(${actualUnits} units)`;
    if (editedOrderQtys.has(variationId)) {
      unitsEl.style.color = '#059669';
      unitsEl.style.fontWeight = '600';
    } else {
      unitsEl.style.color = '#6b7280';
      unitsEl.style.fontWeight = 'normal';
    }
  }

  // Update line item total
  const lineTotalEl = document.getElementById(`line-total-${variationId}`);
  if (lineTotalEl) {
    const lineTotal = (actualUnits * item.unit_cost_cents / 100).toFixed(2);
    lineTotalEl.innerHTML = `<strong>$${lineTotal}</strong>`;
  }

  // Update footer totals
  updateFooter();
}

// Enter edit mode for stock maximum field (implementation)
function enterEditModeImpl(displayElement, variationId, field, currentValue) {
  // Create input element
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'editable-input';
  input.value = currentValue === null || currentValue === '' ? '' : currentValue;
  input.placeholder = '∞';
  input.min = '0';
  input.dataset.variationId = variationId;
  input.dataset.field = field;

  // Save on blur
  input.addEventListener('blur', function() {
    exitEditMode(this, true);
  });
  // Handle Enter/Escape keys
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      this.blur();
    } else if (e.key === 'Escape') {
      exitEditMode(this, false);
    }
  });

  // Replace display with input
  const cell = displayElement.parentElement;
  cell.innerHTML = '';
  cell.appendChild(input);
  input.focus();
  input.select();
}

// Exit edit mode and optionally save
async function exitEditMode(input, save) {
  const variationId = input.dataset.variationId;
  const field = input.dataset.field;
  const value = input.value.trim();

  const item = allSuggestions.find(s => s.variation_id === variationId);
  if (!item) return;

  const currentValue = item[field];
  const newValue = value === '' ? null : parseInt(value, 10);

  // If saving and value changed, save it
  if (save && currentValue !== newValue) {
    // Validate
    if (value !== '' && (isNaN(newValue) || newValue < 0)) {
      alert('Please enter a valid positive number or leave empty for unlimited.');
      recreateDisplay(input.parentElement, variationId, field, currentValue);
      return;
    }

    // Show saving state
    input.classList.add('saving');
    input.disabled = true;

    try {
      let response;

      // Use different endpoint for min stock (syncs to Square)
      if (field === 'stock_alert_min') {
        // Check if a save is already in progress for this variation
        if (pendingMinStockSaves.has(variationId)) {
          showToast('Please wait - previous save still in progress', 'warning');
          recreateDisplay(input.parentElement, variationId, field, currentValue);
          return;
        }

        // Mark this variation as having a pending save
        pendingMinStockSaves.set(variationId, true);

        try {
          // Include location_id for location-specific min stock
          const locationId = document.getElementById('location-select').value;
          response = await fetch(`/api/variations/${variationId}/min-stock`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              min_stock: newValue,
              location_id: locationId || null
            })
          });
        } finally {
          // Clear the pending state after request completes
          pendingMinStockSaves.delete(variationId);
        }
      } else {
        response = await fetch(`/api/variations/${variationId}/extended`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            [field]: newValue
          })
        });
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
      }

      // Update local data
      item[field] = newValue;

      // For stock_alert_min, also recalculate priority locally if now below minimum
      if (field === 'stock_alert_min' && newValue !== null) {
        const availableQty = item.available_quantity || 0;
        if (availableQty <= newValue) {
          item.below_minimum = true;
          // Upgrade priority if currently lower than MEDIUM
          const priorityOrder = { LOW: 1, MEDIUM: 2, HIGH: 3, URGENT: 4 };
          if (priorityOrder[item.priority] < priorityOrder['MEDIUM']) {
            item.priority = 'MEDIUM';
          }
        } else {
          item.below_minimum = false;
        }
      }

      // Re-render table (preserves editedOrderQtys and selectedItems)
      renderTable();
      updateFooter();

      // Show success toast - different message for min stock
      if (field === 'stock_alert_min') {
        showToast('Min stock updated and synced to Square!', 'success');
        // NOTE: We intentionally do NOT call getSuggestions() here to preserve PO edits
        // Suggested quantities are unchanged - user can refresh page for full recalculation
      }

    } catch (error) {
      console.error('Failed to save field:', error);
      alert(`Failed to save ${field}: ${error.message}`);
      recreateDisplay(input.parentElement, variationId, field, currentValue);
    }
  } else {
    // Not saving or no change, just recreate display
    recreateDisplay(input.parentElement, variationId, field, currentValue);
  }
}

// Recreate the display element
function recreateDisplay(cell, variationId, field, value) {
  const displayDiv = document.createElement('div');
  displayDiv.className = `editable-display ${value ? 'has-value' : ''}`;
  // Use data attributes for event delegation (CSP compliant)
  displayDiv.dataset.action = 'enterEditMode';
  displayDiv.dataset.variationId = variationId;
  displayDiv.dataset.field = field;
  displayDiv.dataset.value = value === null ? '' : value;
  displayDiv.title = 'Click to edit - syncs to Square';

  if (value) {
    displayDiv.textContent = value;
  } else {
    displayDiv.innerHTML = '<span class="infinity-symbol">∞</span>';
  }

  cell.innerHTML = '';
  cell.appendChild(displayDiv);
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


// ==================== VENDOR-FIRST WORKFLOW ====================

// Handle vendor dropdown change (Feature 1)
function onVendorChange() {
  const vendorId = document.getElementById('vendor-select').value;
  // Save vendor selection to sessionStorage
  saveReorderState();
  // Update vendor info bar (Feature 2)
  updateVendorInfoBar(vendorId);
  // Reset manual items on vendor change
  manualItems = [];
  otherVendorItems = [];
  otherItemsExpanded = false;
  // Fetch data or show prompt
  getSuggestions();
}

// Show the "Select vendor" prompt, hide table
function showVendorPrompt() {
  document.getElementById('vendor-prompt').style.display = '';
  document.getElementById('table-container').style.display = 'none';
  document.getElementById('other-items-section').style.display = 'none';
  document.getElementById('vendor-info-bar').style.display = 'none';
  currentVendorMinimum = 0;
  manualItems = [];
  otherVendorItems = [];
  allSuggestions = [];
  bundleAnalysis = [];
  updateFooter();
}

// Hide the prompt, show table
function hideVendorPrompt() {
  document.getElementById('vendor-prompt').style.display = 'none';
  document.getElementById('table-container').style.display = '';
}

// ==================== VENDOR INFO BAR (Feature 2) ====================

function updateVendorInfoBar(vendorId) {
  const bar = document.getElementById('vendor-info-bar');
  if (!vendorId || vendorId === '' || vendorId === '__none__' || vendorId === 'none') {
    bar.style.display = 'none';
    currentVendorMinimum = 0;
    return;
  }

  const vendor = vendorRecords.find(v => v.id === vendorId);
  if (!vendor) {
    bar.style.display = 'none';
    currentVendorMinimum = 0;
    return;
  }

  // Check if vendor has any info to show
  const hasOrderDay = vendor.order_day;
  const hasReceiveDay = vendor.receive_day;
  const hasLeadTime = vendor.lead_time_days != null && vendor.lead_time_days > 0;
  const hasMinimum = vendor.minimum_order_amount != null && vendor.minimum_order_amount > 0;

  if (!hasOrderDay && !hasReceiveDay && !hasLeadTime && !hasMinimum) {
    bar.style.display = 'none';
    currentVendorMinimum = 0;
    return;
  }

  bar.style.display = '';
  currentVendorMinimum = hasMinimum ? parseFloat(vendor.minimum_order_amount) : 0;

  // Update individual info items
  const orderDayEl = document.getElementById('vendor-info-order-day');
  if (hasOrderDay) {
    orderDayEl.style.display = '';
    orderDayEl.querySelector('.vendor-info-value').textContent = capitalizeFirst(vendor.order_day);
  } else {
    orderDayEl.style.display = 'none';
  }

  const receiveDayEl = document.getElementById('vendor-info-receive-day');
  if (hasReceiveDay) {
    receiveDayEl.style.display = '';
    receiveDayEl.querySelector('.vendor-info-value').textContent = capitalizeFirst(vendor.receive_day);
  } else {
    receiveDayEl.style.display = 'none';
  }

  const leadTimeEl = document.getElementById('vendor-info-lead-time');
  if (hasLeadTime) {
    leadTimeEl.style.display = '';
    leadTimeEl.querySelector('.vendor-info-value').textContent = vendor.lead_time_days + ' days';
  } else {
    leadTimeEl.style.display = 'none';
  }

  const minimumEl = document.getElementById('vendor-info-minimum');
  if (hasMinimum) {
    minimumEl.style.display = '';
    minimumEl.querySelector('.vendor-info-value').textContent =
      '$' + parseFloat(vendor.minimum_order_amount).toFixed(2);
  } else {
    minimumEl.style.display = 'none';
  }

  // Show running total section only when minimum exists
  const runningTotalEl = document.getElementById('vendor-info-running-total');
  runningTotalEl.style.display = hasMinimum ? '' : 'none';
}

function updateVendorRunningTotal(totalCost) {
  const statusEl = document.getElementById('vendor-minimum-status');
  if (!statusEl || currentVendorMinimum <= 0) return;

  const runningTotalEl = document.getElementById('vendor-info-running-total');
  if (runningTotalEl) runningTotalEl.style.display = '';

  if (totalCost >= currentVendorMinimum) {
    statusEl.className = 'vendor-minimum-met';
    statusEl.textContent = '$' + totalCost.toFixed(2) + ' / $' +
      currentVendorMinimum.toFixed(2) + ' minimum met';
  } else {
    const shortfall = (currentVendorMinimum - totalCost).toFixed(2);
    statusEl.className = 'vendor-minimum-short';
    statusEl.textContent = '$' + totalCost.toFixed(2) + ' / $' +
      currentVendorMinimum.toFixed(2) + ' — $' + shortfall + ' short';
  }
}

function capitalizeFirst(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

// ==================== OTHER VENDOR ITEMS SECTION (Feature 3) ====================

function renderOtherItemsSection() {
  const section = document.getElementById('other-items-section');
  const vendorId = document.getElementById('vendor-select').value;

  // Only show for specific vendor selection (not All Vendors or No Vendor)
  if (!vendorId || vendorId === '' || vendorId === '__none__' || vendorId === 'none') {
    section.style.display = 'none';
    return;
  }

  // Filter out items already in manual list
  const manualIds = new Set(manualItems.map(m => m.variation_id));
  const availableOther = otherVendorItems.filter(i => !manualIds.has(i.variation_id));

  const vendor = vendorRecords.find(v => v.id === vendorId);
  const vendorName = vendor ? vendor.name : 'Vendor';

  section.style.display = '';
  document.getElementById('other-items-title').textContent =
    'All Other ' + escapeHtml(vendorName) + ' Items (' + availableOther.length + ')';

  const toggle = document.getElementById('other-items-toggle');
  const body = document.getElementById('other-items-body');
  toggle.innerHTML = otherItemsExpanded ? '&#9660;' : '&#9654;';
  body.style.display = otherItemsExpanded ? '' : 'none';

  const tbody = document.getElementById('other-items-tbody');

  if (availableOther.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" class="other-items-empty">All items added to order</td></tr>';
    return;
  }

  tbody.innerHTML = availableOther.map(item => {
    const daysText = item.days_until_stockout < 999 ? item.days_until_stockout.toFixed(1) : '-';
    const daysClass = item.days_until_stockout === 0 ? 'days-critical' :
      item.days_until_stockout < 7 ? 'days-critical' :
      item.days_until_stockout < 14 ? 'days-warning' : 'days-ok';
    const velocity = item.weekly_avg_91d ? item.weekly_avg_91d.toFixed(2) + '/wk' : '-';
    const cost = item.unit_cost_cents ? '$' + (item.unit_cost_cents / 100).toFixed(2) : '-';
    const retail = item.retail_price_cents ? '$' + (item.retail_price_cents / 100).toFixed(2) : '-';
    const margin = item.gross_margin_percent != null ? item.gross_margin_percent.toFixed(1) + '%' : '-';

    return `
      <tr data-variation-id="${item.variation_id}">
        <td>
          <button class="add-item-btn" data-action="addManualItem" data-action-param="${item.variation_id}">+ Add</button>
        </td>
        <td>
          <div class="product-name">${escapeHtml(item.item_name)}</div>
          ${item.variation_name ? '<div class="variation-name">' + escapeHtml(item.variation_name) + '</div>' : ''}
        </td>
        <td class="sku">${escapeHtml(item.sku || '-')}</td>
        <td class="text-right">${item.committed_quantity > 0 ? item.available_quantity : item.current_stock}</td>
        <td class="text-right">${item.stock_alert_min > 0 ? item.stock_alert_min : '-'}</td>
        <td class="text-right ${daysClass}">${daysText}</td>
        <td class="text-right">${velocity}</td>
        <td class="text-right">${cost}</td>
        <td class="text-right">${retail}</td>
        <td class="text-right">${margin}</td>
        <td class="text-right">${item.case_pack_quantity > 1 ? item.case_pack_quantity : '-'}</td>
        <td>${escapeHtml(item.vendor_code || '-')}</td>
      </tr>`;
  }).join('');
}

function toggleOtherItems() {
  otherItemsExpanded = !otherItemsExpanded;
  renderOtherItemsSection();
}

// ==================== MANUAL ITEM ADDITION (Feature 4) ====================

function addManualItem(element, event, variationId) {
  // Find item in otherVendorItems
  const itemIndex = otherVendorItems.findIndex(i => i.variation_id === variationId);
  if (itemIndex === -1) return;

  const item = otherVendorItems[itemIndex];

  // Add to manual items with default 1 case
  manualItems.push({
    ...item,
    priority: 'MANUAL',
    final_suggested_qty: item.case_pack_quantity || 1,
    has_velocity: item.weekly_avg_91d > 0
  });

  // Set default order qty to 1 case
  editedOrderQtys.set(variationId, 1);

  // Re-render both sections
  renderTable();
  renderOtherItemsSection();
  updateFooter();

  showToast('Item added to order', 'success');
}

function removeManualItem(element, event, variationId) {
  // Remove from manual items
  const idx = manualItems.findIndex(m => m.variation_id === variationId);
  if (idx === -1) return;

  manualItems.splice(idx, 1);
  editedOrderQtys.delete(variationId);

  // Re-render both sections
  renderTable();
  renderOtherItemsSection();
  updateFooter();

  showToast('Item removed from order', 'success');
}

// Render a single manual item row in the main table
function renderManualItemRow(item) {
  const casePack = item.case_pack_quantity || 1;
  const casesToOrder = editedOrderQtys.has(item.variation_id)
    ? editedOrderQtys.get(item.variation_id)
    : 1;
  const actualUnits = casesToOrder * casePack;
  const totalCost = (actualUnits * (item.unit_cost_cents || 0) / 100).toFixed(2);

  const daysText = item.days_until_stockout < 999
    ? item.days_until_stockout.toFixed(1) : '∞';
  const daysClass = item.days_until_stockout === 0 ? 'days-critical' :
    item.days_until_stockout < 7 ? 'days-critical' :
    item.days_until_stockout < 14 ? 'days-warning' : 'days-ok';

  const velocity = item.weekly_avg_91d ? item.weekly_avg_91d.toFixed(2) : 'No data';

  const margin = item.gross_margin_percent != null ? item.gross_margin_percent.toFixed(1) + '%' : '-';
  const marginClass = item.gross_margin_percent != null
    ? (item.gross_margin_percent >= 40 ? 'velocity-fast' :
       item.gross_margin_percent >= 20 ? 'velocity-moderate' : 'days-critical')
    : '';

  return `
    <tr class="manual-row selected" data-id="${item.variation_id}" data-manual="true">
      <td class="text-center">
        <input type="checkbox" checked disabled title="Manual item (use × to remove)">
      </td>
      <td>
        <span class="priority-badge priority-MANUAL">MANUAL</span>
        <span class="manual-remove-btn" data-action="removeManualItem" data-action-param="${item.variation_id}" title="Remove from order">&times;</span>
      </td>
      <td><div class="no-image">📦</div></td>
      <td>
        <div class="product-name">${escapeHtml(item.item_name)}</div>
        ${item.variation_name ? '<div class="variation-name">' + escapeHtml(item.variation_name) + '</div>' : ''}
      </td>
      <td class="sku">${escapeHtml(item.sku || '-')}</td>
      <td class="text-right">${item.committed_quantity > 0 ? item.available_quantity : item.current_stock}</td>
      <td class="text-right">${item.stock_alert_min > 0 ? item.stock_alert_min : '-'}</td>
      <td class="text-right">-</td>
      <td class="text-right ${daysClass}">${daysText}</td>
      <td class="text-right">-</td>
      <td class="text-right"><small>${velocity}</small></td>
      <td class="text-right editable-cell">
        <input type="number"
               class="editable-input order-qty-input"
               value="${casesToOrder}"
               placeholder="1"
               min="0"
               data-field="order_qty"
               data-variation-id="${item.variation_id}"
               data-suggested="1"
               data-change="updateManualOrderQty"
               data-blur="updateManualOrderQty"
               data-keydown="blurOnEnter">
        <br><small style="color: #6b7280;" id="units-${item.variation_id}">(${actualUnits} units)</small>
      </td>
      <td class="text-right">${casePack > 1 ? casePack : '-'}</td>
      <td class="text-right">${item.unit_cost_cents ? '$' + (item.unit_cost_cents / 100).toFixed(2) : '-'}</td>
      <td class="text-right">${item.retail_price_cents ? '$' + (item.retail_price_cents / 100).toFixed(2) : '-'}</td>
      <td class="text-right ${marginClass}">${margin}</td>
      <td class="text-right" id="line-total-${item.variation_id}"><strong>$${totalCost}</strong></td>
      <td>${escapeHtml(item.vendor_name || '')}</td>
      <td class="clickable" data-action="copyToClipboard" data-action-param="${escapeJsString(item.vendor_code || '')}" data-copy-label="Vendor Code" title="Click to copy Vendor Code">${escapeHtml(item.vendor_code || '-')}</td>
      <td class="text-right">-</td>
    </tr>`;
}

// Update manual item order quantity
function updateManualOrderQty(input) {
  const variationId = input.dataset.variationId;
  const value = input.value.trim();

  if (value === '' || parseInt(value, 10) === 1) {
    editedOrderQtys.set(variationId, 1);
    input.value = 1;
  } else {
    const newCases = parseInt(value, 10);
    if (isNaN(newCases) || newCases < 0) {
      input.value = editedOrderQtys.get(variationId) || 1;
      return;
    }
    editedOrderQtys.set(variationId, newCases);
  }

  // Update units display
  const item = manualItems.find(m => m.variation_id === variationId);
  if (!item) return;

  const casePack = item.case_pack_quantity || 1;
  const finalCases = editedOrderQtys.get(variationId) || 1;
  const actualUnits = finalCases * casePack;
  const unitsEl = document.getElementById('units-' + variationId);
  if (unitsEl) unitsEl.textContent = '(' + actualUnits + ' units)';

  // Update line total
  const lineTotalEl = document.getElementById('line-total-' + variationId);
  if (lineTotalEl) {
    const lineTotal = (actualUnits * (item.unit_cost_cents || 0) / 100).toFixed(2);
    lineTotalEl.innerHTML = '<strong>$' + lineTotal + '</strong>';
  }

  updateFooter();
}

// ==================== STATE PRESERVATION (Feature 5) ====================

function getReorderState() {
  try {
    const raw = sessionStorage.getItem('reorderState');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveReorderState() {
  try {
    const state = {
      vendorId: document.getElementById('vendor-select').value,
      supplyDays: document.getElementById('supply-days').value,
      sortField: currentSortField,
      sortDirections: sortDirections,
      scrollTop: document.getElementById('table-container')?.scrollTop || 0
    };
    sessionStorage.setItem('reorderState', JSON.stringify(state));
  } catch {
    // Ignore storage errors
  }
}

function restoreReorderState() {
  const state = getReorderState();
  if (!state) return false;

  // Restore supply days
  if (state.supplyDays) {
    document.getElementById('supply-days').value = state.supplyDays;
  }

  // Restore sort state
  if (state.sortField) {
    currentSortField = state.sortField;
  }
  if (state.sortDirections) {
    Object.assign(sortDirections, state.sortDirections);
  }

  // Restore scroll position after render
  if (state.scrollTop) {
    setTimeout(() => {
      const container = document.getElementById('table-container');
      if (container) container.scrollTop = state.scrollTop;
    }, 100);
  }

  return !!state.vendorId && state.vendorId !== '__none__';
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

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  await loadExpiryTierConfig();
  await loadLocations();
  await loadVendors();
  // Restore state before first fetch
  const hasVendor = restoreReorderState();
  if (hasVendor) {
    // Vendor was previously selected — update info bar and fetch
    const vendorId = document.getElementById('vendor-select').value;
    updateVendorInfoBar(vendorId);
    await getSuggestions();
  } else {
    // No vendor selected — show prompt (vendor-first workflow)
    showVendorPrompt();
  }
});

// Re-sort and re-render when sort option changes
document.getElementById('sort-by').addEventListener('change', () => {
  if (allSuggestions.length > 0) {
    sortSuggestions();
    renderTable();
  }
  saveReorderState();
});

// Save state when supply days changes
document.getElementById('supply-days').addEventListener('change', () => {
  saveReorderState();
});

// Save scroll position on scroll
document.getElementById('table-container').addEventListener('scroll', () => {
  saveReorderState();
});

// Expose functions to global scope for event delegation
window.sortTable = sortTable;
window.createPurchaseOrder = createPurchaseOrder;
window.copyToClipboard = copyToClipboard;
window.enterEditMode = enterEditMode;
window.blurOnEnter = blurOnEnter;
window.updateOrderQty = updateOrderQty;
window.saveField = saveField;
window.saveCost = saveCost;
window.getSuggestions = getSuggestions;
window.toggleSelectAllFromCheckbox = toggleSelectAllFromCheckbox;
window.toggleItemFromCheckbox = toggleItemFromCheckbox;
// Bundle functions
window.toggleBundleExpand = toggleBundleExpand;
window.updateBundleChildQty = updateBundleChildQty;
// Vendor-first workflow functions
window.onVendorChange = onVendorChange;
window.toggleOtherItems = toggleOtherItems;
window.addManualItem = addManualItem;
window.removeManualItem = removeManualItem;
window.updateManualOrderQty = updateManualOrderQty;
