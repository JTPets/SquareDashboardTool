/**
 * Accept Invitation Page Script — BACKLOG-41
 *
 * Public page (no auth required). Reads token from URL,
 * validates via GET /api/staff/validate-token, then shows
 * password form (new user) or confirm button (existing user).
 * Actual accept only on explicit user action.
 */

'use strict';

var inviteToken = null;
var isExistingUser = false;

function getTokenFromUrl() {
  var params = new URLSearchParams(window.location.search);
  return params.get('token') || '';
}

function showState(stateId) {
  var states = ['loading-state', 'error-state', 'form-state', 'success-state'];
  for (var i = 0; i < states.length; i++) {
    document.getElementById(states[i]).style.display = states[i] === stateId ? 'block' : 'none';
  }
}

function showError(message) {
  document.getElementById('error-message').textContent = message;
  showState('error-state');
}

/**
 * Validate the token via GET endpoint (read-only, no side effects).
 */
function validateToken() {
  inviteToken = getTokenFromUrl();

  if (!inviteToken) {
    showError('No invitation token found. Please check your invitation link.');
    return;
  }

  fetch('/api/staff/validate-token?token=' + encodeURIComponent(inviteToken))
    .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
    .then(function (result) {
      if (!result.ok || !result.data.valid) {
        showError('This invitation is invalid or has expired. Please ask your team owner for a new invitation.');
        return;
      }

      var data = result.data;
      document.getElementById('invite-merchant-name').textContent = escapeHtml(data.merchantName || 'Team');
      document.getElementById('invite-role-display').textContent = data.role || 'staff';

      if (data.existingUser) {
        isExistingUser = true;
        document.getElementById('password-section').style.display = 'none';
        document.getElementById('existing-user-notice').style.display = 'block';
      } else {
        isExistingUser = false;
        document.getElementById('password-section').style.display = 'block';
        document.getElementById('existing-user-notice').style.display = 'none';
      }

      showState('form-state');
    })
    .catch(function () {
      showError('Unable to connect to the server. Please try again.');
    });
}

function acceptInvitation() {
  var body = { token: inviteToken };

  if (!isExistingUser) {
    var password = document.getElementById('invite-password').value;
    var confirmPassword = document.getElementById('invite-password-confirm').value;

    if (!password) {
      alert('Please enter a password.');
      return;
    }
    if (password.length < 8) {
      alert('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      alert('Passwords do not match.');
      return;
    }
    body.password = password;
  }

  var btn = document.querySelector('[data-action="acceptInvitation"]');
  btn.disabled = true;
  btn.textContent = 'Accepting...';

  fetch('/api/staff/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
    .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
    .then(function (result) {
      if (result.ok && result.data.success) {
        showState('success-state');
        return;
      }
      btn.disabled = false;
      btn.textContent = 'Accept Invitation';
      alert(result.data.error || 'Failed to accept invitation. Please try again.');
    })
    .catch(function () {
      btn.disabled = false;
      btn.textContent = 'Accept Invitation';
      alert('Unable to connect to the server. Please try again.');
    });
}

// Initialize
document.addEventListener('DOMContentLoaded', function () {
  validateToken();
});

// Expose to event delegation
window.acceptInvitation = acceptInvitation;
