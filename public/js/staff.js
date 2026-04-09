/**
 * Staff Management Page Script — BACKLOG-41
 *
 * Handles staff listing, invitation, role changes, and removal.
 * Uses event delegation (data-action attributes) for CSP compliance.
 */

'use strict';

var isAdmin = false;
var pendingRemoveUserId = null;

function loadStaff() {
  fetch('/api/staff')
    .then(function (res) {
      if (res.status === 403) {
        document.getElementById('access-denied').style.display = 'block';
        return null;
      }
      if (!res.ok) throw new Error('Failed to load staff');
      return res.json();
    })
    .then(function (data) {
      if (!data) return;
      document.getElementById('staff-content').style.display = 'block';
      renderStaffTable(data.staff || []);
      renderInvitationsTable(data.pendingInvitations || []);
    })
    .catch(function (err) {
      document.getElementById('staff-table-container').innerHTML =
        '<div class="alert error">' + escapeHtml(err.message) + '</div>';
    });
}

function renderStaffTable(staff) {
  var container = document.getElementById('staff-table-container');

  if (staff.length === 0) {
    container.innerHTML = '<div class="empty-state">No staff members found.</div>';
    return;
  }

  var html = '<table class="staff-table"><thead><tr>' +
    '<th>Name / Email</th><th>Role</th><th>Joined</th><th>Last Active</th>';
  if (isAdmin) html += '<th>Actions</th>';
  html += '</tr></thead><tbody>';

  for (var i = 0; i < staff.length; i++) {
    var s = staff[i];
    var nameDisplay = s.name ? escapeHtml(s.name) : '<span style="color:#9ca3af;">No name</span>';
    var isOwner = s.role === 'owner';

    html += '<tr>';
    html += '<td>' + nameDisplay + '<br><span style="font-size:12px;color:#6b7280;">' + escapeHtml(s.email) + '</span></td>';

    if (isAdmin && !isOwner) {
      html += '<td><select class="role-select" data-change="changeRole" data-action-param="' + escapeAttr(String(s.id)) + '">' +
        '<option value="manager"' + (s.role === 'manager' ? ' selected' : '') + '>Manager</option>' +
        '<option value="clerk"' + (s.role === 'clerk' ? ' selected' : '') + '>Clerk</option>' +
        '<option value="readonly"' + (s.role === 'readonly' ? ' selected' : '') + '>Read Only</option>' +
        '</select></td>';
    } else {
      html += '<td><span class="role-badge ' + escapeAttr(s.role) + '">' + escapeHtml(s.role) + '</span></td>';
    }

    html += '<td>' + formatDate(s.accepted_at || s.invited_at) + '</td>';
    html += '<td>' + formatDateTime(s.last_active) + '</td>';

    if (isAdmin) {
      html += '<td>';
      if (!isOwner) {
        html += '<button class="btn btn-danger btn-sm" data-action="removeStaff" data-action-param="' +
          escapeAttr(String(s.id)) + '">Remove</button>';
      } else {
        html += '<span style="color:#9ca3af;font-size:12px;">Owner</span>';
      }
      html += '</td>';
    }

    html += '</tr>';
  }

  html += '</tbody></table>';
  container.innerHTML = html;
}

function renderInvitationsTable(invitations) {
  var container = document.getElementById('invitations-table-container');

  if (invitations.length === 0) {
    container.innerHTML = '<div class="empty-state">No pending invitations.</div>';
    return;
  }

  var html = '<table class="staff-table"><thead><tr>' +
    '<th>Email</th><th>Role</th><th>Invited</th><th>Expires</th>';
  if (isAdmin) html += '<th>Actions</th>';
  html += '</tr></thead><tbody>';

  for (var i = 0; i < invitations.length; i++) {
    var inv = invitations[i];
    var expiresDate = new Date(inv.expires_at);
    var isExpired = expiresDate < new Date();

    html += '<tr>';
    html += '<td>' + escapeHtml(inv.email) + '</td>';
    html += '<td><span class="role-badge ' + escapeAttr(inv.role) + '">' + escapeHtml(inv.role) + '</span></td>';
    html += '<td>' + formatDate(inv.created_at) + '</td>';
    html += '<td>' + (isExpired
      ? '<span class="status-expired">Expired</span>'
      : formatDate(inv.expires_at)) + '</td>';

    if (isAdmin) {
      html += '<td style="display:flex;gap:6px;">';
      html += '<button class="btn btn-primary btn-sm" data-action="resendInvite" data-action-param="' +
        escapeAttr(inv.email) + '">Resend</button>';
      html += '<button class="btn btn-danger btn-sm" data-action="cancelInvite" data-action-param="' +
        escapeAttr(String(inv.id)) + '">Cancel</button>';
      html += '</td>';
    }

    html += '</tr>';
  }

  html += '</tbody></table>';
  container.innerHTML = html;
}

function showInviteModal() {
  document.getElementById('invite-email').value = '';
  document.getElementById('invite-role').value = 'clerk';
  document.getElementById('invite-url-display').style.display = 'none';
  document.getElementById('invite-url-field').value = '';
  document.getElementById('btn-submit-invite').style.display = '';
  document.getElementById('invite-modal').classList.add('active');
}

function hideInviteModal() {
  document.getElementById('invite-modal').classList.remove('active');
}

function submitInvite() {
  var email = document.getElementById('invite-email').value.trim();
  var role = document.getElementById('invite-role').value;

  if (!email) {
    showToast('Please enter an email address', 'error');
    return;
  }

  fetch('/api/staff/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, role: role })
  })
    .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
    .then(function (result) {
      if (!result.ok) {
        showToast(result.data.error || 'Failed to send invitation', 'error');
        return;
      }
      if (result.data.inviteUrl) {
        // Email failed — show the invite URL so the owner can copy and share it
        document.getElementById('invite-url-field').value = result.data.inviteUrl;
        document.getElementById('invite-url-display').style.display = 'block';
        document.getElementById('btn-submit-invite').style.display = 'none';
        showToast('Invitation created — email failed. Copy the link below.', 'info');
      } else {
        showToast('Invitation sent to ' + email, 'success');
        hideInviteModal();
      }
      loadStaff();
    })
    .catch(function () { showToast('Failed to send invitation', 'error'); });
}

function removeStaff(element) {
  pendingRemoveUserId = element.dataset.actionParam;
  document.getElementById('confirm-remove-text').textContent =
    'Are you sure you want to remove this staff member? They will lose access immediately.';
  document.getElementById('confirm-remove-modal').classList.add('active');
}

function hideRemoveModal() {
  document.getElementById('confirm-remove-modal').classList.remove('active');
  pendingRemoveUserId = null;
}

function confirmRemove() {
  if (!pendingRemoveUserId) return;
  var userId = pendingRemoveUserId;
  hideRemoveModal();

  fetch('/api/staff/' + encodeURIComponent(userId), { method: 'DELETE' })
    .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
    .then(function (result) {
      if (!result.ok) {
        showToast(result.data.error || 'Failed to remove staff member', 'error');
        return;
      }
      showToast('Staff member removed', 'success');
      loadStaff();
    })
    .catch(function () { showToast('Failed to remove staff member', 'error'); });
}

function changeRole(element) {
  var userId = element.dataset.actionParam;
  var newRole = element.value;

  fetch('/api/staff/' + encodeURIComponent(userId) + '/role', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: newRole })
  })
    .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
    .then(function (result) {
      if (!result.ok) {
        showToast(result.data.error || 'Failed to update role', 'error');
        loadStaff();
        return;
      }
      showToast('Role updated to ' + newRole, 'success');
    })
    .catch(function () {
      showToast('Failed to update role', 'error');
      loadStaff();
    });
}

function resendInvite(element) {
  var email = element.dataset.actionParam;
  showToast('Use "Cancel" then re-invite to resend', 'info');
}

function cancelInvite(element) {
  var inviteId = element.dataset.actionParam;
  fetch('/api/staff/invitations/' + encodeURIComponent(inviteId), { method: 'DELETE' })
    .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
    .then(function (result) {
      if (!result.ok) {
        showToast(result.data.error || 'Failed to cancel invitation', 'error');
        return;
      }
      showToast('Invitation cancelled', 'success');
      loadStaff();
    })
    .catch(function () { showToast('Failed to cancel invitation', 'error'); });
}

function copyInviteUrl() {
  var field = document.getElementById('invite-url-field');
  field.select();
  field.setSelectionRange(0, 99999);
  navigator.clipboard.writeText(field.value)
    .then(function () { showToast('Invite link copied', 'success'); })
    .catch(function () { showToast('Copy failed — select and copy manually', 'error'); });
}

function checkPermissions() {
  fetch('/api/auth/me')
    .then(function (res) {
      if (!res.ok) {
        window.location.href = '/login.html?returnUrl=' + encodeURIComponent(window.location.pathname);
        return null;
      }
      return res.json();
    })
    .then(function (data) {
      if (!data) return;

      // Determine admin status from merchant context
      // The GET /api/staff endpoint enforces staff:read — we try loading
      // and if we get admin-level write access, show edit controls
      return fetch('/api/staff/1/role', { method: 'OPTIONS' })
        .catch(function () { return null; })
        .then(function () {
          // Simpler approach: try the staff list, then test a write endpoint
          // to determine if we have admin access
          return loadStaffWithPermCheck();
        });
    })
    .catch(function () {
      window.location.href = '/login.html?returnUrl=' + encodeURIComponent(window.location.pathname);
    });
}

function loadStaffWithPermCheck() {
  fetch('/api/staff')
    .then(function (res) {
      if (res.status === 403) {
        document.getElementById('access-denied').style.display = 'block';
        return null;
      }
      if (!res.ok) throw new Error('Failed to load staff');
      return res.json();
    })
    .then(function (data) {
      if (!data) return;

      // Check if current user is owner by looking at staff list
      return fetch('/api/auth/me').then(function (r) { return r.json(); }).then(function (me) {
        var myEmail = me.user && me.user.email;
        var staffList = data.staff || [];
        var myEntry = null;
        for (var i = 0; i < staffList.length; i++) {
          if (staffList[i].email === myEmail) {
            myEntry = staffList[i];
            break;
          }
        }

        if (myEntry && myEntry.role === 'owner') {
          isAdmin = true;
        } else {
          // Manager can view but not edit
          isAdmin = false;
          document.getElementById('btn-invite').style.display = 'none';
          document.getElementById('readonly-notice').style.display = 'block';
        }

        document.getElementById('staff-content').style.display = 'block';
        renderStaffTable(data.staff || []);
        renderInvitationsTable(data.pendingInvitations || []);
      });
    })
    .catch(function (err) {
      document.getElementById('staff-table-container').innerHTML =
        '<div class="alert error">' + escapeHtml(err.message) + '</div>';
      document.getElementById('staff-content').style.display = 'block';
    });
}

// Initialize
document.addEventListener('DOMContentLoaded', function () {
  checkPermissions();
});

// Expose to event delegation
window.showInviteModal = showInviteModal;
window.hideInviteModal = hideInviteModal;
window.submitInvite = submitInvite;
window.removeStaff = removeStaff;
window.hideRemoveModal = hideRemoveModal;
window.confirmRemove = confirmRemove;
window.changeRole = changeRole;
window.resendInvite = resendInvite;
window.cancelInvite = cancelInvite;
window.copyInviteUrl = copyInviteUrl;
