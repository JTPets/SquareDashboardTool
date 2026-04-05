/**
 * Admin Subscribers
 * Subscriber list, search, filter, and pagination.
 */

'use strict';

var subscribersPage = 0;
var subscribersLimit = 10;
var subscribersTotal = 0;
var searchDebounceTimer = null;

function reloadSubscribers() {
    subscribersPage = 0;
    loadSubscribers();
}

function onSubscriberSearch() {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(function () {
        subscribersPage = 0;
        loadSubscribers();
    }, 350);
}

function onSubscriberFilterChange() {
    subscribersPage = 0;
    loadSubscribers();
}

function prevPage() {
    if (subscribersPage > 0) {
        subscribersPage--;
        loadSubscribers();
    }
}

function nextPage() {
    var maxPage = Math.ceil(subscribersTotal / subscribersLimit) - 1;
    if (subscribersPage < maxPage) {
        subscribersPage++;
        loadSubscribers();
    }
}

async function loadSubscribers() {
    var container = document.getElementById('subscribers-container');
    var pagination = document.getElementById('subscribers-pagination');
    var search = document.getElementById('subscriber-search').value.trim();
    var status = document.getElementById('subscriber-status-filter').value;

    var params = new URLSearchParams({
        limit: String(subscribersLimit),
        offset: String(subscribersPage * subscribersLimit)
    });
    if (search) params.set('search', search);
    if (status) params.set('status', status);

    try {
        var response = await fetch('/api/subscriptions/admin/list?' + params.toString());
        if (!response.ok) throw new Error('Failed to load subscribers');
        var data = await response.json();
        var subscribers = data.subscribers || [];
        subscribersTotal = data.total || 0;

        if (subscribers.length === 0) {
            container.innerHTML = '<div class="empty-state"><h3>No Subscribers Found</h3>' +
                '<p>Try adjusting your search or filter.</p></div>';
            pagination.style.display = 'none';
            return;
        }

        var html =
            '<table><thead><tr>' +
            '<th>Email / Business</th><th>Plan</th><th>Status</th>' +
            '<th>Square Sub</th><th>Created</th><th></th>' +
            '</tr></thead><tbody>';

        subscribers.forEach(function (sub) {
            var statusClass = ({
                active: 'badge-success', trial: 'badge-info',
                canceled: 'badge-gray', expired: 'badge-error', past_due: 'badge-warning'
            })[sub.subscription_status] || 'badge-gray';

            var mid = escapeAttr(String(sub.merchant_id || ''));
            var email = escapeAttr(sub.email);
            var business = escapeAttr(sub.business_name || '');
            var status = sub.subscription_status;

            var actionButtons =
                '<button class="btn btn-secondary btn-sm btn-row-item"' +
                ' data-action="showBillingModal"' +
                ' data-action-param="' + mid + '"' +
                ' data-email="' + email + '"' +
                ' data-business="' + business + '">Billing</button>' +
                '<button class="btn btn-secondary btn-sm btn-row-item"' +
                ' data-action="showFeaturesModal"' +
                ' data-action-param="' + mid + '"' +
                ' data-email="' + email + '">Features</button>';

            if (status === 'trial' || status === 'expired') {
                actionButtons +=
                    '<button class="btn btn-secondary btn-sm btn-row-item"' +
                    ' data-action="showExtendTrialModal"' +
                    ' data-action-param="' + mid + '"' +
                    ' data-email="' + email + '">Extend Trial</button>';
            }
            if (status === 'expired' || status === 'canceled') {
                actionButtons +=
                    '<button class="btn btn-primary btn-sm"' +
                    ' data-action="showActivateModal"' +
                    ' data-action-param="' + mid + '"' +
                    ' data-email="' + email + '">Activate</button>';
            }

            html +=
                '<tr>' +
                '<td><div class="subscriber-email">' + escapeHtml(sub.email) + '</div>' +
                (sub.business_name
                    ? '<div class="subscriber-business">' + escapeHtml(sub.business_name) + '</div>'
                    : '') +
                '</td>' +
                '<td>' + escapeHtml(sub.subscription_plan || '—') + '</td>' +
                '<td><span class="badge ' + escapeAttr(statusClass) + '">' +
                escapeHtml(status) + '</span></td>' +
                '<td>' + (sub.square_subscription_id
                    ? '<span class="badge badge-success">Linked</span>'
                    : '<span class="badge badge-gray">None</span>') + '</td>' +
                '<td>' + formatDate(sub.created_at) + '</td>' +
                '<td class="td-nowrap">' + actionButtons + '</td>' +
                '</tr>';
        });

        html += '</tbody></table>';
        container.innerHTML = html;

        var offset = subscribersPage * subscribersLimit;
        var from = offset + 1;
        var to = Math.min(offset + subscribers.length, subscribersTotal);
        document.getElementById('pagination-info').textContent =
            'Showing ' + from + '\u2013' + to + ' of ' + subscribersTotal;
        document.getElementById('prev-page-btn').disabled = subscribersPage === 0;
        document.getElementById('next-page-btn').disabled = to >= subscribersTotal;
        pagination.style.display = '';
    } catch (error) {
        container.innerHTML = '<div class="alert alert-error">Failed to load subscribers: ' +
            escapeHtml(error.message) + '</div>';
        pagination.style.display = 'none';
    }
}

window.reloadSubscribers = reloadSubscribers;
window.onSubscriberSearch = onSubscriberSearch;
window.onSubscriberFilterChange = onSubscriberFilterChange;
window.prevPage = prevPage;
window.nextPage = nextPage;
