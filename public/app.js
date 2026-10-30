// State
let appState = {
  activeTab: 'watched-repos',
  repositories: [],
  events: [],
  status: null,
  settings: null,
  discordWebhooks: []
};

// DOM Elements
const watchedListEl = document.getElementById('watchedRepoList');
const ownedListEl = document.getElementById('ownedRepoList');
const emptyWatchedEl = document.getElementById('emptyWatched');
const emptyOwnedEl = document.getElementById('emptyOwned');
const activityFeedListEl = document.getElementById('activityFeedList');
const emptyActivityEl = document.getElementById('emptyActivity');

const addModalEl = document.getElementById('addModal');
const settingsModalEl = document.getElementById('settingsModal');
const editRepoModalEl = document.getElementById('editRepoModal');

const addRepoForm = document.getElementById('addRepoForm');
const settingsForm = document.getElementById('settingsForm');
const editRepoForm = document.getElementById('editRepoForm');

const repoInputEl = document.getElementById('repoInput');
const btnValidateRepo = document.getElementById('btnValidateRepo');
const verificationResultEl = document.getElementById('verificationResult');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupModals();
  setupFormHandlers();
  loadData();

  // Poll for status and events updates every 15 seconds
  setInterval(() => {
    loadStatus();
    loadEvents();
  }, 15000);
});

// Setup Tabs
function setupTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      tab.classList.add('active');
      const targetId = `pane-${tab.dataset.tab}`;
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.classList.add('active');
      appState.activeTab = tab.dataset.tab;
    });
  });
}

// Setup Modals
function setupModals() {
  document.getElementById('btnOpenAddModal').addEventListener('click', () => openAddModal());
  document.getElementById('btnCloseAddModal').addEventListener('click', () => closeAddModal());
  document.getElementById('btnCancelAdd').addEventListener('click', () => closeAddModal());

  document.getElementById('btnSettings').addEventListener('click', () => openSettingsModal());
  document.getElementById('btnCloseSettingsModal').addEventListener('click', () => closeSettingsModal());
  document.getElementById('btnCancelSettings').addEventListener('click', () => closeSettingsModal());

  document.getElementById('btnCloseEditModal').addEventListener('click', () => closeEditModal());
  document.getElementById('btnCancelEdit').addEventListener('click', () => closeEditModal());

  document.getElementById('btnRefreshWatched').addEventListener('click', () => loadRepositories());
  document.getElementById('btnRefreshActivity').addEventListener('click', () => loadEvents());

  document.getElementById('btnDiscoverOwned').addEventListener('click', handleAutoDiscovery);
}

function openAddModal(preferredType = 'watched') {
  addModalEl.classList.add('open');
  repoInputEl.value = '';
  verificationResultEl.style.display = 'none';
  verificationResultEl.className = 'verification-banner';

  const radio = document.querySelector(`input[name="repoOwnership"][value="${preferredType}"]`);
  if (radio) radio.checked = true;

  updatePollingVisibility();
  repoInputEl.focus();
}

function closeAddModal() {
  addModalEl.classList.remove('open');
}

function openSettingsModal() {
  settingsModalEl.classList.add('open');
  loadSettings();
}

function closeSettingsModal() {
  settingsModalEl.classList.remove('open');
}

function openEditModal(repoId) {
  const repo = appState.repositories.find(r => String(r.id) === String(repoId));
  if (!repo) return;

  document.getElementById('editRepoId').value = repo.id;
  document.getElementById('editRepoNameDisplay').textContent = repo.full_name;

  const isOwned = Boolean(repo.is_owned);
  const watchedRadio = document.getElementById('editRadioWatched');
  const ownedRadio = document.getElementById('editRadioOwned');
  if (isOwned) {
    ownedRadio.checked = true;
  } else {
    watchedRadio.checked = true;
  }

  // Update polling frequency visibility
  const editPollingGroup = document.getElementById('editPollingIntervalGroup');
  editPollingGroup.style.display = isOwned ? 'none' : 'block';

  // Set frequency
  const intervalSelect = document.getElementById('editPollIntervalInput');
  const intervalVal = String(repo.polling_interval_seconds || 300);
  intervalSelect.value = intervalVal;
  if (!Array.from(intervalSelect.options).some(o => o.value === intervalVal)) {
    const opt = document.createElement('option');
    opt.value = intervalVal;
    opt.textContent = `Every ${Math.round(repo.polling_interval_seconds / 60)} minutes`;
    intervalSelect.appendChild(opt);
    intervalSelect.value = intervalVal;
  }

  // Set Preferences
  const prefs = repo.preferences || {};
  document.getElementById('editPrefReleases').checked = prefs.notify_releases !== 0;
  document.getElementById('editPrefPRs').checked = prefs.notify_pull_requests !== 0;
  document.getElementById('editPrefIssues').checked = prefs.notify_issues !== 0;
  document.getElementById('editPrefPushes').checked = Boolean(prefs.notify_pushes);
  document.getElementById('editPrefStars').checked = Boolean(prefs.notify_stars);
  document.getElementById('editPrefForks').checked = Boolean(prefs.notify_forks);
  document.getElementById('editPrefComments').checked = Boolean(prefs.notify_comments);
  document.getElementById('editPrefReviews').checked = Boolean(prefs.notify_reviews);

  editRepoModalEl.classList.add('open');
}

function closeEditModal() {
  editRepoModalEl.classList.remove('open');
}

function updatePollingVisibility() {
  const isOwned = document.querySelector('input[name="repoOwnership"]:checked')?.value === 'owned';
  const group = document.getElementById('pollingIntervalGroup');
  if (group) {
    group.style.display = isOwned ? 'none' : 'block';
  }
}

document.querySelectorAll('input[name="repoOwnership"]').forEach(el => {
  el.addEventListener('change', updatePollingVisibility);
});

document.querySelectorAll('input[name="editRepoOwnership"]').forEach(el => {
  el.addEventListener('change', () => {
    const isOwned = document.querySelector('input[name="editRepoOwnership"]:checked')?.value === 'owned';
    const group = document.getElementById('editPollingIntervalGroup');
    if (group) {
      group.style.display = isOwned ? 'none' : 'block';
    }
  });
});

// Setup Form Handlers
function setupFormHandlers() {
  // Live Verify button in add modal
  btnValidateRepo.addEventListener('click', async () => {
    const input = repoInputEl.value.trim();
    if (!input) {
      showToast('Please enter a repository identifier or URL.', 'error');
      return;
    }

    btnValidateRepo.disabled = true;
    btnValidateRepo.textContent = 'Checking...';
    verificationResultEl.style.display = 'none';

    try {
      // Test verify via quick check
      const res = await fetch('/api/repositories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input, is_owned: false, verifyOnly: true })
      });
      const data = await res.json();

      verificationResultEl.style.display = 'block';

      if (data.code === 'PRIVATE_REPOSITORY_REJECTED') {
        verificationResultEl.className = 'verification-banner error';
        verificationResultEl.innerHTML = `<strong>⛔ Private Repository:</strong> ${data.error}<br><small>GitHub Discord Bot strictly monitors public repositories.</small>`;
      } else if (data.code === 'REPOSITORY_NOT_FOUND') {
        verificationResultEl.className = 'verification-banner error';
        verificationResultEl.innerHTML = `<strong>⚠️ Not Found:</strong> ${data.error}`;
      } else if (res.status === 409) {
        verificationResultEl.className = 'verification-banner error';
        verificationResultEl.innerHTML = `<strong>ℹ️ Already Monitored:</strong> This repository is already in your watchlist.`;
      } else if (data.success) {
        verificationResultEl.className = 'verification-banner success';
        verificationResultEl.innerHTML = `<strong>✅ Verified Public:</strong> ${data.repository?.full_name} (${data.repository?.stars || 0} ⭐)`;
        // If it was already added, reload
        loadData();
      } else {
        verificationResultEl.className = 'verification-banner error';
        verificationResultEl.innerHTML = `<strong>Error:</strong> ${data.error || 'Failed to verify'}`;
      }
    } catch (err) {
      verificationResultEl.style.display = 'block';
      verificationResultEl.className = 'verification-banner error';
      verificationResultEl.innerHTML = `<strong>Network Error:</strong> ${err.message}`;
    } finally {
      btnValidateRepo.disabled = false;
      btnValidateRepo.textContent = 'Verify';
    }
  });

  // Submit Add Repository
  addRepoForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = repoInputEl.value.trim();
    if (!input) return;

    const isOwned = document.querySelector('input[name="repoOwnership"]:checked')?.value === 'owned';
    const pollingInterval = parseInt(document.getElementById('pollIntervalInput').value, 10) || 300;

    const preferences = {
      notify_releases: document.getElementById('prefReleases').checked,
      notify_pull_requests: document.getElementById('prefPRs').checked,
      notify_issues: document.getElementById('prefIssues').checked,
      notify_pushes: document.getElementById('prefPushes').checked,
      notify_stars: document.getElementById('prefStars').checked,
      notify_forks: document.getElementById('prefForks').checked,
      notify_comments: document.getElementById('prefComments')?.checked || false,
      notify_reviews: document.getElementById('prefReviews')?.checked || false
    };

    const submitBtn = document.getElementById('btnSubmitAdd');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Adding...';

    try {
      const res = await fetch('/api/repositories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input,
          is_owned: isOwned,
          polling_interval_seconds: pollingInterval,
          preferences
        })
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        verificationResultEl.style.display = 'block';
        verificationResultEl.className = 'verification-banner error';
        verificationResultEl.innerHTML = `<strong>Error:</strong> ${data.error}`;
        showToast(data.error || 'Failed to add repository', 'error');
        return;
      }

      showToast(data.message, 'success');
      closeAddModal();
      await loadData();

      // Switch to matching tab
      const tabToActivate = isOwned ? 'tabMyRepos' : 'tabWatched';
      document.getElementById(tabToActivate)?.click();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Start Monitoring';
    }
  });

  // Submit Edit Repository
  editRepoForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('editRepoId').value;
    const isOwned = document.querySelector('input[name="editRepoOwnership"]:checked')?.value === 'owned';
    const pollingInterval = parseInt(document.getElementById('editPollIntervalInput').value, 10) || 300;

    const preferences = {
      notify_releases: document.getElementById('editPrefReleases').checked,
      notify_pull_requests: document.getElementById('editPrefPRs').checked,
      notify_issues: document.getElementById('editPrefIssues').checked,
      notify_pushes: document.getElementById('editPrefPushes').checked,
      notify_stars: document.getElementById('editPrefStars').checked,
      notify_forks: document.getElementById('editPrefForks').checked,
      notify_comments: document.getElementById('editPrefComments').checked,
      notify_reviews: document.getElementById('editPrefReviews').checked
    };

    const submitBtn = document.getElementById('btnSaveEditRepo');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    try {
      const res = await fetch(`/api/repositories/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_owned: isOwned,
          polling_interval_seconds: pollingInterval,
          preferences
        })
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        showToast(data.error || 'Failed to update repository', 'error');
        return;
      }

      showToast(data.message || 'Configuration saved successfully!', 'success');
      closeEditModal();
      await loadRepositories();

      // Switch to matching tab if ownership changed
      const tabToActivate = isOwned ? 'tabMyRepos' : 'tabWatched';
      document.getElementById(tabToActivate)?.click();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save Changes';
    }
  });

  // Add Webhook Channel Row
  const btnAddWh = document.getElementById('btnAddWebhookRow');
  if (btnAddWh) {
    btnAddWh.addEventListener('click', addDiscordWebhookRow);
  }

  // Save Settings
  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const saveBtn = document.getElementById('btnSaveSettings');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
    }

    // Collect all webhooks from the DOM
    syncWebhooksFromDOM();
    const webhooks = appState.discordWebhooks
      .map(w => ({
        id: w.id,
        name: (w.name || 'General').trim(),
        url: (w.url || '').trim(),
        enabled: Boolean(w.enabled)
      }))
      .filter(w => Boolean(w.url));

    const githubOwner = document.getElementById('githubOwnerInput')?.value.trim() || '';
    const githubToken = document.getElementById('githubTokenInput')?.value.trim() || '';
    const webhookSecret = document.getElementById('webhookSecretInput')?.value.trim() || '';
    const adminApiKey = document.getElementById('adminApiKeyInput')?.value.trim() || '';
    const defaultInterval = document.getElementById('defaultPollingIntervalInput')?.value || '300';

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          discord_webhooks: webhooks,
          github_owner: githubOwner,
          github_token: githubToken,
          github_webhook_secret: webhookSecret,
          admin_api_key: adminApiKey,
          default_polling_interval: defaultInterval
        })
      });

      const data = await res.json();
      if (data.success) {
        showToast('Settings saved successfully.', 'success');
        closeSettingsModal();
        loadStatus();
      } else {
        showToast(data.error || 'Failed to save settings', 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save All Settings';
      }
    }
  });
}

// Load All Data
async function loadData() {
  await Promise.all([
    loadRepositories(),
    loadEvents(),
    loadStatus()
  ]);
}

// Load Repositories
async function loadRepositories() {
  try {
    const res = await fetch('/api/repositories');
    const data = await res.json();
    if (data.success) {
      appState.repositories = data.repositories;
      renderRepositories();
    }
  } catch (err) {
    console.error('Failed to load repositories:', err);
  }
}

// Render Repositories
function renderRepositories() {
  const owned = appState.repositories.filter(r => r.is_owned);
  const watched = appState.repositories.filter(r => !r.is_owned);

  document.getElementById('badgeWatched').textContent = watched.length;
  document.getElementById('badgeOwned').textContent = owned.length;
  document.getElementById('metricTotalRepos').textContent = appState.repositories.length;
  document.getElementById('metricOwnedRepos').textContent = owned.length;
  document.getElementById('metricWatchedRepos').textContent = watched.length;

  // Render Watched
  if (watched.length === 0) {
    watchedListEl.innerHTML = '';
    emptyWatchedEl.style.display = 'flex';
  } else {
    emptyWatchedEl.style.display = 'none';
    watchedListEl.innerHTML = watched.map(renderRepoCard).join('');
  }

  // Render Owned
  if (owned.length === 0) {
    ownedListEl.innerHTML = '';
    emptyOwnedEl.style.display = 'flex';
  } else {
    emptyOwnedEl.style.display = 'none';
    ownedListEl.innerHTML = owned.map(renderRepoCard).join('');
  }

  attachRepoCardListeners();
}

function renderRepoCard(repo) {
  const isWebhook = repo.monitoring_type === 'webhook';
  const typeBadge = isWebhook 
    ? `<span class="badge badge-webhook" title="Real-time push delivery via GitHub App Webhook">⚡ Webhook (Real-time)</span>`
    : `<span class="badge badge-polling" title="Interval-based public API polling adapter">🔄 Polling (~${Math.round(repo.polling_interval_seconds / 60)}m)</span>`;

  const healthBadge = `<span class="badge badge-${repo.health_status}">● ${repo.health_status.toUpperCase()}</span>`;

  const prefs = repo.preferences || {};

  return `
    <div class="repo-card ${repo.enabled ? '' : 'disabled'}" data-id="${repo.id}">
      <div class="repo-card-header">
        <div class="repo-title-group">
          <a href="https://github.com/${repo.full_name}" target="_blank" rel="noopener" class="repo-name-link">
            ${repo.full_name} ↗
          </a>
          <div class="repo-badges">
            ${typeBadge}
            ${healthBadge}
          </div>
        </div>
        <label class="switch" title="${repo.enabled ? 'Pause Monitoring' : 'Resume Monitoring'}">
          <input type="checkbox" class="toggle-repo-btn" data-id="${repo.id}" ${repo.enabled ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>

      <div class="repo-meta">
        <span>${repo.health_message || 'Operational'}</span>
        <span>${repo.last_polled_at ? timeAgo(repo.last_polled_at) : 'Never checked'}</span>
      </div>

      <!-- Event Preference Chips -->
      <div class="event-prefs-container">
        <div class="event-prefs-header">
          <span>Active Discord Notification Events</span>
        </div>
        <div class="event-prefs-grid">
          <label class="pref-chip ${prefs.notify_releases ? 'checked' : ''}">
            <input type="checkbox" data-repo-id="${repo.id}" data-pref="notify_releases" ${prefs.notify_releases ? 'checked' : ''}>
            🚀 Releases
          </label>
          <label class="pref-chip ${prefs.notify_pull_requests ? 'checked' : ''}">
            <input type="checkbox" data-repo-id="${repo.id}" data-pref="notify_pull_requests" ${prefs.notify_pull_requests ? 'checked' : ''}>
            🔀 PRs
          </label>
          <label class="pref-chip ${prefs.notify_issues ? 'checked' : ''}">
            <input type="checkbox" data-repo-id="${repo.id}" data-pref="notify_issues" ${prefs.notify_issues ? 'checked' : ''}>
            🐛 Issues
          </label>
          <label class="pref-chip ${prefs.notify_pushes ? 'checked' : ''}">
            <input type="checkbox" data-repo-id="${repo.id}" data-pref="notify_pushes" ${prefs.notify_pushes ? 'checked' : ''}>
            💻 Pushes
          </label>
          <label class="pref-chip ${prefs.notify_stars ? 'checked' : ''}">
            <input type="checkbox" data-repo-id="${repo.id}" data-pref="notify_stars" ${prefs.notify_stars ? 'checked' : ''}>
            ⭐ Stars
          </label>
          <label class="pref-chip ${prefs.notify_forks ? 'checked' : ''}">
            <input type="checkbox" data-repo-id="${repo.id}" data-pref="notify_forks" ${prefs.notify_forks ? 'checked' : ''}>
            🍴 Forks
          </label>
          <label class="pref-chip ${prefs.notify_comments ? 'checked' : ''}">
            <input type="checkbox" data-repo-id="${repo.id}" data-pref="notify_comments" ${prefs.notify_comments ? 'checked' : ''}>
            💬 Comments
          </label>
          <label class="pref-chip ${prefs.notify_reviews ? 'checked' : ''}">
            <input type="checkbox" data-repo-id="${repo.id}" data-pref="notify_reviews" ${prefs.notify_reviews ? 'checked' : ''}>
            👁️ Reviews
          </label>
        </div>
      </div>

      <div class="repo-actions-footer">
        <div style="display: flex; gap: 8px; align-items: center;">
          <button class="btn btn-sm btn-secondary btn-edit-repo" data-id="${repo.id}">
            ⚙️ Configure
          </button>
          ${!isWebhook ? `
            <button class="btn btn-sm btn-ghost btn-poll-now" data-id="${repo.id}">
              ⚡ Poll Now
            </button>
          ` : '<span style="font-size:11px;color:var(--text-dim)">Instant Webhook</span>'}
        </div>
        <button class="btn btn-sm btn-danger btn-delete-repo" data-id="${repo.id}" data-name="${repo.full_name}">
          🗑️ Remove
        </button>
      </div>
    </div>
  `;
}

function attachRepoCardListeners() {
  // Toggle enabled
  document.querySelectorAll('.toggle-repo-btn').forEach(btn => {
    btn.addEventListener('change', async (e) => {
      const id = e.target.dataset.id;
      try {
        const res = await fetch(`/api/repositories/${id}/toggle`, { method: 'PUT' });
        const data = await res.json();
        if (data.success) {
          showToast(`Monitoring ${data.repository.enabled ? 'enabled' : 'paused'} for ${data.repository.full_name}.`, 'info');
          loadRepositories();
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  // Preference Chip click
  document.querySelectorAll('.pref-chip input').forEach(input => {
    input.addEventListener('change', async (e) => {
      const repoId = e.target.dataset.repoId;
      const prefKey = e.target.dataset.pref;
      const isChecked = e.target.checked;

      e.target.parentElement.classList.toggle('checked', isChecked);

      try {
        const res = await fetch(`/api/repositories/${repoId}/preferences`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [prefKey]: isChecked })
        });
        const data = await res.json();
        if (data.success) {
          showToast('Updated notification preferences.', 'info');
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  // Poll Now
  document.querySelectorAll('.btn-poll-now').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.id;
      btn.disabled = true;
      btn.textContent = 'Polling...';
      try {
        const res = await fetch(`/api/repositories/${id}/poll`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast(`Poll complete: ${data.result?.eventsCount || 0} event(s) checked.`, 'success');
          loadData();
        } else {
          showToast(data.error || 'Poll failed', 'error');
        }
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '⚡ Poll Now';
      }
    });
  });

  // Edit Repo Configuration Modal
  document.querySelectorAll('.btn-edit-repo').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.id;
      openEditModal(id);
    });
  });

  // Delete Repo
  document.querySelectorAll('.btn-delete-repo').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.id;
      const name = e.currentTarget.dataset.name;
      if (!confirm(`Are you sure you want to remove ${name} from GitHub Discord Bot?`)) {
        return;
      }
      try {
        const res = await fetch(`/api/repositories/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
          showToast(`Removed ${name} from watchlist.`, 'info');
          loadRepositories();
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

// Load Activity Events
async function loadEvents() {
  try {
    const res = await fetch('/api/events?limit=40');
    const data = await res.json();
    if (data.success) {
      appState.events = data.events;
      renderEvents();
    }
  } catch (err) {
    console.error('Failed to load events:', err);
  }
}

function renderEvents() {
  const events = appState.events;
  document.getElementById('badgeActivity').textContent = events.length;

  const deliveredCount = events.filter(e => e.delivered_to_discord).length;
  document.getElementById('metricDeliveredEvents').textContent = deliveredCount;

  if (events.length === 0) {
    activityFeedListEl.innerHTML = '';
    emptyActivityEl.style.display = 'flex';
    return;
  }

  emptyActivityEl.style.display = 'none';
  activityFeedListEl.innerHTML = events.map(e => {
    const catClass = `cat-${e.event_type || 'default'}`;
    const deliveryTag = e.delivered_to_discord 
      ? '<span class="activity-delivery-tag delivery-success">✓ Dispatched to Discord</span>'
      : '<span class="activity-delivery-tag delivery-skipped">○ Skipped (Filter / Duplicate)</span>';

    return `
      <div class="activity-item">
        <span class="activity-badge-category ${catClass}">${e.event_type}</span>
        <div class="activity-content">
          <div class="activity-header">
            <a href="${e.url || '#'}" target="_blank" rel="noopener" class="activity-title">
              ${escapeHtml(e.title || 'Repository Activity')}
            </a>
            <span class="activity-time">${timeAgo(e.processed_at)}</span>
          </div>
          <div class="activity-summary">${escapeHtml(e.summary || '')}</div>
          <div>${deliveryTag}</div>
        </div>
      </div>
    `;
  }).join('');
}

// Load System Status
async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (data.success && data.summary) {
      const summary = data.summary;

      // Rate limit status
      const rl = summary.rateLimit;
      const rateLimitTextEl = document.getElementById('rateLimitText');
      const rateLimitPill = document.getElementById('rateLimitPill');

      if (rl && rl.limit) {
        rateLimitTextEl.textContent = `API Limit: ${rl.remaining.toLocaleString()} / ${rl.limit.toLocaleString()}`;
        if (rl.remaining < 200) {
          rateLimitPill.className = 'status-pill rate-limit-pill degraded';
        } else {
          rateLimitPill.className = 'status-pill rate-limit-pill healthy';
        }
      } else {
        rateLimitTextEl.textContent = 'API Limit: Ready';
      }

      // Discord status
      const discordPill = document.getElementById('discordPill');
      const discordText = document.getElementById('discordText');
      if (summary.discordConfigured) {
        discordPill.className = 'status-pill discord-pill connected';
        const count = summary.discordWebhooksCount || 1;
        discordText.textContent = count > 1 ? `Discord: ${count} Channels` : 'Discord: Connected';
      } else {
        discordPill.className = 'status-pill discord-pill';
        discordText.textContent = 'Discord: Standby (Mock)';
      }
    }
  } catch (err) {
    console.error('Failed to load status:', err);
  }
}

// -------------------------------------------------------------
// Discord Webhooks Management
// -------------------------------------------------------------

function renderDiscordWebhooksList() {
  const container = document.getElementById('discordWebhooksContainer');
  if (!container) return;

  container.innerHTML = '';
  const webhooks = appState.discordWebhooks || [];

  if (webhooks.length === 0) {
    container.innerHTML = `
      <div class="empty-webhooks-notice">
        No Discord channels configured yet. Click <strong>+ Add Channel</strong> above to add a webhook.
      </div>
    `;
    return;
  }

  webhooks.forEach((wh, index) => {
    const card = document.createElement('div');
    card.className = 'webhook-item-card';
    card.dataset.id = wh.id || `wh_${index}`;

    card.innerHTML = `
      <div class="webhook-fields-row">
        <div>
          <input 
            type="text" 
            class="wh-name-input" 
            placeholder="Channel Name" 
            value="${escapeHtml(wh.name || `Channel ${index + 1}`)}" 
            title="Channel Label (e.g. #general, #alerts)"
          >
        </div>
        <div>
          <input 
            type="url" 
            class="wh-url-input" 
            placeholder="https://discord.com/api/webhooks/..." 
            value="${escapeHtml(wh.url || '')}"
            autocomplete="off"
          >
        </div>
        <div>
          <button type="button" class="btn btn-sm btn-secondary btn-test-wh" title="Send a test embed to this channel">
            Test
          </button>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <label class="webhook-active-toggle" title="Enable or disable delivery to this channel">
            <input type="checkbox" class="wh-enabled-input" ${wh.enabled !== false ? 'checked' : ''}>
            <span>Active</span>
          </label>
          <button type="button" class="btn btn-sm btn-ghost btn-remove-wh" title="Remove this channel" style="color: var(--accent-rose); padding: 4px 8px;">
            ✕
          </button>
        </div>
      </div>
    `;

    // Test button handler
    const testBtn = card.querySelector('.btn-test-wh');
    testBtn.addEventListener('click', async () => {
      const url = card.querySelector('.wh-url-input')?.value.trim();
      if (!url) {
        showToast('Please enter a Discord Webhook URL first.', 'error');
        return;
      }

      const discordRegex = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[a-zA-Z0-9_-]+/;
      if (!discordRegex.test(url)) {
        showToast('Incomplete Webhook URL! It must include both ID and Token (https://discord.com/api/webhooks/<ID>/<TOKEN>). In Discord, click "Copy Webhook URL".', 'error');
        return;
      }
      testBtn.disabled = true;
      testBtn.textContent = 'Sending...';
      try {
        const res = await fetch('/api/settings/discord-test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
        const data = await res.json();
        if (data.success) {
          const chName = card.querySelector('.wh-name-input')?.value.trim() || 'Channel';
          showToast(`Test notification sent to "${chName}" successfully!`, 'success');
        } else {
          showToast(data.error || 'Discord webhook test failed.', 'error');
        }
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = 'Test';
      }
    });

    // Remove button handler
    const removeBtn = card.querySelector('.btn-remove-wh');
    removeBtn.addEventListener('click', () => {
      syncWebhooksFromDOM();
      appState.discordWebhooks = appState.discordWebhooks.filter(w => w.id !== wh.id);
      renderDiscordWebhooksList();
    });

    container.appendChild(card);
  });
}

function syncWebhooksFromDOM() {
  const cards = document.querySelectorAll('.webhook-item-card');
  const list = [];
  cards.forEach(card => {
    list.push({
      id: card.dataset.id || `wh_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: card.querySelector('.wh-name-input')?.value.trim() || 'Channel',
      url: card.querySelector('.wh-url-input')?.value.trim() || '',
      enabled: card.querySelector('.wh-enabled-input')?.checked ?? true
    });
  });
  appState.discordWebhooks = list;
}

function addDiscordWebhookRow() {
  syncWebhooksFromDOM();
  appState.discordWebhooks.push({
    id: `wh_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    name: `Channel ${appState.discordWebhooks.length + 1}`,
    url: '',
    enabled: true
  });
  renderDiscordWebhooksList();
  const lastCard = document.querySelector('.webhook-item-card:last-child .wh-url-input');
  if (lastCard) lastCard.focus();
}

// Load Settings
async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (data.success && data.settings) {
      const s = data.settings;
      appState.discordWebhooks = s.discord_webhooks || [];
      if (appState.discordWebhooks.length === 0) {
        appState.discordWebhooks = [{
          id: `wh_${Date.now()}`,
          name: 'General Alerts',
          url: '',
          enabled: true
        }];
      }
      renderDiscordWebhooksList();

      if (document.getElementById('githubOwnerInput')) {
        document.getElementById('githubOwnerInput').value = s.github_owner || '';
      }
      if (document.getElementById('githubTokenInput')) {
        document.getElementById('githubTokenInput').value = s.github_token || '';
      }
      if (document.getElementById('webhookSecretInput')) {
        document.getElementById('webhookSecretInput').value = s.github_webhook_secret || '';
      }
      if (document.getElementById('adminApiKeyInput')) {
        document.getElementById('adminApiKeyInput').value = s.admin_api_key || '';
      }
      if (document.getElementById('defaultPollingIntervalInput')) {
        document.getElementById('defaultPollingIntervalInput').value = s.default_polling_interval || '300';
      }
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

// Auto-Discovery Trigger
async function handleAutoDiscovery() {
  const btn = document.getElementById('btnDiscoverOwned');
  btn.disabled = true;
  btn.textContent = 'Scanning GitHub...';

  try {
    const res = await fetch('/api/discover', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      const count = data.result?.discovered || 0;
      if (count > 0) {
        showToast(`Discovered ${count} new public repository(s)!`, 'success');
        loadRepositories();
      } else {
        showToast('Auto-discovery complete: No new public repositories found.', 'info');
      }
    } else {
      showToast(data.error || 'Discovery failed. Please verify GitHub token.', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Auto-Discover Now';
  }
}

// Toast Notifications Helper
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
  toast.innerHTML = `<span>${icon}</span><span style="flex: 1; word-break: break-word;">${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 6000);
}

// Utility: Time ago
function timeAgo(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);

  if (seconds < 60) return `${Math.max(1, seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
