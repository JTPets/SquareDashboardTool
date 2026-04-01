/**
 * Min/Max Suppression Dashboard
 *
 * Tab 1 — Skipped Items: items excluded from the most recent cron run.
 * Tab 2 — Change History: recent applied min-stock changes.
 *
 * Pin/Unpin: calls POST /api/min-max/toggle-pin; no inline editing.
 */

(function () {
    'use strict';

    // ==================== TAB SWITCHING ====================

    document.querySelectorAll('.tab').forEach(function (btn) {
        btn.addEventListener('click', function () {
            document.querySelectorAll('.tab').forEach(function (t) {
                t.classList.remove('active');
            });
            document.querySelectorAll('.tab-content').forEach(function (tc) {
                tc.classList.remove('active');
            });
            btn.classList.add('active');
            var target = document.getElementById('tab-' + btn.dataset.tab);
            if (target) target.classList.add('active');
        });
    });

    // ==================== LOAD SKIPPED ITEMS ====================

    async function loadSkippedItems() {
        var tbody = document.getElementById('skipped-body');
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Loading…</td></tr>';

        var res;
        try {
            res = await fetch('/api/min-max/suppressed');
        } catch (err) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Network error — could not load data.</td></tr>';
            return;
        }

        var data = await res.json();
        if (!data.success || !data.items.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No skipped items from the last run.</td></tr>';
            return;
        }

        tbody.innerHTML = data.items.map(function (row) {
            var pinLabel = row.min_stock_pinned ? 'Unpin' : 'Pin';
            var pinValue = row.min_stock_pinned ? 'false' : 'true';
            var pinClass = row.min_stock_pinned ? 'btn btn-sm btn-unpin' : 'btn btn-sm btn-pin';
            return '<tr>' +
                '<td>' + escapeHtml(row.item_name || '—') + '</td>' +
                '<td>' + escapeHtml(row.variation_name || '—') + '</td>' +
                '<td>' + escapeHtml(row.sku || '—') + '</td>' +
                '<td>' + (row.old_min != null ? row.old_min : '—') + '</td>' +
                '<td>' + escapeHtml(row.skip_reason || '—') + '</td>' +
                '<td>' + formatDateTime(row.created_at) + '</td>' +
                '<td>' +
                    '<button class="' + escapeAttr(pinClass) + '" ' +
                        'data-variation-id="' + escapeAttr(row.variation_id) + '" ' +
                        'data-location-id="' + escapeAttr(row.location_id) + '" ' +
                        'data-pinned="' + escapeAttr(pinValue) + '">' +
                        pinLabel +
                    '</button>' +
                '</td>' +
            '</tr>';
        }).join('');
    }

    // ==================== LOAD CHANGE HISTORY ====================

    async function loadHistory() {
        var tbody = document.getElementById('history-body');
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Loading…</td></tr>';

        var res;
        try {
            res = await fetch('/api/min-max/audit-log?limit=50');
        } catch (err) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Network error — could not load data.</td></tr>';
            return;
        }

        var data = await res.json();
        if (!data.success || !data.items.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No change history yet.</td></tr>';
            return;
        }

        tbody.innerHTML = data.items.map(function (row) {
            var oldMin = row.old_min != null ? row.old_min : '—';
            var newMin = row.new_min != null ? row.new_min : '—';
            var arrow = row.new_min != null && row.old_min != null
                ? (row.new_min < row.old_min ? ' ↓' : row.new_min > row.old_min ? ' ↑' : '')
                : '';
            return '<tr>' +
                '<td>' + formatDateTime(row.created_at) + '</td>' +
                '<td>' + escapeHtml(row.item_name || '—') + '</td>' +
                '<td>' + escapeHtml(row.variation_name || '—') + '</td>' +
                '<td>' + escapeHtml(row.sku || '—') + '</td>' +
                '<td>' + oldMin + ' → ' + newMin + arrow + '</td>' +
                '<td>' + escapeHtml(row.reason || '—') + '</td>' +
            '</tr>';
        }).join('');
    }

    // ==================== PIN / UNPIN ====================

    async function togglePin(variationId, locationId, pinned) {
        var res;
        try {
            res = await fetch('/api/min-max/toggle-pin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ variationId: variationId, locationId: locationId, pinned: pinned })
            });
        } catch (err) {
            showToast('Network error — could not update pin.', 'error');
            return;
        }

        var data = await res.json();
        if (data.success) {
            showToast(pinned ? 'Item pinned — excluded from auto-adjustment.' : 'Item unpinned.', 'success');
            loadSkippedItems();
        } else {
            showToast(data.error || 'Failed to update pin.', 'error');
        }
    }

    // Event delegation for pin buttons in skipped-body
    document.getElementById('skipped-body').addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-variation-id]');
        if (!btn) return;
        var variationId = btn.dataset.variationId;
        var locationId = btn.dataset.locationId;
        var pinned = btn.dataset.pinned === 'true';
        togglePin(variationId, locationId, pinned);
    });

    // ==================== INIT ====================

    loadSkippedItems();
    loadHistory();
}());
