/**
 * Horse Racing Selection & Bankroll Tracker
 * Frontend JavaScript Application
 */

const ALL_STATE_CODES = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'];

function createEmptyTrackMap() {
    return ALL_STATE_CODES.reduce((acc, code) => {
        acc[code] = [];
        return acc;
    }, {});
}

function normalizeTrackMap(tracks = {}) {
    return ALL_STATE_CODES.reduce((acc, code) => {
        acc[code] = Array.isArray(tracks[code]) ? tracks[code] : [];
        return acc;
    }, {});
}

function detectAppBasePath() {
    const script = document.currentScript || Array.from(document.scripts)
        .find(item => item.src && item.src.includes('/js/app.js'));
    if (!script || !script.src) {
        return '';
    }

    const scriptPath = new URL(script.src, window.location.href).pathname;
    return scriptPath.replace(/\/js\/app\.js$/, '').replace(/\/$/, '');
}

const APP_BASE_PATH = detectAppBasePath();
const USER_STORAGE_KEY = 'racemate_current_user_id';

function appUrl(path) {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${APP_BASE_PATH}${normalizedPath}`;
}

function getStateOptions(selectedState = '') {
    const states = Array.from(new Set([
        ...Object.keys(state.tracks || {}),
        selectedState
    ].filter(Boolean))).sort();

    return states
        .map(code => `<option value="${code}" ${selectedState === code ? 'selected' : ''}>${code}</option>`)
        .join('');
}

function getTracksForState(stateCode = '') {
    return stateCode
        ? (state.tracks[stateCode] || [])
        : Array.from(new Set(Object.values(state.tracks || {}).flat())).sort((a, b) => a.localeCompare(b));
}

function populateTrackSelect(select, stateCode = '', selectedTrack = '') {
    const tracks = getTracksForState(stateCode);
    select.innerHTML = '<option value="">All tracks</option>' +
        tracks.map(track => `<option value="${track}" ${selectedTrack === track ? 'selected' : ''}>${track}</option>`).join('');
}

function formatRaceDate(dateValue) {
    if (!dateValue) {
        return 'Date TBA';
    }

    const date = new Date(`${dateValue}T00:00:00`);
    if (Number.isNaN(date.getTime())) {
        return dateValue;
    }

    return date.toLocaleDateString(undefined, {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    });
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatBetRunnerLabel(runners = []) {
    const validRunners = (runners || []).filter(runner => runner && runner.horse_name);
    if (validRunners.length === 0) {
        return '';
    }

    return validRunners
        .map(runner => `${runner.saddle_no ? `${runner.saddle_no}. ` : ''}${runner.horse_name}`)
        .join(', ');
}

function downloadJsonFile(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function formatLastImportedRace(settings = {}) {
    const raceNo = settings.last_imported_race_no;
    const track = settings.last_imported_race_track;
    const stateCode = settings.last_imported_race_state;

    if (!raceNo || !track) {
        return 'No race imported yet';
    }

    const raceName = settings.last_imported_race_name ? `: ${settings.last_imported_race_name}` : '';
    const date = settings.last_imported_race_date ? ` • ${formatRaceDate(settings.last_imported_race_date)}` : '';
    return `R${raceNo}${raceName} • ${track}${stateCode ? ` (${stateCode})` : ''}${date}`;
}

// ============ State ============
const state = {
    tracks: createEmptyTrackMap(),
    settings: {},
    bankroll: 0,
    users: [],
    currentUser: null,
    currentUserId: localStorage.getItem(USER_STORAGE_KEY) || '',
    currentMeeting: null,
    currentRace: null,
    activityLogItems: []
};

const BANKROLL_PERIODS = [
    ['all_time', 'All Time'],
    ['today', 'Today'],
    ['last_7_days', 'Last 7 days'],
    ['last_month', 'Last month'],
    ['last_quarter', 'Last Quarter'],
    ['last_6_months', 'Last 6 months'],
    ['last_12_months', 'Last 12 months']
];

// ============ API Helpers ============
async function api(endpoint, options = {}) {
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (state.currentUserId) {
            headers['X-Racemate-User-Id'] = String(state.currentUserId);
        }
        const res = await fetch(appUrl(`/api${endpoint}`), {
            headers,
            ...options,
            body: options.body ? JSON.stringify(options.body) : undefined
        });
        const data = await res.json();
        if (!res.ok) {
            const err = new Error(data.error || 'API Error');
            err.details = data;
            throw err;
        }
        return data;
    } catch (err) {
        if (!options.silentError) {
            toast(err.message, 'error');
        }
        throw err;
    }
}

async function uploadFile(endpoint, file) {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(appUrl(`/api${endpoint}`), { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    return data;
}

// ============ Toast Notifications ============
function toast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

// ============ Router ============
const routes = {
    '/home': renderToday,
    '/today': renderToday,
    '/horses': renderHorseProfiles,
    '/race': renderRace,
    '/bet': renderBet,
    '/results': renderResults,
    '/bankroll': renderBankroll,
    '/logs': renderLogs,
    '/settings': renderSettings
};

function navigate(hash) {
    window.location.hash = hash;
}

async function handleRoute() {
    const hash = window.location.hash || '#/home';
    const [path, id] = hash.slice(1).split('/').filter(Boolean);
    const route = `/${path}`;
    const activePath = path === 'today' ? 'home' : path;
    
    // Update nav active state
    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.toggle('active', link.dataset.route === activePath);
    });
    
    // Render view
    if (routes[route]) {
        await routes[route](id);
    } else {
        await renderToday();
    }
}

// ============ Initialize ============
async function loadUsers() {
    const data = await api('/users');
    state.users = data.users || [];
    const savedUser = state.currentUserId
        ? state.users.find(user => String(user.id) === String(state.currentUserId))
        : null;
    state.currentUser = savedUser || data.current_user || state.users[0] || null;
    state.currentUserId = state.currentUser ? String(state.currentUser.id) : '';
    if (state.currentUserId) {
        localStorage.setItem(USER_STORAGE_KEY, state.currentUserId);
    }
    renderUserSelect();
}

function renderUserSelect() {
    const select = document.getElementById('user-select');
    if (!select) return;
    select.innerHTML = (state.users || [])
        .map(user => `<option value="${user.id}" ${String(user.id) === String(state.currentUserId) ? 'selected' : ''}>${escapeHtml(user.name)}</option>`)
        .join('');
}

async function refreshUserScopedState() {
    state.settings = await api('/settings');
    const bankrollData = await api('/bankroll');
    state.bankroll = bankrollData.bankroll;
    updateBankrollDisplay();
}

async function init() {
    // Load initial data
    try {
        await loadUsers();
        state.tracks = normalizeTrackMap(await api('/tracks'));
        await refreshUserScopedState();
    } catch (err) {
        console.error('Init error:', err);
    }
    
    // Setup nav toggle
    document.getElementById('nav-toggle').addEventListener('click', () => {
        document.getElementById('nav-links').classList.toggle('show');
    });

    document.getElementById('user-select')?.addEventListener('change', async (event) => {
        state.currentUserId = event.target.value;
        localStorage.setItem(USER_STORAGE_KEY, state.currentUserId);
        state.currentUser = state.users.find(user => String(user.id) === String(state.currentUserId)) || null;
        await refreshUserScopedState();
        await handleRoute();
    });

    document.getElementById('create-user-btn')?.addEventListener('click', async () => {
        const name = window.prompt('New user profile name');
        if (!name || !name.trim()) return;
        const user = await api('/users', { method: 'POST', body: { name: name.trim() } });
        state.currentUserId = String(user.id);
        localStorage.setItem(USER_STORAGE_KEY, state.currentUserId);
        await loadUsers();
        await refreshUserScopedState();
        await handleRoute();
    });
    
    // Initial route
    await handleRoute();
}

function updateBankrollDisplay() {
    const el = document.getElementById('nav-bankroll');
    el.textContent = `$${state.bankroll.toFixed(2)}`;
    el.style.background = state.bankroll > 0 ? 'var(--success)' : 'var(--danger)';
}

// ============ View: Today ============
async function renderToday() {
    const app = document.getElementById('app');
    const savedState = '';
    const savedTrack = '';
    const savedDate = '';
    const stateCodes = Array.from(new Set([
        ...Object.keys(state.tracks || {}),
        savedState
    ].filter(Boolean))).sort();
    const stateOptions = stateCodes
        .map(code => `<option value="${code}" ${savedState === code ? 'selected' : ''}>${code}</option>`)
        .join('');
    
    app.innerHTML = `
        <div class="card">
            <h2 class="card-title">🏠 Home Dashboard</h2>
            <button onclick="navigate('#/settings')" class="btn btn-outline btn-block mb-2">Import Form Guide</button>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">State</label>
                    <select id="state-select" class="form-control">
                        <option value="">All states</option>
                        ${stateOptions}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Track</label>
                    <select id="track-select" class="form-control">
                        <option value="">All tracks</option>
                    </select>
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">Date</label>
                <select id="date-select" class="form-control">
                    <option value="">All dates</option>
                    ${savedDate ? `<option value="${savedDate}" selected>${formatRaceDate(savedDate)}</option>` : ''}
                </select>
            </div>
            <button id="refresh-dashboard-btn" class="btn btn-primary btn-block">Refresh Dashboard</button>
        </div>
        <div id="meeting-content"></div>
    `;
    
    // Populate tracks
    const stateSelect = document.getElementById('state-select');
    const trackSelect = document.getElementById('track-select');
    const dateSelect = document.getElementById('date-select');
    const content = document.getElementById('meeting-content');
    
    function updateTracks() {
        const selectedState = stateSelect.value;
        const tracks = selectedState
            ? (state.tracks[selectedState] || [])
            : Array.from(new Set(Object.values(state.tracks || {}).flat())).sort((a, b) => a.localeCompare(b));
        trackSelect.innerHTML = '<option value="">All tracks</option>' +
            tracks.map(t => `<option value="${t}">${t}</option>`).join('');
        if (selectedState === savedState && savedTrack && tracks.includes(savedTrack)) {
            trackSelect.value = savedTrack;
        }
    }

    function updateDashboardDateOptions(dates, select, selectedDate = '') {
        const uniqueDates = [...new Set((dates || []).filter(Boolean))].sort((a, b) => b.localeCompare(a));
        select.innerHTML = '<option value="">All dates</option>' +
            uniqueDates.map(date => `<option value="${date}" ${date === selectedDate ? 'selected' : ''}>${formatRaceDate(date)}</option>`).join('');
        select.value = selectedDate || '';
    }

    function mergeImportedTrackOptions(tracksByState = {}) {
        Object.entries(tracksByState).forEach(([stateCode, tracks]) => {
            if (!stateCode || !Array.isArray(tracks)) return;
            const merged = new Set([...(state.tracks[stateCode] || []), ...tracks.filter(Boolean)]);
            state.tracks[stateCode] = Array.from(merged).sort((a, b) => a.localeCompare(b));
        });
    }

    function updateDashboardStateOptions(selectedState = '') {
        const states = Array.from(new Set([
            ...Object.keys(state.tracks || {}),
            selectedState
        ].filter(Boolean))).sort();
        stateSelect.innerHTML = '<option value="">All states</option>' +
            states.map(code => `<option value="${code}" ${selectedState === code ? 'selected' : ''}>${code}</option>`).join('');
    }

    async function loadDashboard() {
        const stateVal = stateSelect.value;
        const trackVal = trackSelect.value;
        const dateVal = dateSelect.value || '';

        content.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

        const params = new URLSearchParams();
        if (dateVal) params.set('date', dateVal);
        if (stateVal) params.set('state', stateVal);
        if (trackVal) params.set('track', trackVal);

        try {
            const data = await api(`/dashboard?${params.toString()}`);

            state.settings.last_state = stateVal || state.settings.last_state;
            state.settings.last_track = trackVal || state.settings.last_track;
            state.settings.last_date = dateVal;
            mergeImportedTrackOptions(data.available_tracks_by_state || {});
            updateDashboardStateOptions(stateVal);
            updateDashboardDateOptions(data.available_dates || [], dateSelect, dateVal);
            updateTracks();
            if (trackVal) {
                trackSelect.value = trackVal;
            }

            if (!data.meetings || data.meetings.length === 0) {
                content.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-state-icon">📋</div>
                        <div class="empty-state-text">No races found${dateVal ? ` for ${formatRaceDate(dateVal)}` : ''}</div>
                        <a href="#/settings" class="btn btn-primary">Import Form Guide</a>
                    </div>
                `;
                return;
            }

            const sortedMeetings = [...data.meetings].sort((a, b) => {
                const dateCompare = String(a.meeting?.date || '').localeCompare(String(b.meeting?.date || ''));
                if (dateCompare !== 0) return dateCompare;
                const trackCompare = String(a.meeting?.track || '').localeCompare(String(b.meeting?.track || ''));
                if (trackCompare !== 0) return trackCompare;
                return String(a.meeting?.state || '').localeCompare(String(b.meeting?.state || ''));
            }).map(item => ({
                ...item,
                races: [...(item.races || [])].sort((a, b) => Number(a.race_no || 0) - Number(b.race_no || 0))
            }));

            content.innerHTML = `
                <div class="section-heading mb-1">Results</div>
                <div class="stats-grid mb-2">
                    <div class="stat-card">
                        <div class="stat-value">${data.summary.meetings}</div>
                        <div class="stat-label">Meetings</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${data.summary.races}</div>
                        <div class="stat-label">Races</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${data.summary.pending_bets}</div>
                        <div class="stat-label">Pending Bets</div>
                    </div>
                </div>
                ${sortedMeetings.map(item => `
                    <div class="card">
                        <h2 class="card-title">${formatRaceDate(item.meeting.date)} - ${item.meeting.track} (${item.meeting.state})</h2>
                        ${item.races.length === 0 ? '<div class="empty-state">No races found</div>' : item.races.map(race => `
                            <div class="runner-item ${!race.result_entered
                                ? 'runner-result-neutral'
                                : /won/i.test(race.outcome_text || '')
                                    ? 'runner-result-win'
                                    : /lost|no win/i.test(race.outcome_text || '')
                                        ? 'runner-result-lost'
                                        : 'runner-result-neutral'}">
                                <div class="runner-info">
                                    <div class="runner-name">R${race.race_no}: ${race.race_name || `Race ${race.race_no}`}</div>
                                    ${formatBetRunnerLabel(race.bet_runners) ? `<div class="runner-name bet-runner-name"><strong>${escapeHtml(formatBetRunnerLabel(race.bet_runners))}</strong></div>` : ''}
                                    <div class="runner-meta">
                                        ${formatRaceDate(item.meeting.date)} • ${race.distance || '-'}m • ${race.pending_bets > 0 ? `Pending bets: ${race.pending_bets}` : 'No Bet Recommended'}
                                        ${race.result_entered ? ` • Results: ${race.placings?.first || '-'}-${race.placings?.second || '-'}-${race.placings?.third || '-'} • ${race.outcome_text || 'No win'}` : ''}
                                    </div>
                                </div>
                                <div class="flex gap-1">
                                    <button class="btn btn-outline btn-sm" onclick="navigate('#/race/${race.id}')">Open Race</button>
                                    <button class="btn btn-primary btn-sm" onclick="navigate('#/results/${race.id}')">Enter Results</button>
                                    <button class="btn btn-danger btn-sm" onclick="deleteRaceFromHome(${race.id})">Delete</button>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                `).join('')}
            `;
        } catch (err) {
            content.innerHTML = `<div class="empty-state"><div class="empty-state-text text-danger">${err.message}</div></div>`;
        }
    }
    
    stateSelect.addEventListener('change', updateTracks);
    trackSelect.addEventListener('change', () => {});
    updateTracks();
    stateSelect.value = '';
    if (savedTrack && state.tracks[savedState]?.includes(savedTrack)) {
        trackSelect.value = savedTrack;
    }
    
    document.getElementById('refresh-dashboard-btn').addEventListener('click', async () => {
        await api('/settings', {
            method: 'POST',
            body: {
                last_state: stateSelect.value || state.settings.last_state || '',
                last_track: trackSelect.value || '',
                last_date: dateSelect.value || ''
            }
        });
        await loadDashboard();
    });

    async function loadImportedRacingData() {
        racingImportContent.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
        try {
            const data = await api('/racing/meetings/today');
            racingImportStatus.textContent = data.last_imported_at
                ? `Last imported: ${new Date(data.last_imported_at).toLocaleString()}`
                : 'No import run yet';

            if (!data.meetings || data.meetings.length === 0) {
                racingImportContent.innerHTML = '<div class="empty-state">No meetings imported yet</div>';
                return;
            }

            const meetingSections = [];
            for (const meeting of data.meetings) {
                const raceData = await api(`/racing/meetings/${meeting.id}/races`);
                const raceRows = [];
                for (const race of raceData.races || []) {
                    const runnerData = await api(`/racing/races/${race.id}/runners`);
                    raceRows.push(`
                        <div class="runner-item runner-result-neutral">
                            <div class="runner-info">
                                <div class="runner-name">R${race.race_no}: ${escapeHtml(race.race_name || `Race ${race.race_no}`)}</div>
                                <div class="runner-meta">${escapeHtml(race.start_time || 'TBA')} • ${race.distance || '-'}m • ${escapeHtml(race.status || 'scheduled')}</div>
                                <div class="table-wrap mt-1">
                                    <table class="table">
                                        <thead>
                                            <tr>
                                                <th>No</th>
                                                <th>Horse</th>
                                                <th>Barrier</th>
                                                <th>Weight</th>
                                                <th>Jockey</th>
                                                <th>Trainer</th>
                                                <th>Win</th>
                                                <th>Place</th>
                                                <th>Status</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            ${(runnerData.runners || []).map(runner => `
                                                <tr>
                                                    <td>${runner.saddle_no || ''}</td>
                                                    <td>${escapeHtml(runner.horse_name || '')}</td>
                                                    <td>${runner.barrier || ''}</td>
                                                    <td>${runner.weight || ''}</td>
                                                    <td>${escapeHtml(runner.jockey || '')}</td>
                                                    <td>${escapeHtml(runner.trainer || '')}</td>
                                                    <td>${runner.odds_win || ''}</td>
                                                    <td>${runner.odds_place || ''}</td>
                                                    <td>${runner.scratched ? 'Scratched' : 'Active'}</td>
                                                </tr>
                                            `).join('')}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    `);
                }

                meetingSections.push(`
                    <div class="mb-2">
                        <div class="section-heading">${escapeHtml(meeting.track)} (${escapeHtml(meeting.state)}) • ${formatRaceDate(meeting.date)}</div>
                        ${raceRows.length ? raceRows.join('') : '<div class="empty-state">No races imported yet</div>'}
                    </div>
                `);
            }

            racingImportContent.innerHTML = meetingSections.join('');
        } catch (err) {
            racingImportContent.innerHTML = `<div class="empty-state text-danger">Import failed: ${escapeHtml(err.message)}</div>`;
        }
    }

    loadDashboard();
}

async function renderHorseProfiles(horseId) {
    const app = document.getElementById('app');
    app.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

    if (horseId) {
        try {
            const data = await api(`/horses/${horseId}`);
            const horse = data.horse;
            const summary = data.summary || {};
            const appearances = data.appearances || [];
            app.innerHTML = `
                <div class="flex flex-between flex-center mb-2 horse-profile-heading">
                    <button class="btn btn-outline" onclick="navigate('#/horses')">&larr; Horse Profiles</button>
                </div>
                <div class="card">
                    <div class="horse-profile-title">
                        <div>
                            <h1>${escapeHtml(horse.display_name)}</h1>
                            <div class="text-muted">
                                ${horse.latest_trainer ? `Trainer: ${escapeHtml(horse.latest_trainer)}` : 'Trainer not recorded'}
                                ${horse.last_seen_date ? ` &bull; Last seen ${formatRaceDate(horse.last_seen_date)}` : ''}
                            </div>
                        </div>
                    </div>
                    <div class="stats-grid mt-2">
                        <div class="stat-card">
                            <div class="stat-value">${summary.appearances || 0}</div>
                            <div class="stat-label">Stored Runs</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-value">${summary.wins || 0}</div>
                            <div class="stat-label">Recorded Wins</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-value">${summary.places || 0}</div>
                            <div class="stat-label">Recorded Top 3</div>
                        </div>
                    </div>
                </div>
                <div class="card">
                    <h2 class="card-title">Race History</h2>
                    ${appearances.length === 0
                        ? '<div class="empty-state">No retained race appearances</div>'
                        : appearances.map(run => `
                            <div class="horse-history-row">
                                <div class="horse-history-main">
                                    <div class="runner-name">${formatRaceDate(run.date)} &bull; ${escapeHtml(run.track)} (${escapeHtml(run.state)}) &bull; R${run.race_no}</div>
                                    <div class="runner-meta">${escapeHtml(run.race_name || `Race ${run.race_no}`)} &bull; ${run.start_time ? escapeHtml(run.start_time) : 'Time TBA'} &bull; ${run.distance || '-'}m</div>
                                    <div class="runner-meta">
                                        No. ${run.saddle_no || '-'} &bull; Barrier ${run.barrier || '-'} &bull; ${run.weight || '-'}kg
                                        &bull; Jockey ${escapeHtml(run.jockey || '-')} &bull; Trainer ${escapeHtml(run.trainer || '-')}
                                    </div>
                                    <div class="runner-meta">
                                        Form ${escapeHtml(run.form_string || '-')} &bull; Rating ${run.rating || '-'}
                                        &bull; Win odds ${run.odds_win ? `$${Number(run.odds_win).toFixed(2)}` : '-'}
                                    </div>
                                </div>
                                <div class="horse-history-result">
                                    ${run.scratched
                                        ? '<span class="status-badge pending">Scratched</span>'
                                        : run.finishing_position
                                            ? `<span class="status-badge ${Number(run.finishing_position) === 1 ? 'won' : 'placed'}">${Number(run.finishing_position)}${Number(run.finishing_position) === 1 ? 'st' : Number(run.finishing_position) === 2 ? 'nd' : Number(run.finishing_position) === 3 ? 'rd' : 'th'}</span>`
                                            : '<span class="status-badge pending">Result pending</span>'}
                                    <button class="btn btn-outline btn-sm" onclick="navigate('#/race/${run.race_id}')">Open Race</button>
                                </div>
                            </div>
                        `).join('')}
                </div>
            `;
        } catch (err) {
            app.innerHTML = `<div class="empty-state text-danger">${escapeHtml(err.message)}</div>`;
        }
        return;
    }

    try {
        const [catalogue, importData] = await Promise.all([
            api('/horses'),
            api('/racing/meetings/today')
        ]);
        const horses = catalogue.horses || [];
        const profileSummary = catalogue.summary || {};
        const importSummary = importData.summary || {};

        app.innerHTML = `
            <div class="card">
                <div class="horse-page-toolbar">
                    <div>
                        <h1 class="page-title">Horse Profiles</h1>
                        <div class="text-muted">Permanent profiles built from imported race appearances.</div>
                    </div>
                    <div class="horse-search">
                        <input id="horse-search-input" class="form-control" type="search" placeholder="Search horse or trainer" aria-label="Search horse profiles">
                        <button id="horse-search-btn" class="btn btn-outline">Search</button>
                    </div>
                </div>
                <div class="stats-grid mt-2">
                    <div class="stat-card">
                        <div class="stat-value">${profileSummary.profiles || horses.length}</div>
                        <div class="stat-label">Horse Profiles</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${profileSummary.appearances || 0}</div>
                        <div class="stat-label">Stored Runs</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${profileSummary.repeat_runners || 0}</div>
                        <div class="stat-label">Repeat Runners</div>
                    </div>
                </div>
            </div>
            <div class="card">
                <div class="flex flex-between flex-center horse-import-toolbar">
                    <div>
                        <h2 class="card-title">Automated Racing Import</h2>
                        <div id="horse-import-status" class="text-muted">
                            ${importData.last_imported_at
                                ? `Last imported ${new Date(importData.last_imported_at).toLocaleString()}`
                                : 'No automated import run yet'}
                        </div>
                        <div id="horse-import-summary" class="runner-meta">
                            Today: ${importSummary.meetings || 0} meetings &bull; ${importSummary.races || 0} races &bull; ${importSummary.runners || 0} runners
                        </div>
                    </div>
                    <div class="horse-import-actions">
                        <select id="horse-import-provider" class="form-control">
                            <option value="sample" ${(state.settings.racing_provider || 'sample') === 'sample' ? 'selected' : ''}>Sample</option>
                            <option value="racenet" ${state.settings.racing_provider === 'racenet' ? 'selected' : ''}>Racenet feed</option>
                            <option value="tab" ${state.settings.racing_provider === 'tab' ? 'selected' : ''}>TAB API</option>
                        </select>
                        <button id="horse-import-btn" class="btn btn-primary">Import Today's Meetings</button>
                    </div>
                </div>
            </div>
            <div class="card">
                <div class="flex flex-between flex-center mb-2">
                    <h2 class="card-title">Profile Catalogue</h2>
                    <div id="horse-result-count" class="text-muted">Showing ${horses.length} of ${profileSummary.profiles || horses.length} profiles</div>
                </div>
                <div id="horse-profile-list">${renderHorseProfileRows(horses)}</div>
            </div>
        `;

        const searchInput = document.getElementById('horse-search-input');
        const profileList = document.getElementById('horse-profile-list');
        const resultCount = document.getElementById('horse-result-count');

        async function runHorseSearch() {
            profileList.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
            try {
                const result = await api(`/horses?search=${encodeURIComponent(searchInput.value.trim())}`);
                const matches = result.horses || [];
                resultCount.textContent = `${matches.length} ${matches.length === 1 ? 'profile' : 'profiles'}`;
                profileList.innerHTML = renderHorseProfileRows(matches);
            } catch (err) {
                profileList.innerHTML = `<div class="empty-state text-danger">${escapeHtml(err.message)}</div>`;
            }
        }

        document.getElementById('horse-search-btn').addEventListener('click', runHorseSearch);
        searchInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') runHorseSearch();
        });

        document.getElementById('horse-import-btn').addEventListener('click', async event => {
            const button = event.currentTarget;
            const providerSelect = document.getElementById('horse-import-provider');
            const status = document.getElementById('horse-import-status');
            const summary = document.getElementById('horse-import-summary');
            const provider = providerSelect?.value || state.settings.racing_provider || 'sample';
            button.disabled = true;
            status.textContent = `Importing today's meetings via ${provider}...`;
            try {
                const result = await api('/racing/import/today', {
                    method: 'POST',
                    body: { provider }
                });
                const imported = result.summary || {};
                state.settings.racing_provider = provider;
                status.textContent = result.success ? 'Import completed successfully' : 'Import completed with warnings';
                summary.textContent = `${imported.meetings || 0} meetings • ${imported.races || 0} races • ${imported.runners || 0} runners`;
                toast(status.textContent, result.success ? 'success' : 'warning');
                await renderHorseProfiles();
            } catch (err) {
                status.textContent = 'Import failed';
            } finally {
                button.disabled = false;
            }
        });
    } catch (err) {
        app.innerHTML = `<div class="empty-state text-danger">${escapeHtml(err.message)}</div>`;
    }
}

function renderHorseProfileRows(horses) {
    if (!horses.length) {
        return '<div class="empty-state">No horse profiles found</div>';
    }

    return horses.map(horse => `
        <button class="horse-profile-row" type="button" onclick="navigate('#/horses/${horse.id}')">
            <span class="horse-profile-name">${escapeHtml(horse.display_name)}</span>
            <span class="horse-profile-meta">
                ${Number(horse.appearances || 0)} stored ${Number(horse.appearances || 0) === 1 ? 'run' : 'runs'}
                ${horse.latest_trainer ? ` &bull; ${escapeHtml(horse.latest_trainer)}` : ''}
                ${horse.latest_race_date ? ` &bull; Last seen ${formatRaceDate(horse.latest_race_date)}` : ''}
            </span>
            <span class="horse-profile-arrow" aria-hidden="true">&rsaquo;</span>
        </button>
    `).join('');
}

async function deleteRaceFromHome(raceId) {
    const confirmed = window.confirm('Delete this race and its runners, selections, bets, and results?\n\nThis cannot be undone.');
    if (!confirmed) return;

    try {
        await api(`/races/${raceId}`, { method: 'DELETE' });
        toast('Race deleted', 'success');
        await renderToday();
    } catch (err) {}
}
window.deleteRaceFromHome = deleteRaceFromHome;

async function loadMeeting() {
    const stateVal = document.getElementById('state-select').value;
    const track = document.getElementById('track-select').value;
    const dateInput = document.getElementById('date-select');
    const date = dateInput.value || new Date().toISOString().split('T')[0];
    dateInput.value = date;
    const loadBtn = document.getElementById('load-meeting-btn');
    
    if (!track) {
        toast('Please select a track', 'warning');
        return;
    }
    
    const content = document.getElementById('meeting-content');
    content.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    loadBtn.disabled = true;
    loadBtn.textContent = 'Loading...';
    
    try {
        // Save selection
        await api('/settings/track', { method: 'POST', body: { state: stateVal, track, date } });
        state.settings.last_state = stateVal;
        state.settings.last_track = track;
        state.settings.last_date = date;
        
        const data = await api(`/meeting?state=${stateVal}&track=${track}&date=${date}`);
        
        if (!data.found) {
            content.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">📋</div>
                    <div class="empty-state-text">No meeting data found for ${track} on ${date}</div>
                    <a href="#/settings" class="btn btn-primary">Import Form Guide</a>
                </div>
            `;
            return;
        }
        
        state.currentMeeting = data.meeting;
        renderRacesList(data.races, content);
        
    } catch (err) {
        content.innerHTML = `<div class="empty-state"><div class="empty-state-text text-danger">${err.message}</div></div>`;
        toast(`Load meeting failed: ${err.message}`, 'error');
    } finally {
        loadBtn.disabled = false;
        loadBtn.textContent = 'Load Meeting';
    }
}

function renderRacesList(races, container) {
    if (!races || races.length === 0) {
        container.innerHTML = '<div class="empty-state">No races found</div>';
        return;
    }
    
    container.innerHTML = `
        <div class="card">
            <h2 class="card-title">🏁 Races</h2>
            ${races.map(race => `
                <div class="runner-item" style="cursor:pointer" onclick="navigate('#/race/${race.id}')">
                    <div class="runner-number">${race.race_no}</div>
                    <div class="runner-info">
                        <div class="runner-name">${race.race_name || 'Race ' + race.race_no}</div>
                        <div class="runner-meta">${formatRaceDate(state.currentMeeting?.date)} • ${race.distance}m • ${race.track_condition || 'TBA'} • ${race.start_time || ''}</div>
                    </div>
                    <div class="runner-odds">
                        <span class="badge badge-primary">View</span>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

// ============ View: Race ============
async function renderRace(raceId) {
    const app = document.getElementById('app');
    app.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    
    try {
        const race = await api(`/races/${raceId}`);
        state.currentRace = race;
        const editStateValue = race.meeting.state || state.settings.last_state || '';
        const editTrackValue = race.meeting.track || state.settings.last_track || '';
        
        // Run analysis
        const analysis = await api(`/races/${raceId}/analyze`, { method: 'POST' });
        
        app.innerHTML = `
            <button onclick="navigate('#/home')" class="btn btn-outline mb-2">← Back</button>
            
            <div class="card">
                <h2 class="card-title">Race ${race.race_no}: ${race.race_name || ''}</h2>
                <div class="text-muted">${formatRaceDate(race.meeting.date)} • ${race.meeting.track} (${race.meeting.state}) • ${race.distance}m • ${race.track_condition || 'TBA'}</div>
                <button id="toggle-edit-race-btn" class="btn btn-outline btn-sm mt-1">Edit Race</button>
                <div id="edit-race-panel" class="hidden mt-2">
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">Date</label>
                            <input type="date" id="edit-date" class="form-control" value="${race.meeting.date || ''}">
                        </div>
                        <div class="form-group">
                            <label class="form-label">State</label>
                            <select id="edit-state" class="form-control">
                                ${getStateOptions(editStateValue)}
                            </select>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Track</label>
                            <select id="edit-track" class="form-control"></select>
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">Race No</label>
                            <input type="number" min="1" step="1" id="edit-race-no" class="form-control" value="${race.race_no || ''}">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Distance (m)</label>
                            <input type="number" min="1" step="1" id="edit-distance" class="form-control" value="${race.distance || ''}">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Track Condition</label>
                            <input type="text" id="edit-condition" class="form-control" value="${race.track_condition || ''}" placeholder="e.g. Soft 6">
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Race Name</label>
                        <input type="text" id="edit-race-name" class="form-control" value="${race.race_name || ''}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Race Class</label>
                        <input type="text" id="edit-race-class" class="form-control" value="${race.race_class || ''}">
                    </div>
                    <button id="save-race-meta-btn" class="btn btn-primary">Save Changes</button>
                    <div id="edit-race-status" class="mt-1 text-muted"></div>
                </div>
            </div>
            
            ${renderSelectionCard(analysis)}
            
            <div class="card">
                <h2 class="card-title">📊 Field</h2>
                ${renderRunnersList(race.runners, analysis.allSelections)}
            </div>
        `;

        const toggleEditBtn = document.getElementById('toggle-edit-race-btn');
        const editPanel = document.getElementById('edit-race-panel');
        const saveMetaBtn = document.getElementById('save-race-meta-btn');
        const editStatus = document.getElementById('edit-race-status');
        const editStateSelect = document.getElementById('edit-state');
        const editTrackSelect = document.getElementById('edit-track');

        populateTrackSelect(editTrackSelect, editStateValue, editTrackValue);
        editStateSelect?.addEventListener('change', () => {
            populateTrackSelect(editTrackSelect, editStateSelect.value, '');
        });

        toggleEditBtn?.addEventListener('click', () => {
            editPanel.classList.toggle('hidden');
        });

        saveMetaBtn?.addEventListener('click', async () => {
            const payload = {
                date: document.getElementById('edit-date').value,
                state: (editStateSelect.value || '').trim().toUpperCase(),
                track: (editTrackSelect.value || '').trim(),
                race_no: parseInt(document.getElementById('edit-race-no').value, 10),
                race_name: (document.getElementById('edit-race-name').value || '').trim(),
                distance: parseInt(document.getElementById('edit-distance').value, 10),
                track_condition: (document.getElementById('edit-condition').value || '').trim(),
                race_class: (document.getElementById('edit-race-class').value || '').trim()
            };

            editStatus.textContent = 'Saving...';
            try {
                await api(`/races/${raceId}/meta`, { method: 'PUT', body: payload });
                editStatus.innerHTML = '<span class="text-success">Saved. Reloading race...</span>';
                toast('Race details updated', 'success');
                await renderRace(raceId);
            } catch (err) {
                editStatus.innerHTML = `<span class="text-danger">${err.message}</span>`;
            }
        });
        
    } catch (err) {
        app.innerHTML = `<div class="empty-state"><div class="empty-state-text text-danger">${err.message}</div></div>`;
    }
}

function renderSelectionCard(analysis) {
    if (analysis.status === 'skip' || !analysis.recommendation) {
        return `
            <div class="selection-card skip">
                <div class="selection-header">
                    <div class="selection-horse">No Bet Recommended</div>
                    <button onclick="skipRace()" class="selection-status" style="cursor:pointer;border:none;">SKIP</button>
                </div>
                <div class="selection-details">
                    <div>No runners meet the betting thresholds</div>
                </div>
                ${analysis.skipReasons?.length ? `
                    <div class="selection-factors">
                        <div class="text-muted">Top reasons:</div>
                        ${analysis.skipReasons.map(r => `<div class="factor-item">${formatSkipReason(r, analysis)}</div>`).join('')}
                    </div>
                ` : ''}
                <div class="selection-actions">
                    <button onclick="navigate('#/settings')" class="btn btn-light">Place another bet</button>
                </div>
            </div>
        `;
    }
    
    const rec = analysis.recommendation;
    const exp = rec.explanation || {};
    
    return `
        <div class="selection-card">
            <div class="selection-header">
                <div>
                    <div class="selection-horse">${rec.saddle_no}. ${rec.horse_name}</div>
                </div>
                <div class="selection-status">BET</div>
            </div>
            <div class="selection-details">
                <div>Win Odds: <strong>$${rec.odds_win?.toFixed(2) || 'N/A'}</strong></div>
                <div>Place Odds: <strong>$${rec.odds_place?.toFixed(2) || 'N/A'}</strong></div>
                <div>Win Prob: <strong>${(rec.prob_win_est * 100).toFixed(1)}%</strong></div>
                <div>EV Win: <strong class="${rec.ev_win > 0 ? 'text-success' : ''}">${rec.ev_win?.toFixed(3) || 'N/A'}</strong></div>
            </div>
            ${exp.factors?.length ? `
                <div class="selection-factors">
                    <div style="margin-bottom:8px;font-weight:600">Why this horse?</div>
                    ${exp.factors.slice(0, 4).map(f => `
                        <div class="factor-item">
                            <span>${f.description}</span>
                            <span>${f.score.toFixed(0)}/100</span>
                        </div>
                        <div class="factor-bar"><div class="factor-bar-fill" style="width:${f.score}%"></div></div>
                    `).join('')}
                </div>
            ` : ''}
            <button onclick="navigate('#/bet/${rec.runner_id}')" class="btn btn-success btn-block mt-2">
                Place Bet
            </button>
        </div>
    `;
}

function formatSkipReason(reason, analysis) {
    const text = String(reason || '');
    if (/^\s*\d+\.\s+/.test(text)) {
        return text;
    }

    const horseToSaddle = {};
    (analysis?.allSelections || []).forEach(sel => {
        const key = String(sel.horse_name || '').trim().toLowerCase();
        if (key) horseToSaddle[key] = sel.saddle_no;
    });

    const [horseNameRaw, ...rest] = text.split(':');
    const horseName = String(horseNameRaw || '').trim();
    const key = horseName.toLowerCase();
    const saddleNo = horseToSaddle[key];

    if (saddleNo) {
        const suffix = rest.length ? `: ${rest.join(':').trim()}` : '';
        return `${saddleNo}. ${horseName}${suffix}`;
    }

    return text;
}

function skipRace() {
    toast('Skipped. Returning to Home dashboard.', 'success');
    navigate('#/home');
}
window.skipRace = skipRace;

function renderRunnersList(runners, selections = []) {
    const selectionMap = {};
    selections.forEach(s => selectionMap[s.runner_id] = s);
    
    return runners.map(r => {
        const sel = selectionMap[r.id];
        const scratched = r.scratched ? 'runner-scratched' : '';
        
        return `
            <div class="runner-item ${scratched}">
                <div class="runner-number">${r.saddle_no}</div>
                <div class="runner-info">
                    <div class="runner-name">${r.horse_name}</div>
                    <div class="runner-meta">
                        B${r.barrier || '?'} • ${r.weight || '?'}kg • ${r.jockey || 'TBA'}
                        ${sel ? ` • Score: ${sel.score.toFixed(1)}` : ''}
                    </div>
                </div>
                <div class="runner-odds">
                    <div class="runner-odds-win">$${r.odds_win?.toFixed(2) || '-'}</div>
                    <div class="runner-odds-place">$${r.odds_place?.toFixed(2) || '-'}</div>
                </div>
            </div>
        `;
    }).join('');
}

// ============ View: Bet ============
async function renderBet(runnerId) {
    const app = document.getElementById('app');
    
    if (!state.currentRace) {
        navigate('#/today');
        return;
    }
    
    const runner = state.currentRace.runners.find(r => r.id === parseInt(runnerId));
    if (!runner) {
        toast('Runner not found', 'error');
        navigate('#/today');
        return;
    }
    
    // Get selection and stake calculation
    let selection, stakes;
    try {
        const selData = await api(`/selections/${state.currentRace.id}`);
        selection = selData.selections.find(s => s.runner_id === parseInt(runnerId));
        
        if (selection) {
            const stakeData = await api(`/bets/${selection.id}/calculate-stake`, { method: 'POST' });
            stakes = stakeData.stakes;
        }
    } catch (err) {
        console.error(err);
    }

    const hasStakeBreakdown = !!(stakes && stakes.breakdown);
    const recommendedPercent = hasStakeBreakdown
        ? ((stakes.breakdown.stakePercent || stakes.breakdown.kellyFraction || 0) * 100).toFixed(1)
        : null;
    
    app.innerHTML = `
        <button onclick="navigate('#/race/${state.currentRace.id}')" class="btn btn-outline mb-2">← Back to Race</button>
        
        <div class="card">
            <h2 class="card-title">💰 Place Bet</h2>
            <div class="runner-item">
                <div class="runner-number">${runner.saddle_no}</div>
                <div class="runner-info">
                    <div class="runner-name">${runner.horse_name}</div>
                    <div class="runner-meta">Race ${state.currentRace.race_no} • ${state.currentRace.meeting.track}</div>
                </div>
            </div>
        </div>
        <div class="card">
            <h2 class="card-title">Bet Details</h2>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Win Odds</label>
                    <input type="number" step="0.01" id="odds-win" class="form-control" value="${runner.odds_win || ''}">
                </div>
                <div class="form-group">
                    <label class="form-label">Place Odds</label>
                    <input type="number" step="0.01" id="odds-place" class="form-control" value="${runner.odds_place || ''}">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Stake Win ($)</label>
                    <input type="number" step="0.01" id="stake-win" class="form-control" value="${stakes?.stake_win?.toFixed(2) || ''}">
                </div>
                <div class="form-group">
                    <label class="form-label">Stake Place ($)</label>
                    <input type="number" step="0.01" id="stake-place" class="form-control" value="${stakes?.stake_place?.toFixed(2) || ''}">
                </div>
            </div>
            ${stakes ? `
                <div class="text-muted mb-2">
                    ${hasStakeBreakdown
                        ? `Recommended stakes based on ${stakes.stakingMode} staking (${recommendedPercent}%)`
                        : (stakes.reason || 'No recommended stake available')}
                </div>
            ` : ''}
            ${stakes?.reason ? '<div class="text-warning mb-2">Set your bankroll in the Bankroll tab before placing bets.</div>' : ''}
            ${stakes?.reason ? '<button id="go-bankroll-btn" class="btn btn-outline mb-2">Go to Bankroll</button>' : ''}
            <div id="payout-preview" class="text-muted mb-2"></div>
            <button id="place-bet-btn" class="btn btn-success btn-block">Confirm Bet</button>
        </div>

        <div id="another-bet-modal" class="modal-overlay hidden">
            <div class="modal">
                <div class="modal-header">
                    <div class="modal-title">Bet Placed Successfully</div>
                </div>
                <div class="modal-body">
                    <div class="bet-success-summary">
                        <div class="bet-success-title">${runner.saddle_no}. ${escapeHtml(runner.horse_name)}</div>
                        <div class="runner-meta">${escapeHtml(state.currentRace.meeting.track)} R${state.currentRace.race_no}: ${escapeHtml(state.currentRace.race_name || `Race ${state.currentRace.race_no}`)}</div>
                        <div id="bet-success-stake" class="bet-success-stake"></div>
                    </div>
                    <div class="mt-2 text-center">Would you like to place another bet?</div>
                </div>
                <div class="modal-footer">
                    <button id="another-bet-no" class="btn btn-outline" type="button">No</button>
                    <button id="another-bet-yes" class="btn btn-primary" type="button">Yes</button>
                </div>
            </div>
        </div>
    `;

    const goBankrollBtn = document.getElementById('go-bankroll-btn');
    if (goBankrollBtn) {
        goBankrollBtn.addEventListener('click', () => navigate('#/bankroll'));
    }
    const anotherBetModal = document.getElementById('another-bet-modal');
    document.getElementById('another-bet-yes').addEventListener('click', () => {
        anotherBetModal.classList.add('hidden');
        navigate('#/settings');
    });
    document.getElementById('another-bet-no').addEventListener('click', () => {
        anotherBetModal.classList.add('hidden');
        navigate('#/home');
    });
    
    // Update payout preview
    function updatePreview() {
        const oddsWin = parseFloat(document.getElementById('odds-win').value) || 0;
        const oddsPlace = parseFloat(document.getElementById('odds-place').value) || 0;
        const stakeWin = parseFloat(document.getElementById('stake-win').value) || 0;
        const stakePlace = parseFloat(document.getElementById('stake-place').value) || 0;
        
        const total = stakeWin + stakePlace;
        const ifWin = stakeWin * oddsWin + stakePlace * oddsPlace;
        const ifPlace = stakePlace * oddsPlace;
        
        document.getElementById('payout-preview').innerHTML = `
            Total stake: <strong>$${total.toFixed(2)}</strong> • 
            If Win: <strong class="text-success">+$${(ifWin - total).toFixed(2)}</strong> • 
            If Place: <strong>+$${(ifPlace - total).toFixed(2)}</strong>
        `;
    }
    
    document.querySelectorAll('#odds-win, #odds-place, #stake-win, #stake-place').forEach(el => {
        el.addEventListener('input', updatePreview);
    });
    updatePreview();
    
    // Place bet
    document.getElementById('place-bet-btn').addEventListener('click', async () => {
        const placeBetButton = document.getElementById('place-bet-btn');
        const oddsWin = parseFloat(document.getElementById('odds-win').value);
        const oddsPlace = parseFloat(document.getElementById('odds-place').value);
        const stakeWin = parseFloat(document.getElementById('stake-win').value) || 0;
        const stakePlace = parseFloat(document.getElementById('stake-place').value) || 0;
        
        if (!selection) {
            toast('No selection found - please analyze race first', 'error');
            return;
        }
        
        if (stakeWin <= 0 && stakePlace <= 0) {
            toast(stakes?.reason ? 'Set your bankroll first, then enter stake amount' : 'Please enter stake amount', 'warning');
            return;
        }
        
        try {
            placeBetButton.disabled = true;
            placeBetButton.textContent = 'Placing Bet...';
            const result = await api('/bets', {
                method: 'POST',
                silentError: true,
                body: {
                    selection_id: selection.id,
                    stake_win: stakeWin,
                    stake_place: stakePlace,
                    odds_win: oddsWin,
                    odds_place: oddsPlace
                }
            });
            
            state.bankroll = result.bankroll;
            updateBankrollDisplay();
            
            toast('Bet placed successfully!', 'success');
            document.getElementById('bet-success-stake').textContent = `Total stake: $${(stakeWin + stakePlace).toFixed(2)}`;
            anotherBetModal.classList.remove('hidden');
            
        } catch (err) {
            placeBetButton.disabled = false;
            placeBetButton.textContent = 'Confirm Bet';
            const issues = err.details?.issues || [];
            const bankrollIssue = issues.find(i => i.type === 'bankroll_floor');

            if (bankrollIssue) {
                toast('Bet blocked: bankroll is below your minimum floor. Please set or top up bankroll.', 'warning');
                navigate('#/bankroll');
            }
        }
    });
}

// ============ View: Results ============
async function renderResults(preselectedRaceId) {
    const app = document.getElementById('app');
    app.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    
    try {
        const bets = await api('/bets?status=pending');
        const allBets = await api('/bets');
        const pendingRaces = [...new Map(bets.map(bet => [bet.race_id, bet])).values()];
        const fallbackDate = state.settings.last_date || new Date().toISOString().split('T')[0];
        const dashboard = await api(`/dashboard?date=${encodeURIComponent(fallbackDate)}`, { silentError: true });
        const dashboardRaces = (dashboard.meetings || []).flatMap(item =>
            (item.races || []).map(race => ({
                race_id: race.id,
                race_no: race.race_no,
                race_name: race.race_name,
                track: item.meeting?.track || 'Unknown track',
                result_entered: !!race.result_entered,
                placings: race.placings || null,
                outcome_text: race.outcome_text || null
            }))
        );

        const raceOptions = [...new Map([...pendingRaces, ...dashboardRaces].map(r => [r.race_id, r])).values()];
        const raceIdToSelect = parseInt(preselectedRaceId, 10);

        if (Number.isInteger(raceIdToSelect) && raceIdToSelect > 0 && !raceOptions.some(r => r.race_id === raceIdToSelect)) {
            try {
                const race = await api(`/races/${raceIdToSelect}`, { silentError: true });
                raceOptions.unshift({
                    race_id: race.id,
                    race_no: race.race_no,
                    race_name: race.race_name,
                    track: race.meeting?.track || 'Unknown track',
                    result_entered: false,
                    placings: null,
                    outcome_text: null
                });
            } catch (err) {}
        }
        
        app.innerHTML = `
            <div class="card">
                <h2 class="card-title">Pending Bets</h2>
                ${bets.length === 0 ? '<div class="empty-state">No pending bets</div>' :
                    renderPendingBetsGrouped(bets)}
            </div>
            
            <div class="card">
                <h2 class="card-title">Bet History</h2>
                ${allBets.filter(b => b.status !== 'pending').length === 0 ? 
                    '<div class="empty-state">No settled bets yet</div>' :
                    allBets.filter(b => b.status !== 'pending').slice(0, 20).map(bet => renderBetItem(bet, false)).join('')}
            </div>

            <div id="settle-race-modal" class="modal-overlay hidden">
                <div class="modal">
                    <div class="modal-header">
                        <div class="modal-title">Settle Race</div>
                        <button id="settle-modal-close" class="modal-close" type="button">&times;</button>
                    </div>
                    <div class="modal-body">
                        <input type="hidden" id="settle-modal-race-id">
                        <div class="runner-name" id="settle-modal-race-title"></div>
                        <div class="runner-meta mb-2" id="settle-modal-race-meta"></div>
                        <div class="form-row">
                            <div class="form-group">
                                <label class="form-label">1st</label>
                                <input type="number" min="1" step="1" id="settle-modal-first" class="form-control" placeholder="9">
                            </div>
                            <div class="form-group">
                                <label class="form-label">2nd</label>
                                <input type="number" min="1" step="1" id="settle-modal-second" class="form-control" placeholder="4">
                            </div>
                            <div class="form-group">
                                <label class="form-label">3rd</label>
                                <input type="number" min="1" step="1" id="settle-modal-third" class="form-control" placeholder="1">
                            </div>
                        </div>
                        <div id="settle-modal-status" class="mt-2 text-muted">Enter the saddle numbers in finishing order, for example 9, 4, 1.</div>
                    </div>
                    <div class="modal-footer">
                        <button id="settle-modal-cancel" class="btn btn-outline" type="button">Cancel</button>
                        <button id="settle-modal-more" class="btn btn-outline hidden" type="button">Enter More Results</button>
                        <button id="settle-modal-submit" class="btn btn-primary" type="button">Settle Race</button>
                    </div>
                </div>
            </div>
        `;

        const settleModal = document.getElementById('settle-race-modal');
        const status = document.getElementById('settle-modal-status');
        const submitButton = document.getElementById('settle-modal-submit');
        const cancelButton = document.getElementById('settle-modal-cancel');
        const moreResultsButton = document.getElementById('settle-modal-more');
        const resultInputs = [
            document.getElementById('settle-modal-first'),
            document.getElementById('settle-modal-second'),
            document.getElementById('settle-modal-third')
        ];
        let settlementCompleted = false;

        async function closeSettleRaceModal() {
            settleModal.classList.add('hidden');
            if (settlementCompleted) {
                settlementCompleted = false;
                await renderResults();
            }
        }

        window.openSettleRaceModal = (raceId) => {
            const selectedRaceId = parseInt(raceId, 10);
            const selected = raceOptions.find(r => r.race_id === selectedRaceId);
            if (!selected) {
                toast('Race details were not found', 'warning');
                return;
            }

            document.getElementById('settle-modal-race-id').value = selected.race_id;
            document.getElementById('settle-modal-race-title').textContent = `R${selected.race_no}: ${selected.race_name || `Race ${selected.race_no}`}`;
            document.getElementById('settle-modal-race-meta').textContent = selected.track || 'Unknown track';
            document.getElementById('settle-modal-first').value = selected.placings?.first || '';
            document.getElementById('settle-modal-second').value = selected.placings?.second || '';
            document.getElementById('settle-modal-third').value = selected.placings?.third || '';
            resultInputs.forEach(input => { input.disabled = false; });
            submitButton.textContent = 'Settle Race';
            cancelButton.classList.remove('hidden');
            moreResultsButton.classList.add('hidden');
            settlementCompleted = false;

            status.innerHTML = selected.result_entered && selected.placings
                ? `<span class="text-success">Results already entered: ${selected.placings.first || '-'}-${selected.placings.second || '-'}-${selected.placings.third || '-'} - ${selected.outcome_text || 'No win'}</span>`
                : 'Enter the saddle numbers in finishing order, for example 9, 4, 1.';

            settleModal.classList.remove('hidden');
            document.getElementById('settle-modal-first').focus();
        };

        document.getElementById('settle-modal-close').addEventListener('click', closeSettleRaceModal);
        document.getElementById('settle-modal-cancel').addEventListener('click', closeSettleRaceModal);
        moreResultsButton.addEventListener('click', async () => {
            const currentRaceId = parseInt(document.getElementById('settle-modal-race-id').value, 10);
            const nextRace = pendingRaces.find(race => Number(race.race_id) !== currentRaceId);

            settleModal.classList.add('hidden');
            settlementCompleted = false;

            if (nextRace) {
                await renderResults(nextRace.race_id);
            } else {
                toast('All pending races have been settled', 'success');
                await renderResults();
            }
        });
        settleModal.addEventListener('click', (event) => {
            if (event.target === settleModal) closeSettleRaceModal();
        });

        document.getElementById('settle-modal-submit').addEventListener('click', async () => {
            if (settlementCompleted) {
                await closeSettleRaceModal();
                return;
            }

            const raceId = document.getElementById('settle-modal-race-id').value;
            const first = document.getElementById('settle-modal-first').value;
            const second = document.getElementById('settle-modal-second').value;
            const third = document.getElementById('settle-modal-third').value;

            if (!raceId) {
                toast('Please select a race', 'warning');
                return;
            }

            if (!first && !second && !third) {
                toast('Enter at least the 1st place saddle number', 'warning');
                return;
            }

            status.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

            try {
                const result = await api('/results/race', {
                    method: 'POST',
                    body: { race_id: parseInt(raceId, 10), first, second, third }
                });

                if (typeof result.bankroll === 'number') {
                    state.bankroll = result.bankroll;
                    updateBankrollDisplay();
                }

                const totalProfit = Number(result.summary?.total_profit || 0);
                const settled = Array.isArray(result.settled) ? result.settled : [];
                const outcomeClass = totalProfit > 0
                    ? 'settlement-outcome-win'
                    : (totalProfit < 0 ? 'settlement-outcome-loss' : 'settlement-outcome-neutral');
                const outcomeLabel = totalProfit > 0
                    ? 'WIN'
                    : (totalProfit < 0 ? 'LOSS' : (settled.length ? 'NO PROFIT' : 'NO BETS'));
                const amountText = totalProfit > 0
                    ? `Won $${totalProfit.toFixed(2)}`
                    : (totalProfit < 0 ? `Lost $${Math.abs(totalProfit).toFixed(2)}` : result.summary?.outcome_text || 'No bets were settled');
                const settledDetails = settled.map(item => {
                    const itemProfit = Number(item.profit || 0);
                    const itemResult = item.result === 'won'
                        ? 'Won'
                        : (item.result === 'placed' ? 'Placed' : 'Lost');
                    const itemAmount = itemProfit > 0
                        ? `+$${itemProfit.toFixed(2)}`
                        : (itemProfit < 0 ? `-$${Math.abs(itemProfit).toFixed(2)}` : '$0.00');
                    return `
                        <div class="settlement-outcome-detail">
                            <span>${escapeHtml(item.saddle_no)}. ${escapeHtml(item.horse_name)} - ${itemResult}</span>
                            <strong>${itemAmount}</strong>
                        </div>
                    `;
                }).join('');

                status.innerHTML = `
                    <div class="settlement-outcome ${outcomeClass}">
                        <div class="settlement-outcome-label">${outcomeLabel}</div>
                        <div class="settlement-outcome-amount">${amountText}</div>
                        ${settledDetails ? `<div class="settlement-outcome-details">${settledDetails}</div>` : ''}
                    </div>
                `;
                settlementCompleted = true;
                resultInputs.forEach(input => { input.disabled = true; });
                submitButton.textContent = 'Done';
                cancelButton.classList.add('hidden');
                moreResultsButton.classList.remove('hidden');
                toast(amountText, totalProfit > 0 ? 'success' : (totalProfit < 0 ? 'error' : 'success'));
            } catch (err) {
                status.innerHTML = `<div class="text-danger">${err.message}</div>`;
            }
        });

        if (Number.isInteger(raceIdToSelect) && raceIdToSelect > 0) {
            window.openSettleRaceModal(raceIdToSelect);
        }
        
    } catch (err) {
        app.innerHTML = `<div class="empty-state text-danger">${err.message}</div>`;
    }
}

function renderPendingBetsGrouped(bets) {
    const byDate = new Map();

    bets.forEach(bet => {
        const date = bet.date || 'Unknown date';
        const track = bet.track || 'Unknown track';
        const raceNo = bet.race_no ?? '?';
        const raceName = bet.race_name || `Race ${raceNo}`;
        const startTime = bet.start_time || 'TBA';
        const raceKey = `${bet.race_id || `${track}-${raceNo}`}`;

        if (!byDate.has(date)) {
            byDate.set(date, new Map());
        }

        const dateGroup = byDate.get(date);
        if (!dateGroup.has(track)) {
            dateGroup.set(track, new Map());
        }

        const trackGroup = dateGroup.get(track);
        if (!trackGroup.has(raceKey)) {
            trackGroup.set(raceKey, {
                raceNo,
                raceName,
                startTime,
                bets: []
            });
        }

        trackGroup.get(raceKey).bets.push(bet);
    });

    return [...byDate.entries()]
        .sort(([dateA], [dateB]) => String(dateA).localeCompare(String(dateB)))
        .map(([date, tracks]) => `
            <div class="pending-date-group">
                <div class="section-heading">${escapeHtml(formatRaceDate(date))}</div>
                ${[...tracks.entries()]
                    .sort(([trackA], [trackB]) => trackA.localeCompare(trackB))
                    .map(([track, races]) => {
                        const raceBlocks = [...races.values()]
                            .sort((a, b) => Number(a.raceNo) - Number(b.raceNo))
                            .map(race => `
                                <div class="pending-race-group">
                                    <div class="pending-race-title">R${race.raceNo}: ${escapeHtml(race.raceName)} <span class="text-muted">Jump: ${escapeHtml(race.startTime)}</span></div>
                                    ${race.bets.map(bet => renderBetItem(bet, true)).join('')}
                                </div>
                            `)
                            .join('');

                        return `
                            <div class="pending-track-group">
                                <div class="section-heading">${escapeHtml(track)}</div>
                                ${raceBlocks}
                            </div>
                        `;
                    })
                    .join('')}
            </div>
        `)
        .join('');
}

function renderBetItem(bet, showActions) {
    const stakeWin = Number(bet.stake_win || 0);
    const stakePlace = Number(bet.stake_place || 0);
    const oddsWin = Number(bet.odds_win || 0);
    const oddsPlace = Number(bet.odds_place || 0);
    const payoutWin = Number(bet.payout_win || 0);
    const payoutPlace = Number(bet.payout_place || 0);
    const saddleNo = bet.saddle_no ?? '?';
    const horseName = bet.horse_name || 'Unknown runner';
    const track = bet.track || 'Unknown track';
    const raceNo = bet.race_no ?? '?';
    const raceName = bet.race_name || `Race ${raceNo}`;
    const startTime = bet.start_time || 'TBA';
    const raceResult = [bet.first_saddle, bet.second_saddle, bet.third_saddle]
        .filter(value => value !== null && value !== undefined && value !== '')
        .join('-');
    const stakeParts = [];
    if (stakeWin > 0) stakeParts.push(`Win stake $${stakeWin.toFixed(2)} @ ${oddsWin ? oddsWin.toFixed(2) : '-'}`);
    if (stakePlace > 0) stakeParts.push(`Place stake $${stakePlace.toFixed(2)} @ ${oddsPlace ? oddsPlace.toFixed(2) : '-'}`);
    const returnParts = [];
    if (payoutWin > 0) returnParts.push(`Win return $${payoutWin.toFixed(2)}`);
    if (payoutPlace > 0) returnParts.push(`Place return $${payoutPlace.toFixed(2)}`);

    const statusBadge = {
        'pending': 'badge-warning',
        'won': 'badge-success',
        'placed': 'badge-primary',
        'lost': 'badge-danger',
        'void': 'badge-muted'
    }[bet.status] || 'badge-muted';
    
    const profit = (payoutWin + payoutPlace) - (stakeWin + stakePlace);
    const totalReturn = payoutWin + payoutPlace;

    let totalDisplay = '-';

    if (bet.status === 'pending') {
        totalDisplay = 'Pending';
    } else if (bet.status === 'lost') {
        totalDisplay = 'Lost';
    } else if (bet.status === 'void') {
        totalDisplay = 'Void';
    } else {
        totalDisplay = totalReturn > 0 ? `$${totalReturn.toFixed(2)}` : '-';
    }
    
    return `
        <div class="runner-item">
            <div class="runner-info">
                <div class="runner-name">${saddleNo}. ${horseName}</div>
                <div class="runner-meta">${track} R${raceNo}: ${raceName}</div>
                <div class="runner-meta">Jump: ${startTime}</div>
                ${raceResult ? `<div class="runner-meta">Results: ${raceResult}</div>` : ''}
                <div class="runner-meta">
                    ${bet.status === 'pending' ? stakeParts.join(' - ') : ''}
                    ${bet.status !== 'pending' && returnParts.length ? returnParts.join(' - ') : ''}
                </div>
            </div>
            <div class="runner-odds text-right">
                <span class="badge ${statusBadge}">${bet.status.toUpperCase()}</span>
                ${returnParts.length ? `<div class="text-muted">${returnParts.join('<br>')}</div>` : ''}
                <div class="${bet.status === 'lost' ? 'text-danger' : (profit >= 0 ? 'text-success' : 'text-danger')}">Total: ${totalDisplay}</div>
                ${bet.status !== 'pending' && totalDisplay !== 'Lost' && totalDisplay !== 'Void' ? `
                    <div class="${profit >= 0 ? 'text-success' : 'text-danger'}">P/L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}</div>
                ` : ''}
                ${showActions && bet.status === 'pending' ? `
                    <button class="btn btn-primary btn-sm mt-1" type="button" onclick="openSettleRaceModal(${bet.race_id})">Settle Race</button>
                ` : ''}
            </div>
        </div>
    `;
}

async function settleBet(betId, result) {
    try {
        const data = await api(`/results/${betId}`, { method: 'POST', body: { result } });
        state.bankroll = data.bankroll;
        updateBankrollDisplay();
        toast(`Bet settled: ${result}`, 'success');
        await renderResults();
    } catch (err) {
        // Error already toasted
    }
}
window.settleBet = settleBet;

// ============ View: Bankroll ============
async function renderBankroll() {
    const app = document.getElementById('app');
    app.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    
    try {
        const selectedPeriod = state.bankrollPeriod || 'all_time';
        const periodQuery = `period=${encodeURIComponent(selectedPeriod)}`;
        const summary = await api(`/bankroll/summary?${periodQuery}`);
        const history = await api(`/stats/history?${periodQuery}`);
        const periodOptions = BANKROLL_PERIODS
            .map(([value, label]) => `<option value="${value}" ${value === selectedPeriod ? 'selected' : ''}>${label}</option>`)
            .join('');
        const periodLabel = summary.period?.label || 'selected period';
        const netProfitSign = summary.netProfit > 0 ? '+' : '';
        const winsLabel = `${summary.betting.wins} ${summary.betting.wins === 1 ? 'win' : 'wins'}`;
        const placesLabel = `${summary.betting.places} ${summary.betting.places === 1 ? 'place' : 'places'}`;
        const lossesLabel = `${summary.betting.losses} ${summary.betting.losses === 1 ? 'loss' : 'losses'}`;
        
        app.innerHTML = `
            ${summary.bankroll === 0 && summary.totals.deposits === 0 ? `
                <div class="card">
                    <h2 class="card-title">🏦 Set Initial Bankroll</h2>
                    <div class="form-group">
                        <label class="form-label">Starting Bankroll ($)</label>
                        <input type="number" step="0.01" id="initial-bankroll" class="form-control" placeholder="1000">
                    </div>
                    <button id="set-bankroll-btn" class="btn btn-primary btn-block">Set Bankroll</button>
                </div>
            ` : ''}
            
            <div class="stats-grid mb-2">
                <div class="stat-card" tabindex="0"
                     aria-label="Bankroll: $${summary.bankroll.toFixed(2)}. Current available balance after all deposits, withdrawals, stakes and payouts."
                     data-tooltip="Current available balance after all deposits, withdrawals, stakes and payouts. This is your live balance and is not limited by the Statistics period.">
                    <span class="stat-info" aria-hidden="true">i</span>
                    <div class="stat-value ${summary.bankroll >= 0 ? 'positive' : 'negative'}">$${summary.bankroll.toFixed(2)}</div>
                    <div class="stat-label">Bankroll</div>
                </div>
                <div class="stat-card" tabindex="0"
                     aria-label="ROI: ${summary.roiPercent.toFixed(1)} percent. Net result ${netProfitSign}$${summary.netProfit.toFixed(2)} for ${periodLabel}."
                     data-tooltip="Return on investment for ${periodLabel}: net result divided by total stakes. The dollar amount is returns minus stakes.">
                    <span class="stat-info" aria-hidden="true">i</span>
                    <div class="stat-value ${summary.roiPercent >= 0 ? 'positive' : 'negative'}">${summary.roiPercent.toFixed(1)}%</div>
                    <div class="stat-secondary ${summary.netProfit >= 0 ? 'positive' : 'negative'}">Net ${netProfitSign}$${summary.netProfit.toFixed(2)}</div>
                    <div class="stat-label">ROI</div>
                </div>
                <div class="stat-card" tabindex="0"
                     aria-label="Win Rate: ${summary.betting.winRatePercent.toFixed(1)} percent. Winning bets divided by settled bets for ${periodLabel}."
                     data-tooltip="Winning bets divided by all settled bets for ${periodLabel}. Pending bets are excluded.">
                    <span class="stat-info" aria-hidden="true">i</span>
                    <div class="stat-value">${summary.betting.winRatePercent.toFixed(1)}%</div>
                    <div class="stat-label">Win Rate</div>
                </div>
                <div class="stat-card" tabindex="0"
                     aria-label="Settled Bets: ${summary.betting.totalBets}. Settled bets for ${periodLabel}; ${winsLabel}, ${placesLabel} and ${lossesLabel}. Pending bets are excluded."
                     data-tooltip="Settled bets for ${periodLabel}: ${winsLabel} + ${placesLabel} + ${lossesLabel}. Pending bets are not counted.">
                    <span class="stat-info" aria-hidden="true">i</span>
                    <div class="stat-value">${summary.betting.totalBets}</div>
                    <div class="stat-label">Settled Bets</div>
                </div>
            </div>
            
            <div class="card">
                <h2 class="card-title">📈 Bankroll History</h2>
                <div class="chart-container" id="chart-container"></div>
            </div>
            
            <div class="card">
                <div class="flex-between mb-2">
                    <h2 class="card-title mb-0">Statistics</h2>
                    <select id="bankroll-period-select" class="form-control bankroll-period-select">
                        ${periodOptions}
                    </select>
                </div>
                <div class="table-wrap">
                    <table class="table">
                        <tr><td>Wins</td><td class="text-right">${summary.betting.wins}</td></tr>
                        <tr><td>Places</td><td class="text-right">${summary.betting.places}</td></tr>
                        <tr><td>Losses</td><td class="text-right">${summary.betting.losses}</td></tr>
                        <tr><td>Place Rate</td><td class="text-right">${summary.betting.placeRatePercent.toFixed(1)}%</td></tr>
                        <tr><td>Max Drawdown</td><td class="text-right text-danger">${summary.drawdown.maxPercent.toFixed(1)}%</td></tr>
                        <tr><td>Total Staked</td><td class="text-right">$${summary.totals.stakes.toFixed(2)}</td></tr>
                        <tr><td>Total Returns</td><td class="text-right">$${summary.totals.payouts.toFixed(2)}</td></tr>
                        <tr><td>Net Profit</td><td class="text-right ${summary.netProfit >= 0 ? 'text-success' : 'text-danger'}">$${summary.netProfit.toFixed(2)}</td></tr>
                    </table>
                </div>
            </div>
            
            <div class="card">
                <h2 class="card-title">💵 Manage Funds</h2>
                <div class="form-row">
                    <div class="form-group">
                        <input type="number" step="0.01" id="fund-amount" class="form-control" placeholder="Amount">
                    </div>
                </div>
                <div class="flex gap-1">
                    <button class="btn btn-success" onclick="manageFunds('deposit')">Deposit</button>
                    <button class="btn btn-warning" onclick="manageFunds('withdraw')">Withdraw</button>
                </div>
                <div class="mt-2">
                    <div class="section-heading mb-1">Deposits & Withdrawals</div>
                    ${renderFundTransactionRows(history)}
                </div>
            </div>
            
            <div class="card">
                <h2 class="card-title">📤 Export</h2>
                <div class="flex gap-1">
                    <a href="${appUrl(`/api/export/bets?${periodQuery}`)}" class="btn btn-outline" download>Export Bets CSV</a>
                    <a href="${appUrl(`/api/export/transactions?${periodQuery}`)}" class="btn btn-outline" download>Export Transactions</a>
                </div>
                <div class="runner-meta mt-1">Exports use the selected Statistics period.</div>
            </div>
        `;
        
        // Set initial bankroll handler
        const setBankrollBtn = document.getElementById('set-bankroll-btn');
        if (setBankrollBtn) {
            setBankrollBtn.addEventListener('click', async () => {
                const amount = parseFloat(document.getElementById('initial-bankroll').value);
                if (!amount || amount <= 0) {
                    toast('Please enter a valid amount', 'warning');
                    return;
                }
                try {
                    await api('/bankroll/initial', { method: 'POST', body: { amount } });
                    toast('Bankroll set!', 'success');
                    state.bankroll = amount;
                    updateBankrollDisplay();
                    await renderBankroll();
                } catch (err) {}
            });
        }

        document.getElementById('bankroll-period-select')?.addEventListener('change', async (event) => {
            state.bankrollPeriod = event.target.value;
            await renderBankroll();
        });
        
        // Draw chart
        drawChart(history);
        
    } catch (err) {
        app.innerHTML = `<div class="empty-state text-danger">${err.message}</div>`;
    }
}

async function manageFunds(action) {
    const amount = parseFloat(document.getElementById('fund-amount').value);
    if (!amount || amount <= 0) {
        toast('Please enter a valid amount', 'warning');
        return;
    }
    
    try {
        const data = await api(`/bankroll/${action}`, { method: 'POST', body: { amount } });
        state.bankroll = data.bankroll;
        updateBankrollDisplay();
        toast(`${action.charAt(0).toUpperCase() + action.slice(1)} successful!`, 'success');
        document.getElementById('fund-amount').value = '';
        await renderBankroll();
    } catch (err) {}
}
window.manageFunds = manageFunds;

// ============ View: Logs ============
async function renderLogs() {
    const app = document.getElementById('app');
    app.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

    try {
        state.activityLogItems = await api('/activity?limit=1000');
        renderActivityLog();
        return;

        const logs = await api('/logs?limit=1000');
        app.innerHTML = `
            <div class="card">
                <h2 class="card-title">🧾 Audit Log</h2>
                <div class="text-muted mb-2">Permanent record of bet placements and result entries.</div>
                ${logs.length === 0 ? '<div class="empty-state">No activity logged yet</div>' : logs.map(log => `
                    <div class="runner-item">
                        <div class="runner-info">
                            <div class="runner-name">${log.event_type}</div>
                            <div class="runner-meta">${new Date(log.created_at).toLocaleString()}</div>
                            <div>${log.message}</div>
                            ${log.payload_json ? `<div class="text-muted mt-1">${formatLogPayload(log.payload_json)}</div>` : ''}
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    } catch (err) {
        app.innerHTML = `<div class="empty-state text-danger">${err.message}</div>`;
    }
}

function renderActivityLog() {
    const app = document.getElementById('app');
    const activities = state.activityLogItems || [];
    const eventTypes = [...new Set(activities.map(item => item.event_type).filter(Boolean))].sort();
    const transactionCount = activities.filter(item => item.activity_type === 'transaction').length;
    const auditCount = activities.filter(item => item.activity_type !== 'transaction').length;
    const latest = activities[0]?.created_at ? new Date(activities[0].created_at).toLocaleString() : 'None';

    app.innerHTML = `
        <div class="card">
            <h2 class="card-title">Activity Log</h2>
            <div class="stats-grid mb-2">
                <div class="stat-card">
                    <div class="stat-value">${activities.length}</div>
                    <div class="stat-label">Total</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${auditCount}</div>
                    <div class="stat-label">Changes</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${transactionCount}</div>
                    <div class="stat-label">Transactions</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value" style="font-size: 0.95rem;">${escapeHtml(latest)}</div>
                    <div class="stat-label">Latest</div>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label" for="activity-type-filter">Event</label>
                    <select id="activity-type-filter" class="form-control" onchange="filterActivityLog()">
                        <option value="">All events</option>
                        ${eventTypes.map(type => `<option value="${escapeHtml(type)}">${escapeHtml(formatEventLabel(type))}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label" for="activity-search">Search</label>
                    <input id="activity-search" class="form-control" type="search" placeholder="Track, horse, amount, event..." oninput="filterActivityLog()">
                </div>
                <div class="form-group" style="flex: 0 0 auto; align-self: end;">
                    <button class="btn btn-outline" onclick="renderLogs()">Refresh</button>
                </div>
            </div>
            <div id="activity-log-results">
                ${renderActivityRows(activities)}
            </div>
        </div>
    `;
}

function filterActivityLog() {
    const typeFilter = document.getElementById('activity-type-filter')?.value || '';
    const search = (document.getElementById('activity-search')?.value || '').trim().toLowerCase();
    const activities = (state.activityLogItems || []).filter(item => {
        if (typeFilter && item.event_type !== typeFilter) return false;
        if (!search) return true;
        const payloadText = item.payload_json ? JSON.stringify(item.payload_json) : '';
        return [
            item.event_type,
            item.message,
            item.entity_type,
            item.entity_id,
            payloadText
        ].some(value => String(value ?? '').toLowerCase().includes(search));
    });

    const results = document.getElementById('activity-log-results');
    if (results) {
        results.innerHTML = renderActivityRows(activities);
    }
}
window.filterActivityLog = filterActivityLog;

function renderActivityRows(activities) {
    if (!activities.length) {
        return '<div class="empty-state">No matching activity found</div>';
    }

    return `
        <div class="table-wrap">
            <table class="table">
                <thead>
                    <tr>
                        <th>Event</th>
                        <th>When</th>
                        <th>Details</th>
                        <th>Entity</th>
                    </tr>
                </thead>
                <tbody>
                    ${activities.map(item => `
                        <tr>
                            <td>
                                <span class="badge ${getActivityBadgeClass(item)}">${escapeHtml(formatEventLabel(item.event_type))}</span>
                                <div class="text-muted">${escapeHtml(item.activity_type || 'audit')}</div>
                            </td>
                            <td>${escapeHtml(new Date(item.created_at).toLocaleString())}</td>
                            <td>
                                <strong>${escapeHtml(item.message || '')}</strong>
                                ${formatLogPayload(item.payload_json) ? `<div class="text-muted mt-1">${escapeHtml(formatLogPayload(item.payload_json))}</div>` : ''}
                            </td>
                            <td>${escapeHtml(formatLogEntity(item))}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function getActivityBadgeClass(item) {
    const eventType = String(item.event_type || '').toLowerCase();
    if (eventType.includes('failed') || eventType.includes('blocked') || eventType.includes('withdrawal')) return 'badge-danger';
    if (eventType.includes('deposit') || eventType.includes('payout') || eventType.includes('settled')) return 'badge-success';
    if (eventType.includes('import') || eventType.includes('updated') || eventType.includes('export')) return 'badge-primary';
    return item.activity_type === 'transaction' ? 'badge-warning' : 'badge-muted';
}

function formatEventLabel(eventType = '') {
    return String(eventType).replace(/^TRANSACTION_/, '').replace(/_/g, ' ').toLowerCase()
        .replace(/\b\w/g, letter => letter.toUpperCase());
}

function formatLogEntity(item) {
    if (!item.entity_type && !item.entity_id) return '';
    if (!item.entity_id) return item.entity_type || '';
    return `${item.entity_type || 'entity'} #${item.entity_id}`;
}

function formatLogPayload(payload) {
    if (!payload) return '';

    if (payload.previous_bankroll !== undefined || payload.new_bankroll !== undefined) {
        return `Bankroll $${Number(payload.previous_bankroll || 0).toFixed(2)} -> $${Number(payload.new_bankroll || 0).toFixed(2)}${payload.description ? ` | ${payload.description}` : ''}`;
    }

    if (payload.transaction_id) {
        return `Transaction #${payload.transaction_id}${payload.amount !== undefined ? ` | $${Number(payload.amount).toFixed(2)}` : ''}${payload.description ? ` | ${payload.description}` : ''}`;
    }

    if (payload.meeting || payload.race) {
        const meeting = payload.meeting || {};
        const race = payload.race || {};
        return `${meeting.track || payload.track || 'Unknown'} (${meeting.state || payload.state || 'Unknown'}) ${meeting.date || payload.date || ''} ${race.race_no ? `R${race.race_no}` : ''} | ${payload.runners || 0} runners`;
    }

    if (payload.current || payload.previous) {
        const current = payload.current || {};
        const previous = payload.previous || {};
        return `${previous.track || 'Unknown'} R${previous.race_no || '?'} -> ${current.track || 'Unknown'} R${current.race_no || '?'}`;
    }

    const track = payload.track || 'Unknown';
    const raceNo = payload.race_no || '?';
    const horse = payload.horse_name || '';

    if (payload.bet_id) {
        return `${track} R${raceNo} ${horse} • Bet #${payload.bet_id}`.trim();
    }
    if (payload.race_id) {
        const p = payload.placings || {};
        return `${track} R${raceNo} • Placings ${p.first || '-'}-${p.second || '-'}-${p.third || '-'} • ${payload.outcome_text || ''}`.trim();
    }
    return Object.entries(payload)
        .filter(([, value]) => value !== null && value !== undefined && typeof value !== 'object')
        .slice(0, 5)
        .map(([key, value]) => `${key.replace(/_/g, ' ')}: ${value}`)
        .join(' | ');
}

function formatTransactionLabel(tx) {
    if (!tx) return 'Transaction';
    if (tx.type === 'bet_stake') return 'Bet';
    if (tx.type === 'payout') {
        if (tx.description && /win/i.test(tx.description)) return 'Win';
        if (tx.description && /place/i.test(tx.description)) return 'Place';
        if (tx.description && /void/i.test(tx.description)) return 'Void';
        return 'Payout';
    }
    if (tx.type === 'deposit') return 'Deposit';
    if (tx.type === 'withdrawal') return 'Withdraw';
    return tx.type ? tx.type.replace(/_/g, ' ') : 'Transaction';
}

function formatTransactionDetail(tx) {
    const amount = Number(tx.amount || 0);
    const parts = [`${formatTransactionLabel(tx)} ${amount >= 0 ? '+' : '-'}$${Math.abs(amount).toFixed(2)}`];

    if (tx.track || tx.race_no || tx.race_name) {
        parts.push(`${tx.track || 'Unknown'} R${tx.race_no ?? '?'}${tx.race_name ? `: ${tx.race_name}` : ''}`);
    }

    if (tx.horse_name || tx.saddle_no) {
        parts.push(`${tx.saddle_no ?? '?'}. ${tx.horse_name || 'Unknown runner'}`);
    }

    if (tx.type === 'bet_stake') {
        const stakeWin = Number(tx.stake_win || 0);
        const stakePlace = Number(tx.stake_place || 0);
        const oddsWin = tx.odds_win ? Number(tx.odds_win).toFixed(2) : '-';
        const oddsPlace = tx.odds_place ? Number(tx.odds_place).toFixed(2) : '-';
        parts.push(`Win stake $${stakeWin.toFixed(2)} @ ${oddsWin}`);
        parts.push(`Place stake $${stakePlace.toFixed(2)} @ ${oddsPlace}`);
    }

    if (tx.type === 'payout') {
        const payoutWin = Number(tx.payout_win || 0);
        const payoutPlace = Number(tx.payout_place || 0);
        const returns = [];
        if (payoutWin > 0) returns.push(`Win return $${payoutWin.toFixed(2)}`);
        if (payoutPlace > 0) returns.push(`Place return $${payoutPlace.toFixed(2)}`);
        if (returns.length) parts.push(returns.join(', '));
    }

    if (tx.description) parts.push(tx.description);
    return parts.join(' | ');
}

function renderFundTransactionRows(history) {
    const fundTransactions = (history || [])
        .filter(tx => tx.type === 'deposit' || tx.type === 'withdrawal')
        .slice()
        .reverse()
        .slice(0, 10);

    if (fundTransactions.length === 0) {
        return '<div class="empty-state">No deposits or withdrawals recorded yet</div>';
    }

    return `
        <div class="fund-ledger">
            ${fundTransactions.map(tx => `
                <div class="fund-ledger-row">
                    <div>
                        <div class="runner-name">${escapeHtml(formatTransactionLabel(tx))}</div>
                        <div class="runner-meta">${escapeHtml(new Date(tx.created_at).toLocaleString())}</div>
                        ${tx.description ? `<div class="runner-meta">${escapeHtml(tx.description)}</div>` : ''}
                    </div>
                    <div class="${Number(tx.amount || 0) >= 0 ? 'text-success' : 'text-danger'}">
                        ${Number(tx.amount || 0) >= 0 ? '+' : '-'}$${Math.abs(Number(tx.amount || 0)).toFixed(2)}
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function drawChart(history) {
    const container = document.getElementById('chart-container');
    if (!container || history.length === 0) return;
    
    const width = container.clientWidth;
    const height = container.clientHeight;
    const padding = 40;
    
    const values = history.map(h => h.running_balance);
    const min = Math.min(...values, 0);
    const max = Math.max(...values);
    const range = max - min || 1;
    
    const xScale = (i) => padding + (i / (history.length - 1 || 1)) * (width - padding * 2);
    const yScale = (v) => height - padding - ((v - min) / range) * (height - padding * 2);
    
    const points = history.map((h, i) => `${xScale(i)},${yScale(h.running_balance)}`).join(' ');
    const labelEvery = history.length > 18 ? Math.ceil(history.length / 18) : 1;
    
    container.innerHTML = `
        <svg width="100%" height="100%" viewBox="0 0 ${width} ${height}">
            <line x1="${padding}" y1="${yScale(0)}" x2="${width-padding}" y2="${yScale(0)}" stroke="#e2e8f0" stroke-dasharray="4"/>
            <polyline fill="none" stroke="#2563eb" stroke-width="2" points="${points}"/>
            ${history.map((h, i) => {
                const x = xScale(i);
                const y = yScale(h.running_balance);
                const label = formatTransactionLabel(h);
                const detail = `${new Date(h.created_at || h.date).toLocaleString()} | ${formatTransactionDetail(h)} | Balance $${Number(h.running_balance || 0).toFixed(2)}`;
                const fill = Number(h.amount || 0) >= 0 ? '#16a34a' : '#dc2626';
                const showLabel = i % labelEvery === 0 || h.type === 'deposit' || h.type === 'withdrawal' || h.type === 'payout';
                return `
                    <g>
                        <circle cx="${x}" cy="${y}" r="4" fill="${fill}" stroke="#fff" stroke-width="1.5">
                            <title>${escapeHtml(detail)}</title>
                        </circle>
                        ${showLabel ? `<text x="${x}" y="${Math.max(12, y - 8)}" font-size="10" fill="#334155" text-anchor="middle">${escapeHtml(label)}</text>` : ''}
                    </g>
                `;
            }).join('')}
            <text x="${padding}" y="${height - 10}" font-size="12" fill="#64748b">${history[0]?.date || ''}</text>
            <text x="${width-padding}" y="${height - 10}" font-size="12" fill="#64748b" text-anchor="end">${history[history.length-1]?.date || ''}</text>
            <text x="10" y="${yScale(max)}" font-size="12" fill="#64748b">$${max.toFixed(0)}</text>
            <text x="10" y="${yScale(min)}" font-size="12" fill="#64748b">$${min.toFixed(0)}</text>
        </svg>
    `;
}

// ============ View: Settings ============
async function renderSettings() {
    const app = document.getElementById('app');
    const deleteStateValue = state.settings.last_state || 'VIC';
    const deleteTrackValue = state.settings.last_track || '';
    
    app.innerHTML = `
        <div class="card">
            <h2 class="card-title">📥 Import Form Guide</h2>
            <div class="last-imported-race">
                <span>Last Imported Race</span>
                <strong id="last-imported-race-label">${escapeHtml(formatLastImportedRace(state.settings))}</strong>
            </div>
            <div class="tabs">
                <button class="tab active" data-tab="paste">Paste Data</button>
                <button class="tab" data-tab="ocr">Screenshot OCR</button>
                <button class="tab" data-tab="csv">CSV Upload</button>
                <button class="tab" data-tab="url">URL Import</button>
            </div>
            
            <div id="tab-paste">
                <div class="paste-import-actions">
                    <button id="import-paste-btn" class="btn btn-primary">Import Pasted Data</button>
                </div>
                <div class="form-group">
                    <label class="form-label">Paste race data text</label>
                    <textarea id="paste-data" class="form-control" rows="10" placeholder="Paste race content here (including race header, field links, and runners)..."></textarea>
                </div>
                <div id="paste-status" class="mt-2 text-muted">
                    Tip: Include the race header and form-guide URL lines so track/date can be detected.
                </div>
            </div>

            <div id="tab-ocr" class="hidden">
                <label class="file-upload">
                    <div class="file-upload-icon">📷</div>
                    <div>Click to upload screenshot image</div>
                    <input type="file" id="ocr-image-file" accept="image/*">
                </label>
                <div id="ocr-status" class="mt-2 text-muted">
                    Upload a screenshot you captured yourself. OCR runs in your browser using RaceMate's self-hosted OCR files.
                </div>
                <div class="form-group mt-2">
                    <label class="form-label">Extracted text</label>
                    <textarea id="ocr-text" class="form-control" rows="10" placeholder="OCR text will appear here. You can edit it before parsing."></textarea>
                </div>
                <div class="flex gap-1 mb-2">
                    <button id="ocr-parse-btn" class="btn btn-outline" type="button">Parse to JSON</button>
                    <button id="ocr-use-paste-btn" class="btn btn-primary" type="button">Use in Paste Import</button>
                    <button id="ocr-download-json-btn" class="btn btn-outline" type="button" disabled>Download JSON</button>
                </div>
                <pre id="ocr-json-preview" class="json-preview hidden"></pre>
            </div>

            <div id="tab-csv" class="hidden">
                <label class="file-upload">
                    <div class="file-upload-icon">📄</div>
                    <div>Click to upload CSV file</div>
                    <input type="file" id="csv-file" accept=".csv">
                </label>
                <div id="upload-status" class="mt-2"></div>
                <a href="/sample-data/sample_form.csv" download class="btn btn-outline btn-sm mt-2">Download Sample CSV</a>
            </div>

            <div id="tab-url" class="hidden">
                <div class="form-group">
                    <label class="form-label">Paste URL</label>
                    <input type="url" id="import-url" class="form-control" placeholder="https://...">
                </div>
                <button id="import-url-btn" class="btn btn-primary">Import from URL</button>
                <div id="url-status" class="mt-2 text-muted">
                    Note: URL import only works with publicly accessible pages. Most racing sites require login.
                </div>
            </div>
        </div>

        <div id="paste-duplicate-modal" class="modal-overlay hidden">
            <div class="modal">
                <div class="modal-header">
                    <div class="modal-title">Race already exists</div>
                </div>
                <div class="modal-body">
                    <div id="paste-duplicate-summary"></div>
                    <div class="text-muted mt-2">
                        Updating will refresh the existing race and runner details from the pasted data.
                    </div>
                </div>
                <div class="modal-footer">
                    <button id="paste-duplicate-cancel" class="btn btn-outline" type="button">Cancel</button>
                    <button id="paste-duplicate-update" class="btn btn-primary" type="button">Update Existing</button>
                </div>
            </div>
        </div>

        <div class="card">
            <h2 class="card-title">🗑️ Data Management</h2>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">State</label>
                    <select id="delete-state" class="form-control">
                        ${getStateOptions(deleteStateValue)}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Track</label>
                    <select id="delete-track" class="form-control"></select>
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">Date</label>
                <input type="date" id="delete-date" class="form-control" value="${state.settings.last_date || ''}">
            </div>
            <button id="delete-meeting-btn" class="btn btn-danger">Delete Meeting Data</button>
            <div id="delete-status" class="mt-2 text-muted">Use this if test/example data was imported by mistake.</div>
        </div>
        
        <div class="card">
            <h2 class="card-title">⚙️ Selection Settings</h2>
            <div class="form-group">
                <label class="form-label">Target ROI (e.g. 1.20 = 20% profit)</label>
                <input type="number" step="0.01" id="target-roi" class="form-control" value="${state.settings.target_roi || 1.20}">
            </div>
            <div class="form-group">
                <label class="form-label">Minimum Confidence (0-1)</label>
                <input type="number" step="0.01" id="min-confidence" class="form-control" value="${state.settings.min_confidence || 0.15}">
            </div>
            <div class="form-group">
                <label class="form-label">Data Completeness Threshold (0-1)</label>
                <input type="number" step="0.1" id="data-threshold" class="form-control" value="${state.settings.data_completeness_threshold || 0.6}">
            </div>
        </div>
        
        <div class="card">
            <h2 class="card-title">💰 Staking Settings</h2>
            <div class="form-group">
                <label class="form-label">Staking Mode</label>
                <select id="staking-mode" class="form-control">
                    <option value="flat" ${state.settings.staking_mode === 'flat' ? 'selected' : ''}>Flat Percentage</option>
                    <option value="kelly" ${state.settings.staking_mode === 'kelly' ? 'selected' : ''}>Kelly Criterion</option>
                </select>
            </div>
            <div class="form-group">
                <label class="form-label">Stake % of Bankroll (e.g. 0.02 = 2%)</label>
                <input type="number" step="0.01" id="stake-percent" class="form-control" value="${state.settings.stake_percent || 0.02}">
            </div>
            <div class="form-group">
                <label class="form-label">Kelly Fraction (e.g. 0.25 = quarter Kelly)</label>
                <input type="number" step="0.05" id="kelly-fraction" class="form-control" value="${state.settings.kelly_fraction || 0.25}">
            </div>
        </div>
        
        <div class="card">
            <h2 class="card-title">🛡️ Risk Controls</h2>
            <div class="form-group">
                <label class="form-label">Max Stake Per Race ($)</label>
                <input type="number" step="1" id="max-stake" class="form-control" value="${state.settings.max_stake_per_race || 100}">
            </div>
            <div class="form-group">
                <label class="form-label">Max Daily Loss ($)</label>
                <input type="number" step="1" id="max-daily-loss" class="form-control" value="${state.settings.max_daily_loss || 200}">
            </div>
            <div class="form-group">
                <label class="form-label">Floor Limit ($)</label>
                <input type="number" step="1" id="min-floor" class="form-control" value="${state.settings.min_bankroll_floor || 5}">
            </div>
        </div>
        
        <button id="save-settings-btn" class="btn btn-primary btn-block mb-2">Save Settings</button>
        
        <div class="card">
            <h2 class="card-title">💾 Backup & Restore</h2>
            <div class="flex gap-1">
                <a href="${appUrl('/api/backup/db')}" class="btn btn-outline" download>Download Database</a>
                <a href="${appUrl('/api/backup/json')}" class="btn btn-outline" download>Export JSON</a>
            </div>
        </div>
    `;
    
    // Tab switching
    const deleteStateSelect = document.getElementById('delete-state');
    const deleteTrackSelect = document.getElementById('delete-track');
    populateTrackSelect(deleteTrackSelect, deleteStateValue, deleteTrackValue);
    deleteStateSelect?.addEventListener('change', () => {
        populateTrackSelect(deleteTrackSelect, deleteStateSelect.value, '');
    });

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById('tab-csv').classList.toggle('hidden', tab.dataset.tab !== 'csv');
            document.getElementById('tab-paste').classList.toggle('hidden', tab.dataset.tab !== 'paste');
            document.getElementById('tab-ocr').classList.toggle('hidden', tab.dataset.tab !== 'ocr');
            document.getElementById('tab-url').classList.toggle('hidden', tab.dataset.tab !== 'url');
        });
    });
    
    // CSV upload
    document.getElementById('csv-file').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const status = document.getElementById('upload-status');
        status.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
        
        try {
            const result = await uploadFile('/import/csv', file);
            status.innerHTML = `<div class="text-success">Imported: ${result.meetings} meeting(s), ${result.races} race(s), ${result.runners} runner(s)</div>`;
            toast('Import successful!', 'success');
        } catch (err) {
            status.innerHTML = `<div class="text-danger">${err.message}</div>`;
        }
    });

    let latestOcrJson = null;
    const ocrFileInput = document.getElementById('ocr-image-file');
    const ocrStatus = document.getElementById('ocr-status');
    const ocrText = document.getElementById('ocr-text');
    const ocrParseBtn = document.getElementById('ocr-parse-btn');
    const ocrUsePasteBtn = document.getElementById('ocr-use-paste-btn');
    const ocrDownloadJsonBtn = document.getElementById('ocr-download-json-btn');
    const ocrJsonPreview = document.getElementById('ocr-json-preview');

    function setOcrStatus(message, type = 'muted') {
        const className = type === 'error' ? 'text-danger' : type === 'success' ? 'text-success' : type === 'warning' ? 'text-warning' : 'text-muted';
        ocrStatus.innerHTML = `<span class="${className}">${escapeHtml(message)}</span>`;
    }

    ocrFileInput?.addEventListener('change', async event => {
        const file = event.target.files?.[0];
        if (!file) return;

        if (!window.Tesseract?.createWorker) {
            setOcrStatus('OCR engine is not available. Refresh the page and try again.', 'error');
            return;
        }

        ocrText.value = '';
        latestOcrJson = null;
        ocrDownloadJsonBtn.disabled = true;
        ocrJsonPreview.classList.add('hidden');
        setOcrStatus('Preparing OCR...');

        let worker;
        try {
            worker = await Tesseract.createWorker('eng', 1, {
                workerPath: appUrl('/vendor/tesseract/worker.min.js'),
                corePath: appUrl('/vendor/tesseract-core'),
                langPath: appUrl('/vendor/tesseract-lang'),
                cacheMethod: 'none',
                logger: message => {
                    if (message.status) {
                        const progress = Number.isFinite(message.progress) ? ` ${Math.round(message.progress * 100)}%` : '';
                        setOcrStatus(`${message.status}${progress}`);
                    }
                }
            });
            const { data } = await worker.recognize(file);
            ocrText.value = data?.text || '';
            setOcrStatus(ocrText.value.trim() ? 'OCR completed. Review the text, then parse to JSON or use it in Paste Import.' : 'OCR completed, but no text was detected.', ocrText.value.trim() ? 'success' : 'warning');
        } catch (err) {
            setOcrStatus(err.message || 'OCR failed', 'error');
        } finally {
            if (worker) {
                await worker.terminate();
            }
        }
    });

    ocrParseBtn?.addEventListener('click', async () => {
        const text = ocrText.value.trim();
        if (!text) {
            toast('OCR text is empty', 'warning');
            return;
        }

        setOcrStatus('Parsing OCR text...');
        try {
            latestOcrJson = await api('/import/paste/parse', {
                method: 'POST',
                body: { text }
            });
            ocrJsonPreview.textContent = JSON.stringify(latestOcrJson.parsed || latestOcrJson, null, 2);
            ocrJsonPreview.classList.remove('hidden');
            ocrDownloadJsonBtn.disabled = false;
            setOcrStatus('Parsed OCR text successfully. Review the JSON before importing.', 'success');
        } catch (err) {
            latestOcrJson = null;
            ocrDownloadJsonBtn.disabled = true;
            ocrJsonPreview.classList.add('hidden');
            setOcrStatus(err.message || 'Could not parse OCR text', 'error');
        }
    });

    ocrUsePasteBtn?.addEventListener('click', () => {
        const text = ocrText.value.trim();
        if (!text) {
            toast('OCR text is empty', 'warning');
            return;
        }

        document.getElementById('paste-data').value = text;
        document.querySelector('.tab[data-tab="paste"]')?.click();
        document.getElementById('paste-status').innerHTML = '<div class="text-success">OCR text copied into Paste Data. Review it, then import.</div>';
    });

    ocrDownloadJsonBtn?.addEventListener('click', () => {
        if (!latestOcrJson) {
            toast('Parse OCR text first', 'warning');
            return;
        }
        downloadJsonFile('racemate-ocr-import.json', latestOcrJson.parsed || latestOcrJson);
    });

    const duplicatePasteModal = document.getElementById('paste-duplicate-modal');
    const duplicatePasteSummary = document.getElementById('paste-duplicate-summary');
    const duplicatePasteUpdate = document.getElementById('paste-duplicate-update');
    const duplicatePasteCancel = document.getElementById('paste-duplicate-cancel');

    function askToUpdateExistingPaste(preview) {
        const existing = preview.existing || {};
        const parsedMeeting = preview.parsed?.meeting || {};
        const parsedRace = preview.parsed?.race || {};
        if (!duplicatePasteModal || !duplicatePasteSummary || !duplicatePasteUpdate || !duplicatePasteCancel) {
            return Promise.resolve(window.confirm('This race already exists. Update the existing race with the pasted data?'));
        }
        duplicatePasteSummary.innerHTML = `
            <div>
                <strong>${escapeHtml(existing.track || parsedMeeting.track || 'Unknown')} (${escapeHtml(existing.state || parsedMeeting.state || 'Unknown')})</strong>
            </div>
            <div class="mt-1">
                ${formatRaceDate(existing.date || parsedMeeting.date || '')} &bull;
                R${escapeHtml(existing.race_no || parsedRace.race_no || '?')}: ${escapeHtml(existing.race_name || parsedRace.race_name || `Race ${parsedRace.race_no || '?'}`)}
            </div>
            <div class="runner-meta mt-1">
                Existing race ID #${escapeHtml(existing.race_id || '-')} &bull;
                ${Number(existing.runners || 0)} stored runner${Number(existing.runners || 0) === 1 ? '' : 's'} &bull;
                ${Number(preview.parsed?.runners || 0)} pasted runner${Number(preview.parsed?.runners || 0) === 1 ? '' : 's'}
            </div>
        `;
        duplicatePasteModal.classList.remove('hidden');

        return new Promise(resolve => {
            const cleanup = () => {
                duplicatePasteModal.classList.add('hidden');
                duplicatePasteUpdate.removeEventListener('click', onUpdate);
                duplicatePasteCancel.removeEventListener('click', onCancel);
            };
            const onUpdate = () => {
                cleanup();
                resolve(true);
            };
            const onCancel = () => {
                cleanup();
                resolve(false);
            };
            duplicatePasteUpdate.addEventListener('click', onUpdate);
            duplicatePasteCancel.addEventListener('click', onCancel);
        });
    }

    async function importPastedText(text, status) {
        try {
            const result = await api('/import/paste', {
                method: 'POST',
                body: { text }
            });

            const meeting = result.parsed?.meeting;
            if (meeting) {
                state.settings.last_state = meeting.state;
                state.settings.last_track = meeting.track;
                state.settings.last_date = meeting.date;
            }
            if (meeting && result.parsed?.race) {
                const race = result.parsed.race;
                state.settings.last_imported_race_no = race.race_no;
                state.settings.last_imported_race_name = race.race_name || '';
                state.settings.last_imported_race_track = meeting.track;
                state.settings.last_imported_race_state = meeting.state;
                state.settings.last_imported_race_date = meeting.date;
                const lastImportedLabel = document.getElementById('last-imported-race-label');
                if (lastImportedLabel) {
                    lastImportedLabel.textContent = formatLastImportedRace(state.settings);
                }
            }

            const importedMeetings = Number(result.meetings || 0);
            const importedRaces = Number(result.races || 0);
            const importedRunners = Number(result.runners || 0);
            const didImportFormData = importedMeetings > 0 || importedRaces > 0 || importedRunners > 0;
            const didSettleRace = !!result.settlement;
            const hasAnalyzedRace = Number.isFinite(Number(result.analysisRaceId));
            const parsedOnlyResults = !didImportFormData && Array.isArray(result.parsed?.resultsPlacings) && result.parsed.resultsPlacings.length > 0;

            if (hasAnalyzedRace) {
                status.innerHTML = `
                    <div class="text-success">
                        ${result.message || 'Race created/updated from pasted data and analyzed successfully.'}<br>
                        Opening race ${result.parsed?.race?.race_no || ''}...
                    </div>
                `;
                toast('Race prepared from pasted data. Opening race view...', 'success');
                navigate(`#/race/${Number(result.analysisRaceId)}`);
                return;
            }

            if (didImportFormData) {
                status.innerHTML = `
                    <div class="text-success">
                        Imported: ${importedMeetings} meeting(s), ${importedRaces} race(s), ${importedRunners} runner(s)<br>
                        Meeting set to: ${meeting?.state || '-'} / ${meeting?.track || '-'} / ${meeting?.date || '-'}
                    </div>
                `;
                toast('Pasted data imported. Opening Today view...', 'success');
                navigate('#/today');
                return;
            }

            if (didSettleRace) {
                const settledCount = Array.isArray(result.settlement?.settled) ? result.settlement.settled.length : 0;
                status.innerHTML = `
                    <div class="text-success">
                        ${result.message || 'Results parsed and settlement completed.'}<br>
                        Settled bets: ${settledCount}
                    </div>
                `;
                toast('Results parsed. Opening Results view...', 'success');
                navigate('#/results');
                return;
            }

            if (parsedOnlyResults) {
                let detail = result.message || 'Results text parsed, but no matching imported race was found to settle.';
                if (result.reason === 'no_pending_bets') {
                    detail = 'Results parsed successfully, but there are no pending bets to settle yet.';
                } else if (result.reason === 'meeting_not_found') {
                    detail = 'Results parsed successfully, but that meeting has not been imported yet.';
                } else if (result.reason === 'race_not_found') {
                    const races = Array.isArray(result.diagnostics?.available_races) ? result.diagnostics.available_races : [];
                    const raceSummary = races.length
                        ? races.map(r => `R${r.race_no}`).join(', ')
                        : 'none';
                    detail = `Results parsed successfully, but race R${result.parsed?.race?.race_no || '?'} was not found. Available races: ${raceSummary}.`;
                }

                status.innerHTML = `
                    <div class="text-warning">
                        ${detail}<br>
                        Parsed meeting: ${meeting?.state || '-'} / ${meeting?.track || '-'} / ${meeting?.date || '-'}
                    </div>
                `;
                toast(detail, 'warning');
                navigate('#/results');
                return;
            }

            status.innerHTML = `
                <div class="text-success">
                    ${result.message || 'Paste processed successfully.'}
                </div>
            `;
            toast('Paste processed successfully', 'success');
        } catch (err) {
            status.innerHTML = `<div class="text-danger">${err.message}</div>`;
        }
    }

    // Pasted text import
    document.getElementById('import-paste-btn').addEventListener('click', async () => {
        const text = document.getElementById('paste-data').value;
        const status = document.getElementById('paste-status');

        if (!text || !text.trim()) {
            toast('Please paste race data first', 'warning');
            return;
        }

        status.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

        try {
            const preview = await api('/import/paste/preview', {
                method: 'POST',
                body: { text },
                silentError: true
            });

            if (preview.duplicate && preview.type === 'form_guide') {
                status.innerHTML = '<div class="text-warning">This race already exists. Choose whether to update it or cancel the import.</div>';
                const shouldUpdate = await askToUpdateExistingPaste(preview);
                if (!shouldUpdate) {
                    status.innerHTML = '<div class="text-muted">Import cancelled. Existing race was not changed.</div>';
                    toast('Import cancelled', 'warning');
                    return;
                }
                status.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
            }

            await importPastedText(text, status);
        } catch (err) {
            status.innerHTML = `<div class="text-danger">${err.message}</div>`;
            toast(err.message, 'error');
        }
    });
    
    // URL import
    document.getElementById('import-url-btn').addEventListener('click', async () => {
        const url = document.getElementById('import-url').value;
        if (!url) {
            toast('Please enter a URL', 'warning');
            return;
        }
        
        const status = document.getElementById('url-status');
        status.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
        
        try {
            const result = await api('/import/url', { method: 'POST', body: { url } });
            if (result.success) {
                status.innerHTML = `<div class="text-success">${result.message}</div>`;
            } else {
                status.innerHTML = `<div class="text-warning">${result.error}<br>${result.suggestion || ''}</div>`;
            }
        } catch (err) {
            status.innerHTML = `<div class="text-danger">${err.message}</div>`;
        }
    });
    
    // Save settings
    document.getElementById('save-settings-btn').addEventListener('click', async () => {
        const newSettings = {
            target_roi: document.getElementById('target-roi').value,
            min_confidence: document.getElementById('min-confidence').value,
            data_completeness_threshold: document.getElementById('data-threshold').value,
            staking_mode: document.getElementById('staking-mode').value,
            stake_percent: document.getElementById('stake-percent').value,
            kelly_fraction: document.getElementById('kelly-fraction').value,
            max_stake_per_race: document.getElementById('max-stake').value,
            max_daily_loss: document.getElementById('max-daily-loss').value,
            min_bankroll_floor: document.getElementById('min-floor').value
        };
        
        try {
            await api('/settings', { method: 'POST', body: newSettings });
            state.settings = { ...state.settings, ...newSettings };
            toast('Settings saved!', 'success');
        } catch (err) {}
    });

    // Delete meeting data
    document.getElementById('delete-meeting-btn').addEventListener('click', async () => {
        const stateVal = deleteStateSelect.value;
        const track = (deleteTrackSelect.value || '').trim();
        const date = document.getElementById('delete-date').value;
        const status = document.getElementById('delete-status');

        if (!track || !date) {
            toast('Please provide state, track and date to delete', 'warning');
            return;
        }

        status.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

        try {
            const result = await api('/meeting/delete', {
                method: 'POST',
                body: { state: stateVal, track, date }
            });

            status.innerHTML = `
                <div class="text-success">
                    Deleted meeting ${track} (${stateVal}) ${date}. Removed ${result.counts?.races || 0} race(s), ${result.counts?.runners || 0} runner(s), ${result.counts?.selections || 0} selection(s), ${result.counts?.bets || 0} bet(s).
                </div>
            `;

            if (state.settings.last_state === stateVal && state.settings.last_track === track && state.settings.last_date === date) {
                state.settings.last_track = '';
            }

            toast('Meeting data deleted', 'success');
        } catch (err) {
            status.innerHTML = `<div class="text-danger">${err.message}</div>`;
        }
    });
}

// ============ Global helpers ============
window.navigate = navigate;

// ============ Start ============
window.addEventListener('hashchange', handleRoute);
document.addEventListener('DOMContentLoaded', init);
