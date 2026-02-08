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
// Track selected bundle options: { bundleId: 'optimized'|'all_bundles'|'all_individual' }
const selectedBundleOptions = new Map();
// Track user-edited bundle quantities: bundleId -> qty
const editedBundleQtys = new Map();

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
    const select = document.getElementById('vendor-select');

    select.innerHTML = '<option value="">All Vendors</option>';
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

  let url = `/api/reorder-suggestions?supply_days=${supplyDays}`;
  if (locationId) url += `&location_id=${locationId}`;
  if (vendorId) url += `&vendor_id=${vendorId}`;

  const tbody = document.getElementById('suggestions-body');
  tbody.innerHTML = '<tr><td colspan="19" class="loading">Loading suggestions...</td></tr>';

  try {
    const response = await fetch(url);
    const data = await response.json();

    allSuggestions = data.suggestions || [];
    bundleAnalysis = data.bundle_analysis || [];
    bundleAffiliations = data.bundle_affiliations || {};
    // Default all items to selected, clear any edited quantities
    selectedItems.clear();
    editedOrderQtys.clear();
    allSuggestions.forEach(item => selectedItems.add(item.variation_id));
    document.getElementById('select-all').checked = true;
    // Default all bundles to expanded, default option to optimized
    expandedBundles.clear();
    selectedBundleOptions.clear();
    editedBundleQtys.clear();
    bundleAnalysis.forEach(b => {
      expandedBundles.add(b.bundle_id);
      selectedBundleOptions.set(b.bundle_id, 'optimized');
    });

    if (allSuggestions.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="19" class="empty-state">
            <h3>No Reorder Suggestions</h3>
            <p>No items need reordering for the selected vendor and supply days.</p>
            <p>Try different filters or run a sync to update inventory data.</p>
          </td>
        </tr>
      `;
      updateFooter();
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

  } catch (error) {
    console.error('Failed to load suggestions:', error);
    const friendlyMsg = window.ErrorHelper
      ? ErrorHelper.getFriendlyMessage(error, 'inventory', 'load')
      : 'Unable to load reorder suggestions. Please refresh the page.';
    tbody.innerHTML = `<tr><td colspan="17" class="loading">${escapeHtml(friendlyMsg)}</td></tr>`;
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

function renderBundleRows() {
  if (bundleAnalysis.length === 0) return '';

  return bundleAnalysis.map(bundle => {
    const isExpanded = expandedBundles.has(bundle.bundle_id);
    const toggle = isExpanded ? '&#9660;' : '&#9654;';
    const selectedOption = selectedBundleOptions.get(bundle.bundle_id) || 'optimized';
    const opt = bundle.order_options || {};
    const optResult = opt.optimized || {};
    const daysText = bundle.days_of_bundle_stock < 999
      ? bundle.days_of_bundle_stock + 'd stock'
      : 'N/A';
    const bestCost = optResult.total_cost_cents
      ? '$' + (optResult.total_cost_cents / 100).toFixed(2)
      : '$0.00';

    // Parent row
    let html = `
      <tr class="bundle-parent-row" data-bundle-id="${bundle.bundle_id}">
        <td colspan="19" data-action="toggleBundleExpand" data-action-param="${bundle.bundle_id}">
          <span class="bundle-toggle">${toggle}</span>
          Bundle: ${escapeHtml(bundle.bundle_item_name)}
          | Assemblable: ${bundle.assemblable_qty}
          | ${daysText}
          | Best: ${bestCost}
          ${optResult.savings_pct > 0 ? ' (saves ' + optResult.savings_pct + '%)' : ''}
          | ${bundle.vendor_name ? escapeHtml(bundle.vendor_name) : 'No vendor'}
          ${bundle.bundle_vendor_code ? ' | <span class="clickable" data-action="copyToClipboard" data-action-param="' + escapeJsString(bundle.bundle_vendor_code) + '" data-copy-label="Bundle Vendor Code" title="Click to copy Bundle Vendor Code" style="font-family:monospace;background:rgba(255,255,255,0.3);padding:1px 6px;border-radius:3px;">Case: ' + escapeHtml(bundle.bundle_vendor_code) + '</span>' : ''}
        </td>
      </tr>`;

    if (isExpanded) {
      // Child rows
      const children = bundle.children || [];
      html += children.map(child => {
        const daysClass = child.days_of_stock === 0 ? 'days-critical' :
          child.days_of_stock < 7 ? 'days-critical' :
          child.days_of_stock < 14 ? 'days-warning' : 'days-ok';
        const daysStr = child.days_of_stock < 999 ? child.days_of_stock.toFixed(1) : '-';
        const costStr = child.individual_cost_cents
          ? '$' + (child.individual_cost_cents / 100).toFixed(2) : '-';

        const deletedClass = child.is_deleted ? ' bundle-child-deleted' : '';
        const deletedAlert = child.is_deleted
          ? '<br><span class="bundle-deleted-alert">DELETED VARIATION — Update bundle in Bundle Manager</span>'
          : '';

        return `
          <tr class="bundle-child-row${deletedClass}" data-bundle-id="${bundle.bundle_id}">
            <td></td>
            <td></td>
            <td></td>
            <td>
              <span class="bundle-child-label">|--</span>
              ${escapeHtml(child.child_item_name || '')}
              ${child.child_variation_name ? '<br><small style="color:#6b7280;">' + escapeHtml(child.child_variation_name) + '</small>' : ''}
              ${deletedAlert}
            </td>
            <td class="sku">${escapeHtml(child.child_sku || '-')}</td>
            <td class="text-right">${child.stock}</td>
            <td class="text-right">${child.stock_alert_min != null && child.stock_alert_min > 0 ? child.stock_alert_min : '-'}</td>
            <td class="text-right">-</td>
            <td class="text-right ${daysClass}">${daysStr}</td>
            <td class="text-right">-</td>
            <td class="text-right">
              <small>
                ${child.total_daily_velocity.toFixed(2)}/day
                <div class="bundle-velocity-split">
                  Ind: ${child.individual_daily_velocity.toFixed(2)} |
                  <span class="bundle-pct">Bundle: ${child.pct_from_bundles}%</span>
                </div>
              </small>
            </td>
            <td class="text-right">${child.individual_need}</td>
            <td class="text-right">x${child.quantity_in_bundle}/bundle</td>
            <td class="text-right">${costStr}</td>
            <td class="text-right">-</td>
            <td class="text-right">-</td>
            <td class="text-right">-</td>
            <td>-</td>
            <td class="clickable" data-action="copyToClipboard" data-action-param="${escapeJsString(child.vendor_code || '')}" data-copy-label="Vendor Code" title="Click to copy Vendor Code">${escapeHtml(child.vendor_code || '-')}</td>
          </tr>`;
      }).join('');

      // Options row
      const allInd = opt.all_individual || {};
      const allBun = opt.all_bundles || {};
      const optimized = opt.optimized || {};

      // Effective bundle qty (user-edited or preset)
      const effectiveQty = getEffectiveBundleQty(bundle);
      const effectiveCost = calculateBundleOptionClient(bundle, effectiveQty);
      const effectiveTotalSurplus = effectiveCost.surplus ? Object.values(effectiveCost.surplus).reduce((s, v) => s + v, 0) : 0;

      // Determine if current qty matches a preset
      const isOptimized = selectedOption === 'optimized' && effectiveQty === (optimized.bundle_qty || 0);
      const isAllBundles = selectedOption === 'all_bundles' && effectiveQty === (allBun.bundle_qty || 0);
      const isIndividual = selectedOption === 'all_individual' && effectiveQty === 0;

      html += `
        <tr class="bundle-options-row" data-bundle-id="${bundle.bundle_id}">
          <td colspan="19">
            <div class="order-options">
              <div class="bundle-qty-control">
                <label>Order:</label>
                <input type="number" class="bundle-qty-input" min="0" max="99"
                       value="${effectiveQty}"
                       data-change="updateBundleQty" data-blur="updateBundleQty"
                       data-bundle-id="${bundle.bundle_id}"
                       data-keydown="blurOnEnter">
                <span>bundle(s)</span>
                <span class="bundle-cost-summary">
                  &mdash; <strong>$${(effectiveCost.total_cost_cents / 100).toFixed(2)}</strong>
                  ${effectiveCost.topup_cost_cents > 0 ? ' (incl. $' + (effectiveCost.topup_cost_cents / 100).toFixed(2) + ' top-ups)' : ''}
                  ${effectiveTotalSurplus > 0 ? ' | surplus: ' + effectiveTotalSurplus + ' units' : ''}
                </span>
              </div>
              <div class="bundle-presets">
                <label class="order-option-sm ${isOptimized ? 'active' : ''}">
                  <input type="radio" name="bundle-${bundle.bundle_id}-opt" value="optimized"
                         ${selectedOption === 'optimized' ? 'checked' : ''}
                         data-change="selectBundleOption" data-bundle-id="${bundle.bundle_id}">
                  Optimized (${optimized.bundle_qty || 0} + top-up) $${((optimized.total_cost_cents || 0) / 100).toFixed(2)}
                  ${optimized.savings_pct > 0 ? '<strong>(saves ' + optimized.savings_pct + '%)</strong>' : ''}
                </label>
                <label class="order-option-sm ${isAllBundles ? 'active' : ''}">
                  <input type="radio" name="bundle-${bundle.bundle_id}-opt" value="all_bundles"
                         ${selectedOption === 'all_bundles' ? 'checked' : ''}
                         data-change="selectBundleOption" data-bundle-id="${bundle.bundle_id}">
                  All bundles (${allBun.bundle_qty || 0}) $${((allBun.total_cost_cents || 0) / 100).toFixed(2)}
                </label>
                <label class="order-option-sm ${isIndividual ? 'active' : ''}">
                  <input type="radio" name="bundle-${bundle.bundle_id}-opt" value="all_individual"
                         ${selectedOption === 'all_individual' ? 'checked' : ''}
                         data-change="selectBundleOption" data-bundle-id="${bundle.bundle_id}">
                  Individual $${((allInd.total_cost_cents || 0) / 100).toFixed(2)}
                </label>
              </div>
            </div>
          </td>
        </tr>`;
    }

    // Separator
    html += `<tr class="bundle-separator"><td colspan="19"></td></tr>`;

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

function selectBundleOption(element) {
  const bundleId = parseInt(element.dataset.bundleId);
  const value = element.value;
  selectedBundleOptions.set(bundleId, value);

  // Sync editable qty to match the preset
  const bundle = bundleAnalysis.find(b => b.bundle_id === bundleId);
  if (bundle) {
    const opt = bundle.order_options || {};
    const presetQty = value === 'all_individual' ? 0 : (opt[value]?.bundle_qty || 0);
    editedBundleQtys.set(bundleId, presetQty);
  }

  renderTable();
  updateFooter();
}

/**
 * Client-side bundle cost calculation (mirrors services/bundle-calculator.js)
 */
function calculateBundleOptionClient(bundle, bundleQty) {
  const children = bundle.children || [];
  const bundleCostPerUnit = bundle.cost_cents || 0;
  const bundleCost = bundleQty * bundleCostPerUnit;
  let topupCost = 0;
  const surplus = {};

  for (const child of children) {
    const unitsFromBundles = bundleQty * child.quantity_in_bundle;
    const remainingNeed = Math.max(0, child.individual_need - unitsFromBundles);

    if (remainingNeed > 0) {
      topupCost += Math.ceil(remainingNeed) * (child.individual_cost_cents || 0);
    }

    if (unitsFromBundles > child.individual_need) {
      surplus[child.child_item_name] = unitsFromBundles - child.individual_need;
    }
  }

  return {
    bundle_qty: bundleQty,
    bundle_cost_cents: bundleCost,
    topup_cost_cents: topupCost,
    total_cost_cents: bundleCost + topupCost,
    surplus
  };
}

function getEffectiveBundleQty(bundle) {
  if (editedBundleQtys.has(bundle.bundle_id)) {
    return editedBundleQtys.get(bundle.bundle_id);
  }
  const selectedOption = selectedBundleOptions.get(bundle.bundle_id) || 'optimized';
  const opt = bundle.order_options || {};
  if (selectedOption === 'all_individual') return 0;
  return opt[selectedOption]?.bundle_qty || 0;
}

function updateBundleQty(input) {
  const bundleId = parseInt(input.dataset.bundleId);
  const qty = Math.max(0, parseInt(input.value) || 0);
  editedBundleQtys.set(bundleId, qty);

  // Auto-select matching preset radio
  const bundle = bundleAnalysis.find(b => b.bundle_id === bundleId);
  if (bundle) {
    const opt = bundle.order_options || {};
    if (qty === (opt.optimized?.bundle_qty || 0)) {
      selectedBundleOptions.set(bundleId, 'optimized');
    } else if (qty === (opt.all_bundles?.bundle_qty || 0)) {
      selectedBundleOptions.set(bundleId, 'all_bundles');
    } else if (qty === 0) {
      selectedBundleOptions.set(bundleId, 'all_individual');
    } else {
      selectedBundleOptions.set(bundleId, 'custom');
    }
  }

  renderTable();
  updateFooter();
}

function renderTable() {
  const tbody = document.getElementById('suggestions-body');

  // Render bundle groups first, then standalone items
  const bundleHtml = renderBundleRows();

  const itemsHtml = allSuggestions.map((item, index) => {
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

    const velocityText = `<span class="${velocityClass}">${formatVelocity(item.weekly_avg_91d)} / ${formatVelocity(item.weekly_avg_182d)} / ${formatVelocity(item.weekly_avg_365d)}</span>`;

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

    // Determine expiry tier for visual indicators
    const daysLeft = item.days_until_expiry;
    let expiryTier = null;
    let expiryTierLabel = '';
    let needsReorderResistance = false;

    if (item.does_not_expire) {
      expiryTier = null;
    } else if (daysLeft !== null) {
      if (daysLeft <= 0) {
        expiryTier = 'EXPIRED';
        expiryTierLabel = 'EXP';
        needsReorderResistance = true;
      } else if (daysLeft <= 30) {
        expiryTier = 'AUTO50';
        expiryTierLabel = '50%';
        needsReorderResistance = true;
      } else if (daysLeft <= 89) {
        expiryTier = 'AUTO25';
        expiryTierLabel = '25%';
        needsReorderResistance = true;
      } else if (daysLeft <= 120) {
        expiryTier = 'REVIEW';
        expiryTierLabel = 'REV';
      } else {
        expiryTier = 'OK';
        expiryTierLabel = 'OK';
      }
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
      if (daysLeft !== null && daysLeft <= 30) {
        expiryHtml = `<span class="expiry-badge critical" title="${daysLeft} days until expiry">${formattedDate}</span>`;
      } else if (daysLeft !== null && daysLeft <= 120) {
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
      const daysClass = daysLeft <= 30 ? 'critical' : daysLeft <= 89 ? 'warning' : daysLeft <= 120 ? 'review' : 'ok';
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
          ${item.current_stock}
          ${item.committed_quantity > 0 ? `<br><small style="color: #92400e;" title="${item.available_quantity} available, ${item.committed_quantity} committed to invoices">⚠️ ${item.available_quantity} avail</small>` : ''}
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
      </tr>
    `;
  }).join('');

  tbody.innerHTML = bundleHtml + itemsHtml;
}

function toggleSelectAll(checked) {
  selectedItems.clear();
  if (checked) {
    allSuggestions.forEach(item => selectedItems.add(item.variation_id));
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

  // Update select-all checkbox
  document.getElementById('select-all').checked =
    selectedItems.size === allSuggestions.length && allSuggestions.length > 0;

  // Update row styling
  const row = document.querySelector(`tr[data-id="${variationId}"]`);
  if (row) {
    row.classList.toggle('selected', checked);
    row.classList.toggle('unchecked', !checked);
  }

  updateFooter();
}

function updateFooter() {
  const selectedSuggestions = allSuggestions.filter(s => selectedItems.has(s.variation_id));
  // Calculate total cost based on cases (respecting stock max and user edits)
  const totalCost = selectedSuggestions.reduce((sum, item) => {
    const casePack = item.case_pack_quantity || 1;
    let casesToOrder;

    // Check if user has edited this quantity
    if (editedOrderQtys.has(item.variation_id)) {
      casesToOrder = editedOrderQtys.get(item.variation_id);
    } else {
      // Apply stock maximum logic for suggested qty
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

  // Add bundle costs based on selected/edited bundle quantities
  let bundleCost = 0;
  for (const bundle of bundleAnalysis) {
    const qty = getEffectiveBundleQty(bundle);
    const cost = calculateBundleOptionClient(bundle, qty);
    bundleCost += cost.total_cost_cents / 100;
  }

  document.getElementById('selected-count').textContent = selectedSuggestions.length;
  document.getElementById('total-cost').textContent = '$' + (totalCost + bundleCost).toFixed(2);
  document.getElementById('create-po-btn').disabled = selectedSuggestions.length === 0;
}

async function createPurchaseOrder() {
  const selectedSuggestions = allSuggestions.filter(s => selectedItems.has(s.variation_id));

  if (selectedSuggestions.length === 0) {
    alert('Please select at least one item to create a purchase order.');
    return;
  }

  const vendorId = document.getElementById('vendor-select').value;
  if (!vendorId || vendorId === 'none') {
    alert('Please select a specific vendor to create a purchase order.');
    return;
  }

  // Check if all selected items are from the same vendor
  const vendors = new Set(selectedSuggestions.map(s => s.vendor_name));
  if (vendors.size > 1) {
    alert('Selected items are from multiple vendors. Please select items from a single vendor or filter by vendor first.');
    return;
  }

  // Check for expiring items and warn
  const expiringItems = selectedSuggestions.filter(item => {
    const daysLeft = item.days_until_expiry;
    return daysLeft !== null && daysLeft <= 89;
  });

  if (expiringItems.length > 0) {
    const expiredCount = expiringItems.filter(i => i.days_until_expiry <= 0).length;
    const auto50Count = expiringItems.filter(i => i.days_until_expiry > 0 && i.days_until_expiry <= 30).length;
    const auto25Count = expiringItems.filter(i => i.days_until_expiry > 30 && i.days_until_expiry <= 89).length;

    let warningMessage = `⚠️ WARNING: You are about to create a PO with ${expiringItems.length} expiring item(s):\n\n`;
    if (expiredCount > 0) warningMessage += `• ${expiredCount} EXPIRED item(s) - should be pulled from shelves\n`;
    if (auto50Count > 0) warningMessage += `• ${auto50Count} item(s) on clearance sale (expiring within 30 days)\n`;
    if (auto25Count > 0) warningMessage += `• ${auto25Count} item(s) with discount applied (expiring within 31-89 days)\n`;
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

  const items = selectedSuggestions.map(item => {
    const casePack = item.case_pack_quantity || 1;
    let casesToOrder;

    // Check if user has edited this quantity
    if (editedOrderQtys.has(item.variation_id)) {
      casesToOrder = editedOrderQtys.get(item.variation_id);
    } else {
      // Apply stock maximum logic for suggested qty
      let suggestedQty = item.final_suggested_qty;
      if (item.stock_alert_max && item.stock_alert_max > 0) {
        const projectedStock = item.current_stock + suggestedQty;
        if (projectedStock > item.stock_alert_max) {
          suggestedQty = Math.max(0, item.stock_alert_max - item.current_stock);
        }
      }
      casesToOrder = suggestedQty > 0 ? Math.ceil(suggestedQty / casePack) : 0;
    }

    // Calculate actual units to order (cases × case pack)
    const actualUnits = casesToOrder * casePack;

    return {
      variation_id: item.variation_id,
      quantity_ordered: actualUnits, // Order in full cases
      unit_cost_cents: item.unit_cost_cents
    };
  }).filter(item => item.quantity_ordered > 0); // Exclude zero-quantity items

  // Check if any items remain after filtering
  if (items.length === 0) {
    alert('No items to order. All selected items have zero quantity.');
    return;
  }

  const poData = {
    vendor_id: vendorId,
    location_id: locationId,
    supply_days_override: supplyDays,
    items: items,
    notes: `Auto-generated from reorder suggestions (${items.length} items)`,
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
    document.getElementById('select-all').checked = false;
    renderTable();
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
      throw new Error(errorData.error || `HTTP ${response.status}`);
    }

    const result = await response.json();

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

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
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
  await loadLocations();
  await loadVendors();
  // Auto-load suggestions on page load
  await getSuggestions();
});

// Re-sort and re-render when sort option changes
document.getElementById('sort-by').addEventListener('change', () => {
  if (allSuggestions.length > 0) {
    sortSuggestions();
    renderTable();
  }
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
window.selectBundleOption = selectBundleOption;
window.updateBundleQty = updateBundleQty;
