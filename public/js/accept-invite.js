/**
 * Accept Invitation Page Script — BACKLOG-41
 *
 * Public page (no auth required). Reads token from URL,
 * validates it by attempting a password-less accept, then
 * collects password if needed (new user) or confirms (existing user).
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
 * Probe the token by attempting to accept without a password.
 * - If it succeeds: existing user, invitation accepted.
 * - If PASSWORD_REQUIRED: new user, show password form.
 * - If INVALID_TOKEN: token is bad/expired.
 */
function validateToken() {
  inviteToken = getTokenFromUrl();

  if (!inviteToken) {
    showError('No invitation token found. Please check your invitation link.');
    return;
  }

  fetch('/api/staff/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: inviteToken })
  })
    .then(function (res) { return res.json().then(function (d) { return { status: res.status, data: d }; }); })
    .then(function (result) {
      if (result.data.success) {
        // Existing user — invitation accepted immediately
        showState('success-state');
        return;
      }

      if (result.data.code === 'PASSWORD_REQUIRED') {
        // New user — show password form
        isExistingUser = false;
        document.getElementById('password-section').style.display = 'block';
        document.getElementById('existing-user-notice').style.display = 'none';
        // We don't have merchant name from this response, show generic info
        document.getElementById('invite-merchant-name').textContent = 'Team Invitation';
        document.getElementById('invite-role-display').textContent = 'Staff';
        showState('form-state');
        return;
      }

      if (result.data.code === 'INVALID_TOKEN') {
        showError('This invitation is invalid or has expired. Please ask your team owner for a new invitation.');
        return;
      }

      showError(result.data.error || 'Something went wrong. Please try again.');
    })
    .catch(function () {
      showError('Unable to connect to the server. Please try again.');
    });
}

function acceptInvitation() {
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

  var btn = document.querySelector('[data-action="acceptInvitation"]');
  btn.disabled = true;
  btn.textContent = 'Accepting...';

  fetch('/api/staff/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: inviteToken, password: password })
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
