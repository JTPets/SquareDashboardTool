/**
 * Catalog Viewer — inventory.js
 *
 * Module breakdown map (file exceeds 300 lines; refactor-on-touch per CLAUDE.md):
 *   COLUMNS defs     : ~1–58
 *   State / init     : ~59–80
 *   UI helpers       : ~81–100
 *   Data loading     : ~101–135
 *   Filter           : ~136–158
 *   Render header    : ~159–178
 *   Render table     : ~179–215
 *   Sort             : ~216–237
 *   Column toggle    : ~238–278
 *   Stats            : ~279–292
 *   CSV export       : ~293–322
 *   Bootstrap        : ~323–end
 * Extraction candidates: catalog-column-defs.js, catalog-cell-renderer.js
 */

'use strict';

// ─── Column definitions ───────────────────────────────────────────────────────
// type: text | mono | money | num | bool | datetime | html_flag | jsonb | name
const COLUMNS = [
    // Fixed — always visible, sticky left
    { k: 'item_name',               label: 'Product',           vis: true,  fixed: true, type: 'name' },
    // Default visible
    { k: 'sku',                     label: 'SKU',               vis: true,  type: 'mono' },
    { k: 'upc',                     label: 'UPC',               vis: true,  type: 'mono' },
    { k: 'price_money',             label: 'Price',             vis: true,  type: 'money' },
    { k: 'cost_cents',              label: 'Cost',              vis: true,  type: 'money' },
    { k: 'stock_alert_min',         label: 'Min Stock',         vis: true,  type: 'num' },
    { k: 'category_name',           label: 'Category',          vis: true,  type: 'text' },
    { k: 'primary_vendor_name',     label: 'Brand',             vis: true,  type: 'text' },
    // Default hidden — general
    { k: 'variation_name',          label: 'Variation',         vis: false, type: 'text' },
    { k: 'description',             label: 'Description',       vis: false, type: 'text' },
    { k: 'description_html',        label: 'HTML Desc',         vis: false, type: 'html_flag' },
    { k: 'abbreviation',            label: 'Abbreviation',      vis: false, type: 'text' },
    { k: 'notes',                   label: 'Notes',             vis: false, type: 'text' },
    // Availability
    { k: 'visibility',              label: 'Visibility',        vis: false, type: 'text' },
    { k: 'available_online',        label: 'Online',            vis: false, type: 'bool' },
    { k: 'available_for_pickup',    label: 'Pickup',            vis: false, type: 'bool' },
    { k: 'present_at_all_locations',label: 'All Locations',     vis: false, type: 'bool' },
    // Inventory flags
    { k: 'track_inventory',         label: 'Track Inv',         vis: false, type: 'bool' },
    { k: 'sellable',                label: 'Sellable',          vis: false, type: 'bool' },
    { k: 'stockable',               label: 'Stockable',         vis: false, type: 'bool' },
    { k: 'discontinued',            label: 'Discontinued',      vis: false, type: 'bool' },
    // Pricing / inventory config
    { k: 'pricing_type',            label: 'Pricing Type',      vis: false, type: 'text' },
    { k: 'currency',                label: 'Currency',          vis: false, type: 'text' },
    { k: 'inventory_alert_type',    label: 'Alert Type',        vis: false, type: 'text' },
    { k: 'inventory_alert_threshold',label:'Alert Threshold',   vis: false, type: 'num' },
    { k: 'stock_alert_max',         label: 'Max Stock',         vis: false, type: 'num' },
    { k: 'case_pack_quantity',      label: 'Case Pack',         vis: false, type: 'num' },
    { k: 'ordinal',                 label: 'Ordinal',           vis: false, type: 'num' },
    { k: 'reorder_multiple',        label: 'Reorder Mult',      vis: false, type: 'num' },
    { k: 'preferred_stock_level',   label: 'Pref. Stock',       vis: false, type: 'num' },
    { k: 'shelf_location',          label: 'Shelf',             vis: false, type: 'text' },
    { k: 'bin_location',            label: 'Bin',               vis: false, type: 'text' },
    // JSONB
    { k: 'item_option_values',      label: 'Option Values',     vis: false, type: 'jsonb' },
    { k: 'custom_attributes',       label: 'Var Custom Attrs',  vis: false, type: 'jsonb' },
    { k: 'item_custom_attributes',  label: 'Item Custom Attrs', vis: false, type: 'jsonb' },
    { k: 'tax_ids',                 label: 'Var Tax IDs',       vis: false, type: 'jsonb' },
    { k: 'item_tax_ids',            label: 'Item Tax IDs',      vis: false, type: 'jsonb' },
    { k: 'images',                  label: 'Var Images',        vis: false, type: 'jsonb' },
    { k: 'item_options',            label: 'Item Options',      vis: false, type: 'jsonb' },
    // SEO / meta
    { k: 'seo_title',               label: 'SEO Title',         vis: false, type: 'text' },
    { k: 'seo_description',         label: 'SEO Desc',          vis: false, type: 'text' },
    // Timestamps
    { k: 'square_updated_at',       label: 'Var Updated',       vis: false, type: 'datetime' },
    { k: 'item_square_updated_at',  label: 'Item Updated',      vis: false, type: 'datetime' },
    // IDs
    { k: 'primary_vendor_id',       label: 'Vendor ID',         vis: false, type: 'mono' },
];

const LS_KEY = 'catalog_col_vis_v1';

// ─── State ────────────────────────────────────────────────────────────────────
let allData = [];
let filteredData = [];
let colVisible = {};
let sortState = { field: null, asc: true };

// ─── Column visibility persistence ───────────────────────────────────────────
function initColVisibility() {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    COLUMNS.forEach(c => {
        colVisible[c.k] = c.fixed ? true : (saved ? (c.k in saved ? saved[c.k] : c.vis) : c.vis);
    });
}

function saveColVisibility() {
    localStorage.setItem(LS_KEY, JSON.stringify(colVisible));
}

// ─── UI state helpers ─────────────────────────────────────────────────────────
function showLoading() {
    document.querySelector('.loading').style.display = 'block';
    document.querySelector('.error-msg').style.display = 'none';
    document.getElementById('dataTable').style.display = 'none';
    document.getElementById('stats').style.display = 'none';
}

function showError(msg) {
    document.querySelector('.loading').style.display = 'none';
    document.querySelector('.error-msg').style.display = 'block';
    document.getElementById('errorMessage').textContent = msg;
    document.getElementById('dataTable').style.display = 'none';
    document.getElementById('stats').style.display = 'none';
}

function showData() {
    document.querySelector('.loading').style.display = 'none';
    document.querySelector('.error-msg').style.display = 'none';
    document.getElementById('dataTable').style.display = 'table';
    document.getElementById('stats').style.display = 'grid';
}

// ─── Data loading ─────────────────────────────────────────────────────────────
async function loadData() {
    showLoading();
    try {
        const res = await fetch('/api/variations');
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        const data = await res.json();
        allData = data.variations || [];

        if (allData.length === 0) { showError('No catalog data found.'); return; }

        populateFilters();
        filteredData = allData;
        renderHeader();
        renderTable(filteredData);
        calculateStats(filteredData);
        showData();
        document.getElementById('statusBadge').textContent =
            `${formatNumber(allData.length)} variations • ${new Date().toLocaleTimeString()}`;
    } catch (err) {
        console.error('Catalog load error:', err);
        const msg = window.ErrorHelper
            ? ErrorHelper.getFriendlyMessage(err, 'catalog', 'load')
            : 'Failed to load catalog data. Please refresh.';
        showError(msg);
    }
}

function populateFilters() {
    const cats = [...new Set(allData.map(v => v.category_name).filter(Boolean))].sort();
    const catSel = document.getElementById('categoryFilter');
    catSel.innerHTML = '<option value="">All Categories</option>' +
        cats.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('');

    const brands = [...new Set(allData.map(v => v.primary_vendor_name).filter(Boolean))].sort();
    const vendSel = document.getElementById('vendorFilter');
    vendSel.innerHTML = '<option value="">All Brands</option>' +
        brands.map(b => `<option value="${escapeAttr(b)}">${escapeHtml(b)}</option>`).join('');
}

// ─── Filter ───────────────────────────────────────────────────────────────────
function filterData() {
    const search = document.getElementById('searchBox').value.toLowerCase();
    const cat    = document.getElementById('categoryFilter').value;
    const vendor = document.getElementById('vendorFilter').value;

    filteredData = allData.filter(v => {
        if (search && !([v.item_name, v.variation_name, v.sku, v.upc]
            .some(f => (f || '').toLowerCase().includes(search)))) return false;
        if (cat    && v.category_name       !== cat)    return false;
        if (vendor && v.primary_vendor_name !== vendor) return false;
        return true;
    });

    renderTable(filteredData);
    calculateStats(filteredData);
    document.getElementById('statusBadge').textContent =
        `Showing ${formatNumber(filteredData.length)} of ${formatNumber(allData.length)}`;
}

// ─── Render header ────────────────────────────────────────────────────────────
function renderHeader() {
    const thead = document.getElementById('tableHead');
    const visCols = COLUMNS.filter(c => colVisible[c.k]);
    const sortableTypes = new Set(['text', 'mono', 'num', 'money', 'datetime']);

    thead.innerHTML = '<tr>' + visCols.map(c => {
        const fixedCls = c.fixed ? ' col-fixed' : '';
        const isSortable = sortableTypes.has(c.type);
        const sortCls = isSortable ? ' sortable' : '';
        const indicator = isSortable ? ` <span class="sort-indicator" id="sort-${c.k}"></span>` : '';
        const sortAttr = isSortable ? ` data-sort-key="${escapeAttr(c.k)}"` : '';
        return `<th class="${fixedCls}${sortCls}"${sortAttr}>${escapeHtml(c.label)}${indicator}</th>`;
    }).join('') + '</tr>';

    thead.querySelectorAll('th[data-sort-key]').forEach(th => {
        th.addEventListener('click', () => sortBy(th.dataset.sortKey));
    });

    // Restore active sort indicator
    if (sortState.field) {
        const el = document.getElementById(`sort-${sortState.field}`);
        if (el) el.className = `sort-indicator ${sortState.asc ? 'asc' : 'desc'}`;
    }
}

// ─── Render table ─────────────────────────────────────────────────────────────
function renderTable(data) {
    const tbody = document.getElementById('tableBody');
    const visCols = COLUMNS.filter(c => colVisible[c.k]);
    tbody.innerHTML = '';
    data.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = visCols.map(c => {
            const cls = c.fixed ? ' class="col-fixed"' : '';
            return `<td${cls}>${renderCell(c, item)}</td>`;
        }).join('');
        tbody.appendChild(tr);
    });
}

function renderCell(col, item) {
    const val = item[col.k];
    switch (col.type) {
        case 'name':
            return `<div class="product-name">${escapeHtml(item.item_name || 'Unknown')}` +
                (item.variation_name
                    ? `<div class="variation-name">${escapeHtml(item.variation_name)}</div>`
                    : '') + '</div>';
        case 'mono':
            return val ? `<span class="mono">${escapeHtml(String(val))}</span>` : '-';
        case 'money':
            return val != null ? `<span class="text-right-cell">${formatCurrency(val)}</span>` : '--';
        case 'num':
            return val != null ? escapeHtml(String(val)) : '-';
        case 'bool':
            if (val === null || val === undefined) return '<span style="color:#9ca3af">—</span>';
            return val ? '<span class="bool-true">✓</span>' : '<span class="bool-false">✗</span>';
        case 'datetime':
            return `<span style="font-size:12px">${formatDateTime(val)}</span>`;
        case 'html_flag':
            return val ? '<span class="html-flag">(has HTML)</span>' : '-';
        case 'jsonb': {
            if (!val) return '-';
            const parsed = typeof val === 'object'
                ? val
                : (() => { try { return JSON.parse(val); } catch (e) { return null; } })();
            if (!parsed) return '-';
            const count = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
            const tip = escapeAttr(JSON.stringify(parsed, null, 2));
            return `<span class="jsonb-badge" title="${tip}">${count}</span>`;
        }
        case 'text':
        default:
            return val != null && val !== '' ? escapeHtml(String(val)) : '-';
    }
}

// ─── Sort ─────────────────────────────────────────────────────────────────────
function sortBy(field) {
    sortState.asc = sortState.field === field ? !sortState.asc : true;
    sortState.field = field;

    document.querySelectorAll('.sort-indicator').forEach(el => { el.className = 'sort-indicator'; });
    const el = document.getElementById(`sort-${field}`);
    if (el) el.className = `sort-indicator ${sortState.asc ? 'asc' : 'desc'}`;

    const col = COLUMNS.find(c => c.k === field);
    const numeric = col && ['num', 'money'].includes(col.type);

    filteredData.sort((a, b) => {
        let av = a[field], bv = b[field];
        if (numeric) { av = parseFloat(av) || 0; bv = parseFloat(bv) || 0; }
        else { av = (av || '').toString().toLowerCase(); bv = (bv || '').toString().toLowerCase(); }
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * (sortState.asc ? 1 : -1);
    });

    renderTable(filteredData);
}

// ─── Column toggle ────────────────────────────────────────────────────────────
function buildColTogglePanel() {
    const list = document.getElementById('colToggleList');
    list.innerHTML = COLUMNS.filter(c => !c.fixed).map(c => `
        <label class="col-toggle-item">
          <input type="checkbox" data-col="${escapeAttr(c.k)}" ${colVisible[c.k] ? 'checked' : ''}>
          ${escapeHtml(c.label)}
        </label>`).join('');

    list.addEventListener('change', function (e) {
        const key = e.target.dataset.col;
        if (!key) return;
        colVisible[key] = e.target.checked;
        saveColVisibility();
        renderHeader();
        renderTable(filteredData);
    });
}

function toggleColPanel() {
    document.getElementById('colTogglePanel').classList.toggle('open');
}

function setAllCols(visible) {
    COLUMNS.forEach(c => { if (!c.fixed) colVisible[c.k] = visible; });
    saveColVisibility();
    document.querySelectorAll('#colToggleList input[type="checkbox"]')
        .forEach(cb => { cb.checked = visible; });
    renderHeader();
    renderTable(filteredData);
}

function resetCols() {
    COLUMNS.forEach(c => { colVisible[c.k] = c.fixed ? true : c.vis; });
    saveColVisibility();
    document.querySelectorAll('#colToggleList input[type="checkbox"]').forEach(cb => {
        const col = COLUMNS.find(c => c.k === cb.dataset.col);
        if (col) cb.checked = col.vis;
    });
    renderHeader();
    renderTable(filteredData);
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function calculateStats(data) {
    document.getElementById('statVariations').textContent = formatNumber(data.length);
    document.getElementById('statItems').textContent =
        formatNumber(new Set(data.map(v => v.item_id)).size);
    document.getElementById('statWithPrice').textContent =
        formatNumber(data.filter(v => v.price_money).length);
    document.getElementById('statWithCost').textContent =
        formatNumber(data.filter(v => v.cost_cents).length);
    document.getElementById('statMissingUpc').textContent =
        formatNumber(data.filter(v => !v.upc).length);
}

// ─── CSV export ───────────────────────────────────────────────────────────────
function csvEscape(str) {
    if (str == null) return '';
    const s = String(str);
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
}

function exportCsv() {
    const visCols = COLUMNS.filter(c => colVisible[c.k] && c.type !== 'image');
    const headers = visCols.map(c => csvEscape(c.label)).join(',');

    const rows = filteredData.map(item =>
        visCols.map(c => {
            const val = item[c.k];
            if (val == null || val === '') return '';
            if (c.type === 'jsonb') {
                const parsed = typeof val === 'object'
                    ? val
                    : (() => { try { return JSON.parse(val); } catch (e) { return null; } })();
                return parsed ? csvEscape(JSON.stringify(parsed)) : '';
            }
            if (c.type === 'money')     return (val / 100).toFixed(2);
            if (c.type === 'bool')      return val ? 'true' : 'false';
            if (c.type === 'html_flag') return val ? '(has HTML)' : '';
            if (c.type === 'name')      return csvEscape(item.item_name || '');
            return csvEscape(String(val));
        }).join(',')
    );

    const csv = [headers, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `catalog-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
    initColVisibility();
    buildColTogglePanel();
    loadData();

    document.getElementById('searchBox').addEventListener('input', filterData);
    document.getElementById('categoryFilter').addEventListener('change', filterData);
    document.getElementById('vendorFilter').addEventListener('change', filterData);
    document.getElementById('refreshBtn').addEventListener('click', loadData);
    document.getElementById('exportCsvBtn').addEventListener('click', exportCsv);
    document.getElementById('colToggleBtn').addEventListener('click', toggleColPanel);
    document.getElementById('showAllCols').addEventListener('click', () => setAllCols(true));
    document.getElementById('hideAllCols').addEventListener('click', () => setAllCols(false));
    document.getElementById('resetCols').addEventListener('click', resetCols);

    // Close column panel on outside click
    document.addEventListener('click', function (e) {
        const panel = document.getElementById('colTogglePanel');
        if (!panel.classList.contains('open')) return;
        if (!panel.contains(e.target) && e.target.id !== 'colToggleBtn') {
            panel.classList.remove('open');
        }
    });
});

window.loadData   = loadData;
window.filterData = filterData;
