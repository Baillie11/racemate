/**
 * Horse Racing Selection & Bankroll Tracking App
 * Express Server with API endpoints
 */

const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const path = require('path');
const fs = require('fs');

// Initialize database (async)
const db = require('./db/database');

// Services
const selector = require('./services/selector');
const staking = require('./services/staking');
const bankroll = require('./services/bankroll');

// Parsers
const genericHtml = require('./parsers/genericHtml');
const sportsbookAdapter = require('./parsers/skeletonSportsbookAdapter');
const { parsePastedFormGuide } = require('./parsers/pastedFormGuide');
const racingImportService = require('./src/services/racingImportService');
const { startRacingImportCron } = require('./src/jobs/racingImportCron');
const { todayISO } = require('./src/utils/racingDate');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_PATH = (process.env.BASE_PATH || '/racemate').replace(/\/+$/, '');
let databaseReady = null;

function ensureDatabaseReady() {
    if (!databaseReady) {
        databaseReady = db.initSchema();
    }
    return databaseReady;
}

// Middleware
app.use(express.json());
if (BASE_PATH) {
    app.use((req, res, next) => {
        if (req.url === BASE_PATH) {
            req.url = '/';
        } else if (req.url.startsWith(BASE_PATH + '/api/')) {
            req.url = req.url.slice(BASE_PATH.length);
        }
        next();
    });
}
app.use(express.static(path.join(__dirname, 'public')));
app.use(BASE_PATH, express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// File upload configuration
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

function writeAuditLog(eventType, message, options = {}) {
    try {
        return db.auditLogs.create({
            user_id: options.userId || null,
            event_type: eventType,
            message,
            entity_type: options.entityType || null,
            entity_id: options.entityId || null,
            payload_json: options.payload || null
        });
    } catch (err) {
        console.error('Failed to write audit log:', err.message);
        return null;
    }
}

function getRequestUserId(req) {
    return req.user?.id || 1;
}

app.use('/api', async (req, res, next) => {
    try {
        await ensureDatabaseReady();
        const requestedId = parseInt(req.get('X-Racemate-User-Id') || req.query.user_id, 10);
        const user = Number.isInteger(requestedId) ? db.users.getById(requestedId) : null;
        req.user = user || db.users.ensureDefault();
        next();
    } catch (err) {
        next(err);
    }
});

function parseAuditPayload(row) {
    if (!row.payload_json) return null;
    try {
        return JSON.parse(row.payload_json);
    } catch (err) {
        return { raw: row.payload_json };
    }
}

function activityFromTransaction(tx) {
    const typeLabel = String(tx.type || 'transaction').replace(/_/g, ' ').toUpperCase();
    const amount = Number(tx.amount || 0);
    return {
        id: `transaction-${tx.id}`,
        activity_type: 'transaction',
        event_type: `TRANSACTION_${String(tx.type || 'unknown').toUpperCase()}`,
        message: `${typeLabel}: ${amount < 0 ? '-' : ''}$${Math.abs(amount).toFixed(2)}`,
        entity_type: 'transaction',
        entity_id: tx.id,
        payload_json: {
            transaction_id: tx.id,
            type: tx.type,
            amount: tx.amount,
            bet_id: tx.bet_id,
            description: tx.description
        },
        created_at: tx.created_at
    };
}

function importAuditPayload(source, imported, extra = {}) {
    return {
        source,
        meetings: imported?.meetings || 0,
        races: imported?.races || 0,
        runners: imported?.runners || 0,
        ...extra
    };
}

// Check and update track list on startup if needed
const TRACKS_PATH = path.join(__dirname, 'public', 'data', 'au_tracks.json');
const ALL_STATE_CODES = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'];

function normalizeTrackMap(tracks = {}) {
    return ALL_STATE_CODES.reduce((acc, code) => {
        acc[code] = Array.isArray(tracks[code]) ? tracks[code] : [];
        return acc;
    }, {});
}

function checkTracksFile() {
    try {
        if (!fs.existsSync(TRACKS_PATH)) {
            console.log('Track list not found. Running update script...');
            require('./scripts/update_tracks');
            return;
        }
        
        const stats = fs.statSync(TRACKS_PATH);
        const ageInDays = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);
        
        if (ageInDays > 30) {
            console.log('Track list older than 30 days. Consider running: npm run update:tracks');
        }
    } catch (err) {
        console.error('Error checking tracks file:', err.message);
    }
}
checkTracksFile();

// ============ TRACKS API ============

// GET /api/tracks - Get track list by state
app.get('/api/tracks', (req, res) => {
    try {
        if (fs.existsSync(TRACKS_PATH)) {
            const tracks = JSON.parse(fs.readFileSync(TRACKS_PATH, 'utf8'));
            res.json(normalizeTrackMap(tracks));
        } else {
            res.json(normalizeTrackMap());
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/tracks/update - Manually trigger track list update
app.post('/api/tracks/update', async (req, res) => {
    try {
        const { updateTracks } = require('./scripts/update_tracks');
        const tracks = await updateTracks();
        writeAuditLog('TRACK_LIST_UPDATED', 'Australian track list refreshed', {
            entityType: 'tracks',
            payload: {
                state_count: Object.keys(tracks || {}).length,
                track_count: Object.values(tracks || {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0)
            }
        });
        res.json({ success: true, tracks });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ SETTINGS API ============

// GET /api/users - List local app profiles
app.get('/api/users', (req, res) => {
    try {
        res.json({
            current_user: req.user,
            users: db.users.getAll()
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/users - Create a local app profile
app.post('/api/users', (req, res) => {
    try {
        const user = db.users.create(req.body?.name);
        writeAuditLog('USER_CREATED', `Created user profile ${user.name}`, {
            userId: user.id,
            entityType: 'user',
            entityId: user.id
        });
        res.status(201).json(user);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// GET /api/settings - Get all settings
app.get('/api/settings', (req, res) => {
    try {
        const settings = db.settings.getAll(getRequestUserId(req));
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/settings - Update settings
app.post('/api/settings', (req, res) => {
    try {
        const userId = getRequestUserId(req);
        const previous = db.settings.getAll(userId);
        db.settings.setMultiple(req.body, userId);
        const next = db.settings.getAll(userId);
        const changed = Object.keys(req.body || {}).reduce((acc, key) => {
            if (String(previous[key] ?? '') !== String(next[key] ?? '')) {
                acc[key] = {
                    from: previous[key] ?? null,
                    to: next[key] ?? null
                };
            }
            return acc;
        }, {});
        writeAuditLog('SETTINGS_UPDATED', 'Application settings updated', {
            userId,
            entityType: 'settings',
            payload: { changed }
        });
        res.json({ success: true, settings: next });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/settings/track - Save last selected track
app.post('/api/settings/track', (req, res) => {
    try {
        const userId = getRequestUserId(req);
        const { state, track, date } = req.body;
        db.settings.set('last_state', state, userId);
        db.settings.set('last_track', track, userId);
        if (date) {
            db.settings.set('last_date', date, userId);
        }
        writeAuditLog('TRACK_SELECTION_SAVED', `Selected ${track || 'All tracks'} (${state || 'All states'})`, {
            userId,
            entityType: 'settings',
            payload: { state, track, date: date || null }
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ MEETINGS API ============

// GET /api/meeting - Get meeting by state/track/date
app.get('/api/meeting', (req, res) => {
    try {
        const { state, track, date } = req.query;
        
        if (!state || !track || !date) {
            return res.status(400).json({ error: 'Missing state, track, or date parameter' });
        }
        
        const meeting = db.meetings.getByDateTrack(date, state, track);
        
        if (!meeting) {
            return res.json({ 
                found: false, 
                message: 'No meeting data found. Please import form guide data.',
                state, track, date
            });
        }
        
        const races = db.races.getByMeeting(meeting.id);
        res.json({ found: true, meeting, races });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/meetings - Get all meetings
app.get('/api/meetings', (req, res) => {
    try {
        const { date } = req.query;
        const meetings = date ? db.meetings.getByDate(date) : db.meetings.getAll();
        res.json(meetings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/dashboard - Home dashboard races with optional date/state/track filters
app.get('/api/dashboard', (req, res) => {
    try {
        const userId = getRequestUserId(req);
        const { date, state, track } = req.query;

        const allMeetings = db.meetings.getAll();
        const selectedDate = date && date !== 'all' ? date : '';
        let meetings = selectedDate ? db.meetings.getByDate(selectedDate) : allMeetings;
        if (state) {
            meetings = meetings.filter(m => m.state === state);
        }
        if (track) {
            meetings = meetings.filter(m => m.track === track);
        }

        const meetingCards = meetings.map(meeting => {
            const races = db.races.getByMeeting(meeting.id).map(race => {
                const pendingCount = db.bets.getPendingByRace(race.id, userId).length;
                const allRaceBets = db.bets.getByRace(race.id, userId);
                const betRunners = allRaceBets.reduce((acc, bet) => {
                    const key = `${bet.saddle_no || ''}-${bet.horse_name || ''}`;
                    if (!acc.some(item => item.key === key)) {
                        acc.push({
                            key,
                            saddle_no: bet.saddle_no || null,
                            horse_name: bet.horse_name || null
                        });
                    }
                    return acc;
                }, []);
                const settledBets = allRaceBets.filter(b => b.status !== 'pending');
                const totalProfit = settledBets.reduce((sum, b) =>
                    sum + ((Number(b.payout_win || 0) + Number(b.payout_place || 0)) - (Number(b.stake_win || 0) + Number(b.stake_place || 0))), 0);
                const resultRow = db.raceResults.getByRace(race.id, userId);

                let outcomeText = null;
                if (resultRow) {
                    if (settledBets.length === 0) outcomeText = 'No bets placed';
                    else if (totalProfit > 0) outcomeText = `Won $${totalProfit.toFixed(2)}`;
                    else if (totalProfit < 0) outcomeText = `No win (-$${Math.abs(totalProfit).toFixed(2)})`;
                    else outcomeText = 'No win';
                }

                return {
                    ...race,
                    pending_bets: pendingCount,
                    bet_count: allRaceBets.length,
                    bet_runners: betRunners.map(({ key, ...runner }) => runner),
                    settled_bets: settledBets.length,
                    result_entered: !!resultRow,
                    placings: resultRow ? {
                        first: resultRow.first_saddle,
                        second: resultRow.second_saddle,
                        third: resultRow.third_saddle
                    } : null,
                    outcome_text: outcomeText
                };
            }).sort((a, b) => Number(a.race_no || 0) - Number(b.race_no || 0));
            return { meeting, races };
        }).sort((a, b) => {
            const dateCompare = String(a.meeting.date || '').localeCompare(String(b.meeting.date || ''));
            if (dateCompare !== 0) return dateCompare;
            const trackCompare = String(a.meeting.track || '').localeCompare(String(b.meeting.track || ''));
            if (trackCompare !== 0) return trackCompare;
            return String(a.meeting.state || '').localeCompare(String(b.meeting.state || ''));
        });

        const raceCount = meetingCards.reduce((sum, item) => sum + item.races.length, 0);
        const pendingCount = meetingCards.reduce(
            (sum, item) => sum + item.races.reduce((inner, race) => inner + (race.pending_bets || 0), 0),
            0
        );

        res.json({
            date: selectedDate,
            all_dates: !selectedDate,
            available_dates: [...new Set(allMeetings.map(m => m.date).filter(Boolean))].sort(),
            available_states: [...new Set(allMeetings.map(m => m.state).filter(Boolean))].sort(),
            available_tracks: [...new Set(allMeetings.map(m => m.track).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
            available_tracks_by_state: allMeetings.reduce((acc, meeting) => {
                if (!meeting.state || !meeting.track) return acc;
                if (!acc[meeting.state]) acc[meeting.state] = [];
                if (!acc[meeting.state].includes(meeting.track)) acc[meeting.state].push(meeting.track);
                return acc;
            }, {}),
            meetings: meetingCards,
            summary: {
                meetings: meetingCards.length,
                races: raceCount,
                pending_bets: pendingCount
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ AUTOMATED RACING DATA API ============

// GET /api/racing/meetings/today - Imported racing meetings for today
app.get('/api/racing/meetings/today', (req, res) => {
    try {
        const today = todayISO();
        const meetings = db.meetings.getImportedByDate(today);
        const lastImportedAt = db.settings.get('last_racing_import_at') || '';
        let raceCount = 0;
        let runnerCount = 0;
        for (const meeting of meetings) {
            const races = db.races.getByMeeting(meeting.id);
            raceCount += races.length;
            for (const race of races) {
                runnerCount += db.runners.getByRace(race.id).length;
            }
        }
        res.json({
            date: today,
            meetings,
            last_imported_at: lastImportedAt,
            summary: {
                meetings: meetings.length,
                races: raceCount,
                runners: runnerCount
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/horses - Search the permanent horse profile catalogue
app.get('/api/horses', (req, res) => {
    try {
        const horses = db.horses.list(req.query.search || '', req.query.limit || 250);
        res.json({
            horses,
            total: horses.length,
            summary: db.horses.getSummary()
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/horses/:id - Horse identity and all retained race appearances
app.get('/api/horses/:id(\\d+)', (req, res) => {
    try {
        const profile = db.horses.getProfile(parseInt(req.params.id, 10));
        if (!profile) {
            return res.status(404).json({ error: 'Horse profile not found' });
        }
        res.json(profile);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/racing/meetings/:id/races - Races for an imported meeting
app.get('/api/racing/meetings/:id/races', (req, res) => {
    try {
        const meetingId = parseInt(req.params.id, 10);
        const meeting = db.meetings.getById(meetingId);
        if (!meeting) {
            return res.status(404).json({ error: 'Meeting not found' });
        }

        res.json({ meeting, races: db.races.getByMeeting(meetingId) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/racing/races/:id/runners - Runners for an imported race
app.get('/api/racing/races/:id/runners', (req, res) => {
    try {
        const raceId = parseInt(req.params.id, 10);
        const race = db.races.getById(raceId);
        if (!race) {
            return res.status(404).json({ error: 'Race not found' });
        }

        res.json({ race, runners: db.runners.getByRace(raceId) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/racing/import/today - Manually run configured provider import
app.post('/api/racing/import/today', async (req, res) => {
    try {
        const result = await racingImportService.importToday({
            providerName: req.body?.provider || process.env.RACING_PROVIDER || 'sample'
        });
        res.json(result);
    } catch (err) {
        writeAuditLog('RACING_IMPORT_FAILED', 'Manual racing import failed', {
            entityType: 'racing_import',
            payload: { error: err.message }
        });
        res.status(500).json({ error: err.message });
    }
});

// POST /api/racing/import/results - Stub for later provider results import
app.post('/api/racing/import/results', async (req, res) => {
    res.json(await racingImportService.importResults(req.body || {}));
});

// POST /api/racing/import/odds - Stub for later provider odds snapshots
app.post('/api/racing/import/odds', async (req, res) => {
    res.json(await racingImportService.importOdds(req.body || {}));
});

// POST /api/meeting/delete - Delete meeting and related races/runners/selections/bets
app.post('/api/meeting/delete', (req, res) => {
    try {
        const userId = getRequestUserId(req);
        const { date, state, track } = req.body;

        if (!date || !state || !track) {
            return res.status(400).json({ error: 'Missing date, state, or track' });
        }

        const result = db.meetings.deleteByDateTrack(date, state, track);
        if (!result.deleted) {
            return res.status(404).json(result);
        }

        const lastState = db.settings.get('last_state', userId);
        const lastTrack = db.settings.get('last_track', userId);
        const lastDate = db.settings.get('last_date', userId);
        if (lastState === state && lastTrack === track && lastDate === date) {
            db.settings.set('last_track', '', userId);
        }

        writeAuditLog('MEETING_DELETED', `Deleted meeting ${track} (${state}) on ${date}`, {
            userId,
            entityType: 'meeting',
            entityId: result.meeting_id || null,
            payload: {
                date,
                state,
                track,
                ...result,
                cleared_last_track_selection: lastState === state && lastTrack === track && lastDate === date
            }
        });

        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ RACES API ============

// GET /api/races/:id - Get race with full details
app.get('/api/races/:id', (req, res) => {
    try {
        const race = db.races.getWithDetails(parseInt(req.params.id));
        if (!race) {
            return res.status(404).json({ error: 'Race not found' });
        }
        res.json(race);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/races/:id/analyze - Run selection engine on race
app.post('/api/races/:id/analyze', async (req, res) => {
    try {
        const raceId = parseInt(req.params.id);
        const race = db.races.getById(raceId);
        
        if (!race) {
            return res.status(404).json({ error: 'Race not found' });
        }
        
        const result = await selector.selectForRace(raceId, race, getRequestUserId(req));
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/races/:id/meta - Update race and meeting metadata
app.put('/api/races/:id/meta', (req, res) => {
    try {
        const raceId = parseInt(req.params.id, 10);
        const race = db.races.getById(raceId);
        if (!race) {
            return res.status(404).json({ error: 'Race not found' });
        }

        const meeting = db.meetings.getById(race.meeting_id);
        if (!meeting) {
            return res.status(404).json({ error: 'Meeting not found for race' });
        }

        const body = req.body || {};
        const targetMeetingData = {
            date: body.date || meeting.date,
            state: body.state || meeting.state,
            track: body.track || meeting.track,
            weather: body.weather ?? meeting.weather,
            rail_position: body.rail_position ?? meeting.rail_position
        };
        const existingTargetMeeting = db.meetings.getByDateTrack(
            targetMeetingData.date,
            targetMeetingData.state,
            targetMeetingData.track
        );

        let nextMeeting;
        let raceToUpdate = race;
        if (existingTargetMeeting && existingTargetMeeting.id !== meeting.id) {
            const targetRaceNo = Number.isInteger(parseInt(body.race_no, 10)) ? parseInt(body.race_no, 10) : race.race_no;
            const conflictingRace = db.races.getByMeetingAndNumber(existingTargetMeeting.id, targetRaceNo);
            if (conflictingRace && conflictingRace.id !== race.id) {
                writeAuditLog('RACE_META_UPDATE_BLOCKED', `Race metadata update blocked for R${targetRaceNo}`, {
                    entityType: 'race',
                    entityId: race.id,
                    payload: {
                        race_id: race.id,
                        current_meeting_id: meeting.id,
                        target_meeting_id: existingTargetMeeting.id,
                        target_date: targetMeetingData.date,
                        target_state: targetMeetingData.state,
                        target_track: targetMeetingData.track,
                        target_race_no: targetRaceNo,
                        conflicting_race_id: conflictingRace.id
                    }
                });
                return res.status(409).json({
                    error: `Race ${targetRaceNo} already exists for ${targetMeetingData.track} (${targetMeetingData.state}) on ${targetMeetingData.date}.`
                });
            }

            raceToUpdate = db.races.moveToMeeting(raceId, existingTargetMeeting.id);
            db.meetings.deleteIfEmpty(meeting.id);
            nextMeeting = existingTargetMeeting;
        } else {
            nextMeeting = db.meetings.updateById(meeting.id, targetMeetingData);
        }

        const nextRace = db.races.updateById(raceId, {
            race_no: Number.isInteger(parseInt(body.race_no, 10)) ? parseInt(body.race_no, 10) : raceToUpdate.race_no,
            race_name: body.race_name ?? raceToUpdate.race_name,
            start_time: body.start_time ?? raceToUpdate.start_time,
            distance: Number.isInteger(parseInt(body.distance, 10)) ? parseInt(body.distance, 10) : raceToUpdate.distance,
            track_condition: body.track_condition ?? raceToUpdate.track_condition,
            race_class: body.race_class ?? raceToUpdate.race_class,
            prize_money: Number.isInteger(parseInt(body.prize_money, 10)) ? parseInt(body.prize_money, 10) : raceToUpdate.prize_money
        });

        const updated = db.races.getWithDetails(nextRace.id);
        writeAuditLog('RACE_META_UPDATED', `Race metadata updated for ${nextMeeting.track} R${updated.race_no}`, {
            entityType: 'race',
            entityId: updated.id,
            payload: {
                race_id: updated.id,
                previous: {
                    meeting_id: meeting.id,
                    date: meeting.date,
                    state: meeting.state,
                    track: meeting.track,
                    race_no: race.race_no,
                    race_name: race.race_name,
                    distance: race.distance,
                    track_condition: race.track_condition,
                    race_class: race.race_class
                },
                current: {
                    meeting_id: nextMeeting.id,
                    date: nextMeeting.date,
                    state: nextMeeting.state,
                    track: nextMeeting.track,
                    race_no: updated.race_no,
                    race_name: updated.race_name,
                    distance: updated.distance,
                    track_condition: updated.track_condition,
                    race_class: updated.race_class
                },
                moved_to_existing_meeting: Boolean(existingTargetMeeting && existingTargetMeeting.id !== meeting.id),
                meeting_id: nextMeeting.id,
                date: nextMeeting.date,
                state: nextMeeting.state,
                track: nextMeeting.track,
                race_no: updated.race_no,
                race_name: updated.race_name,
                distance: updated.distance,
                track_condition: updated.track_condition,
                race_class: updated.race_class
            }
        });

        res.json({ success: true, race: updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/races/:id - Delete one race and its dependent data
app.delete('/api/races/:id', (req, res) => {
    try {
        const raceId = parseInt(req.params.id, 10);
        const result = db.races.deleteById(raceId);
        if (!result.deleted) {
            return res.status(404).json(result);
        }

        writeAuditLog('RACE_DELETED', `Deleted ${result.meeting?.track || 'Unknown'} R${result.race.race_no}`, {
            entityType: 'race',
            entityId: raceId,
            payload: {
                race_id: raceId,
                meeting_id: result.meeting?.id || null,
                date: result.meeting?.date || null,
                state: result.meeting?.state || null,
                track: result.meeting?.track || null,
                race_no: result.race.race_no,
                race_name: result.race.race_name,
                removed_empty_meeting: result.removed_empty_meeting,
                counts: result.counts
            }
        });

        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ RUNNERS API ============

// PUT /api/runners/:id/odds - Update runner odds
app.put('/api/runners/:id/odds', (req, res) => {
    try {
        const runnerId = parseInt(req.params.id, 10);
        const { odds_win, odds_place } = req.body;
        const before = db.runners.getById(runnerId);
        db.runners.updateOdds(runnerId, odds_win, odds_place);
        const after = db.runners.getById(runnerId);
        writeAuditLog('RUNNER_ODDS_UPDATED', `Odds updated for ${after?.horse_name || 'runner'}`, {
            entityType: 'runner',
            entityId: runnerId,
            payload: {
                runner_id: runnerId,
                race_id: after?.race_id || before?.race_id || null,
                horse_name: after?.horse_name || before?.horse_name || null,
                saddle_no: after?.saddle_no || before?.saddle_no || null,
                odds_win_from: before?.odds_win ?? null,
                odds_win_to: after?.odds_win ?? null,
                odds_place_from: before?.odds_place ?? null,
                odds_place_to: after?.odds_place ?? null
            }
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/runners/:id/scratch - Mark runner as scratched
app.put('/api/runners/:id/scratch', (req, res) => {
    try {
        const runnerId = parseInt(req.params.id, 10);
        const before = db.runners.getById(runnerId);
        db.runners.scratch(runnerId);
        const after = db.runners.getById(runnerId);
        writeAuditLog('RUNNER_SCRATCHED', `${after?.horse_name || 'Runner'} scratched`, {
            entityType: 'runner',
            entityId: runnerId,
            payload: {
                runner_id: runnerId,
                race_id: after?.race_id || before?.race_id || null,
                horse_name: after?.horse_name || before?.horse_name || null,
                saddle_no: after?.saddle_no || before?.saddle_no || null,
                scratched_from: Boolean(before?.scratched),
                scratched_to: Boolean(after?.scratched)
            }
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ SELECTIONS API ============

// GET /api/selections/:raceId - Get selections for a race
app.get('/api/selections/:raceId', (req, res) => {
    try {
        const userId = getRequestUserId(req);
        const selections = db.selections.getByRace(parseInt(req.params.raceId), userId);
        const recommendation = db.selections.getRecommendation(parseInt(req.params.raceId), userId);
        res.json({ selections, recommendation });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ BETS API ============

// GET /api/bets - Get all bets
app.get('/api/bets', (req, res) => {
    try {
        const userId = getRequestUserId(req);
        const { status } = req.query;
        const bets = status === 'pending' ? db.bets.getPending(userId) : db.bets.getAll(100, userId);
        res.json(bets);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/logs - Get audit log events
app.get('/api/logs', (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
        const eventType = req.query.type || null;
        const logs = db.auditLogs.getAll(limit, eventType, getRequestUserId(req)).map(row => ({
            ...row,
            payload_json: parseAuditPayload(row)
        }));
        res.json(logs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/activity - Unified audit and transaction activity feed
app.get('/api/activity', (req, res) => {
    try {
        const userId = getRequestUserId(req);
        const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
        const auditEvents = db.auditLogs.getAll(limit, null, userId).map(row => ({
            ...row,
            activity_type: 'audit',
            payload_json: parseAuditPayload(row)
        }));
        const transactionEvents = db.transactions.getAll(limit, userId).map(activityFromTransaction);
        const activity = [...auditEvents, ...transactionEvents]
            .sort((a, b) => {
                const timeDiff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
                if (timeDiff !== 0) return timeDiff;
                return String(b.id).localeCompare(String(a.id));
            })
            .slice(0, limit);

        res.json(activity);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/bets - Place a new bet
app.post('/api/bets', (req, res) => {
    try {
        const userId = getRequestUserId(req);
        const { selection_id, stake_win, stake_place, odds_win, odds_place } = req.body;
        
        // Check risk controls
        const totalStake = (stake_win || 0) + (stake_place || 0);
        const riskCheck = staking.checkRiskControls(totalStake, userId);
        
        if (!riskCheck.canBet) {
            writeAuditLog('BET_BLOCKED', 'Risk controls blocked a bet', {
                userId,
                entityType: 'bet',
                payload: {
                    selection_id,
                    stake_win: stake_win || 0,
                    stake_place: stake_place || 0,
                    odds_win,
                    odds_place,
                    total_stake: totalStake,
                    issues: riskCheck.issues
                }
            });
            return res.status(400).json({ 
                error: 'Risk control blocked bet',
                issues: riskCheck.issues
            });
        }
        
        // Create bet
        const bet = db.bets.create({
            user_id: userId,
            selection_id,
            stake_win: stake_win || 0,
            stake_place: stake_place || 0,
            odds_win,
            odds_place
        });
        
        // Record stake transaction
        bankroll.recordBetStake(bet.id, totalStake, userId);

        const detailed = db.bets.getDetailedById(bet.id, userId);
        writeAuditLog('BET_PLACED', `Bet placed on ${detailed?.track || 'Unknown'} R${detailed?.race_no || '?'} ${detailed?.horse_name || ''}`.trim(), {
            userId,
            entityType: 'bet',
            entityId: bet.id,
            payload: {
                bet_id: bet.id,
                race_id: detailed?.race_id,
                race_no: detailed?.race_no,
                race_name: detailed?.race_name,
                state: detailed?.state,
                track: detailed?.track,
                date: detailed?.date,
                horse_name: detailed?.horse_name,
                saddle_no: detailed?.saddle_no,
                stake_win: detailed?.stake_win,
                stake_place: detailed?.stake_place,
                odds_win: detailed?.odds_win,
                odds_place: detailed?.odds_place,
                total_stake: totalStake
            }
        });
        
        res.json({ 
            success: true, 
            bet, 
            bankroll: bankroll.getBankroll(userId),
            warnings: riskCheck.issues.filter(i => i.severity === 'warning')
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/bets/:id/calculate-stake - Calculate recommended stakes
app.post('/api/bets/:id/calculate-stake', (req, res) => {
    try {
        const userId = getRequestUserId(req);
        const selection = db.selections.getById(parseInt(req.params.id), userId);
        if (!selection) {
            return res.status(404).json({ error: 'Selection not found' });
        }
        
        const stakes = staking.calculateStakes(selection, null, userId);
        const payouts = staking.calculatePayouts(
            stakes.stake_win, 
            stakes.stake_place, 
            selection.odds_win, 
            selection.odds_place
        );
        
        res.json({ stakes, payouts });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ RESULTS API ============

// POST /api/results/:betId - Settle a bet
app.post('/api/results/:betId(\\d+)', (req, res) => {
    try {
        const userId = getRequestUserId(req);
        const { result, position } = req.body;
        
        if (!['won', 'placed', 'lost', 'void'].includes(result)) {
            return res.status(400).json({ error: 'Invalid result. Must be won, placed, lost, or void' });
        }
        
        const settlement = bankroll.settleBet(parseInt(req.params.betId), result, position, userId);
        const detailed = db.bets.getDetailedById(parseInt(req.params.betId), userId);
        writeAuditLog('BET_SETTLED', `Bet settled as ${result.toUpperCase()} for ${detailed?.track || 'Unknown'} R${detailed?.race_no || '?'} ${detailed?.horse_name || ''}`.trim(), {
            userId,
            entityType: 'bet',
            entityId: parseInt(req.params.betId),
            payload: {
                bet_id: parseInt(req.params.betId),
                race_id: detailed?.race_id,
                race_no: detailed?.race_no,
                race_name: detailed?.race_name,
                state: detailed?.state,
                track: detailed?.track,
                date: detailed?.date,
                horse_name: detailed?.horse_name,
                saddle_no: detailed?.saddle_no,
                result,
                position: position || null,
                payout_win: settlement?.bet?.payout_win,
                payout_place: settlement?.bet?.payout_place,
                profit: settlement?.profit
            }
        });
        res.json(settlement);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/results/race - Settle all pending bets for a race using top-three saddle numbers
app.post('/api/results/race', (req, res) => {
    try {
        const userId = getRequestUserId(req);
        const { race_id, first, second, third } = req.body;

        if (!race_id) {
            return res.status(400).json({ error: 'race_id is required' });
        }

        const race = db.races.getById(parseInt(race_id));
        if (!race) {
            return res.status(404).json({ error: 'Race not found' });
        }

        const finishOrder = [first, second, third]
            .map(value => parseInt(value))
            .filter(value => Number.isInteger(value) && value > 0);

        if (finishOrder.length === 0) {
            return res.status(400).json({ error: 'Enter at least one finishing saddle number' });
        }

        const storedResult = db.raceResults.upsert(
            parseInt(race_id),
            finishOrder[0] || null,
            finishOrder[1] || null,
            finishOrder[2] || null,
            userId
        );

        const pendingBets = db.bets.getPendingByRace(parseInt(race_id), userId);

        const settled = [];
        for (const bet of pendingBets) {
            let result = 'lost';
            let position = null;

            if (bet.saddle_no === finishOrder[0]) {
                result = 'won';
                position = 1;
            } else if (finishOrder[1] && bet.saddle_no === finishOrder[1]) {
                result = 'placed';
                position = 2;
            } else if (finishOrder[2] && bet.saddle_no === finishOrder[2]) {
                result = 'placed';
                position = 3;
            }

            const settlement = bankroll.settleBet(bet.id, result, position, userId);
            settled.push({
                bet_id: bet.id,
                horse_name: bet.horse_name,
                saddle_no: bet.saddle_no,
                result,
                position,
                profit: settlement.profit
            });
        }

        const allRaceBets = db.bets.getByRace(parseInt(race_id), userId);
        const settledBets = allRaceBets.filter(b => b.status !== 'pending');
        const totalProfit = settledBets.reduce((sum, b) =>
            sum + ((Number(b.payout_win || 0) + Number(b.payout_place || 0)) - (Number(b.stake_win || 0) + Number(b.stake_place || 0))), 0);

        let outcomeText = 'No win';
        if (settledBets.length === 0) {
            outcomeText = 'No bets placed';
        } else if (totalProfit > 0) {
            outcomeText = `Won $${totalProfit.toFixed(2)}`;
        } else if (totalProfit < 0) {
            outcomeText = `No win (-$${Math.abs(totalProfit).toFixed(2)})`;
        }

        const meeting = db.meetings.getById(race.meeting_id);
        writeAuditLog('RACE_RESULTS_ENTERED', `Results entered for ${meeting?.track || 'Unknown'} R${race.race_no} (${finishOrder.join('-')})`, {
            userId,
            entityType: 'race',
            entityId: race.id,
            payload: {
                race_id: race.id,
                race_no: race.race_no,
                race_name: race.race_name,
                state: meeting?.state || null,
                track: meeting?.track || null,
                date: meeting?.date || null,
                placings: {
                    first: storedResult?.first_saddle || null,
                    second: storedResult?.second_saddle || null,
                    third: storedResult?.third_saddle || null
                },
                settled_count: settled.length,
                outcome_text: outcomeText,
                total_profit: totalProfit
            }
        });

        res.json({
            success: true,
            settled,
            bankroll: bankroll.getBankroll(userId),
            placings: {
                first: storedResult?.first_saddle || null,
                second: storedResult?.second_saddle || null,
                third: storedResult?.third_saddle || null
            },
            summary: {
                settled_bets: settledBets.length,
                total_profit: totalProfit,
                outcome_text: outcomeText
            },
            race: {
                id: race.id,
                race_no: race.race_no,
                race_name: race.race_name,
                track: pendingBets[0]?.track,
                date: pendingBets[0]?.date
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function raceDataTrack(raceId) {
    const race = db.races.getById(raceId);
    if (!race) return null;
    const meeting = db.meetings.getById(race.meeting_id);
    return meeting ? meeting.track : null;
}

function raceDataDate(raceId) {
    const race = db.races.getById(raceId);
    if (!race) return null;
    const meeting = db.meetings.getById(race.meeting_id);
    return meeting ? meeting.date : null;
}

// ============ BANKROLL API ============

// GET /api/bankroll - Get current bankroll
app.get('/api/bankroll', (req, res) => {
    try {
        res.json({ bankroll: bankroll.getBankroll(getRequestUserId(req)) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/bankroll/summary - Get full summary
app.get('/api/bankroll/summary', (req, res) => {
    try {
        res.json(bankroll.getSummary(getRequestUserId(req), req.query.period || 'all_time'));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/bankroll/initial - Set initial bankroll
app.post('/api/bankroll/initial', (req, res) => {
    try {
        const userId = getRequestUserId(req);
        const { amount } = req.body;
        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Amount must be positive' });
        }
        const previousBankroll = bankroll.getBankroll(userId);
        const newBankroll = bankroll.setInitialBankroll(amount, userId);
        const transaction = db.transactions.getAll(1, userId)[0] || null;
        writeAuditLog('BANKROLL_INITIAL_SET', `Initial bankroll set to $${Number(amount).toFixed(2)}`, {
            userId,
            entityType: 'bankroll',
            entityId: transaction?.id || null,
            payload: {
                amount: Number(amount),
                previous_bankroll: previousBankroll,
                new_bankroll: newBankroll,
                transaction_id: transaction?.id || null
            }
        });
        res.json({ success: true, bankroll: newBankroll });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/bankroll/deposit - Deposit funds
app.post('/api/bankroll/deposit', (req, res) => {
    try {
        const userId = getRequestUserId(req);
        const { amount, description } = req.body;
        const previousBankroll = bankroll.getBankroll(userId);
        const transaction = bankroll.deposit(amount, description, userId);
        const newBankroll = bankroll.getBankroll(userId);
        writeAuditLog('BANKROLL_DEPOSIT', `Deposited $${Number(amount).toFixed(2)}`, {
            userId,
            entityType: 'transaction',
            entityId: transaction?.id || null,
            payload: {
                transaction_id: transaction?.id || null,
                amount: Number(amount),
                description: description || 'Deposit',
                previous_bankroll: previousBankroll,
                new_bankroll: newBankroll
            }
        });
        res.json({ success: true, bankroll: newBankroll });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/bankroll/withdraw - Withdraw funds
app.post('/api/bankroll/withdraw', (req, res) => {
    try {
        const userId = getRequestUserId(req);
        const { amount, description } = req.body;
        const previousBankroll = bankroll.getBankroll(userId);
        const transaction = bankroll.withdraw(amount, description, userId);
        const newBankroll = bankroll.getBankroll(userId);
        writeAuditLog('BANKROLL_WITHDRAWAL', `Withdrew $${Number(amount).toFixed(2)}`, {
            userId,
            entityType: 'transaction',
            entityId: transaction?.id || null,
            payload: {
                transaction_id: transaction?.id || null,
                amount: Number(amount),
                description: description || 'Withdrawal',
                previous_bankroll: previousBankroll,
                new_bankroll: newBankroll
            }
        });
        res.json({ success: true, bankroll: newBankroll });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ============ STATS API ============

// GET /api/stats - Get betting statistics
app.get('/api/stats', (req, res) => {
    try {
        const { start_date, end_date, state, track } = req.query;
        const stats = bankroll.getFilteredStats(start_date, end_date, state, track, getRequestUserId(req));
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/stats/history - Get bankroll history
app.get('/api/stats/history', (req, res) => {
    try {
        const periodRange = req.query.period ? bankroll.getPeriodRange(req.query.period) : null;
        const days = periodRange
            ? (periodRange.startDate ? Math.max(1, Math.ceil((new Date(periodRange.endDate) - new Date(periodRange.startDate)) / 86400000) + 1) : 3650)
            : (parseInt(req.query.days) || 30);
        const history = bankroll.getHistory(days, getRequestUserId(req));
        res.json(history);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ TRANSACTIONS API ============

// GET /api/transactions - Get all transactions
app.get('/api/transactions', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        res.json(db.transactions.getAll(limit, getRequestUserId(req)));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ IMPORT API ============

// POST /api/import/csv - Import form guide from CSV
app.post('/api/import/csv', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const csvData = req.file.buffer.toString('utf8');
        const records = parse(csvData, {
            columns: true,
            skip_empty_lines: true,
            trim: true
        });
        
        if (records.length === 0) {
            return res.status(400).json({ error: 'CSV file is empty' });
        }
        
        const imported = importFormGuideData(records, 'csv_import');
        writeAuditLog('FORM_GUIDE_IMPORTED', `CSV import completed: ${imported.races} races, ${imported.runners} runners`, {
            entityType: 'import',
            payload: importAuditPayload('csv_import', imported, {
                filename: req.file.originalname || null,
                record_count: records.length
            })
        });
        res.json(imported);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/import/json - Import form guide from JSON
app.post('/api/import/json', (req, res) => {
    try {
        const data = req.body;
        
        if (!data || !Array.isArray(data)) {
            return res.status(400).json({ error: 'Invalid JSON format. Expected array of records.' });
        }
        
        const imported = importFormGuideData(data, 'json_import');
        writeAuditLog('FORM_GUIDE_IMPORTED', `JSON import completed: ${imported.races} races, ${imported.runners} runners`, {
            entityType: 'import',
            payload: importAuditPayload('json_import', imported, {
                record_count: data.length
            })
        });
        res.json(imported);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/import/paste - Import form guide from pasted markdown/text
app.post('/api/import/paste', async (req, res) => {
    try {
        const userId = getRequestUserId(req);
        const { text } = req.body;

        if (!text || !String(text).trim()) {
            return res.status(400).json({ error: 'Paste data is required' });
        }

        const tracksByState = fs.existsSync(TRACKS_PATH)
            ? JSON.parse(fs.readFileSync(TRACKS_PATH, 'utf8'))
            : normalizeTrackMap();

        const parsed = parsePastedFormGuide(text, tracksByState);
        if (parsed.records.length > 0) {
            const imported = importFormGuideData(parsed.records, 'paste_import');

            const meeting = db.meetings.getByDateTrack(parsed.meeting.date, parsed.meeting.state, parsed.meeting.track);
            const race = meeting ? db.races.getByMeetingAndNumber(meeting.id, parseInt(parsed.race.race_no, 10)) : null;
            const analysis = race ? await selector.selectForRace(race.id, race, userId) : null;

            db.settings.set('last_state', parsed.meeting.state, userId);
            db.settings.set('last_track', parsed.meeting.track, userId);
            db.settings.set('last_date', parsed.meeting.date, userId);

            writeAuditLog('PASTE_FORM_IMPORTED', `Pasted form guide imported for ${parsed.meeting.track} R${parsed.race.race_no}`, {
                userId,
                entityType: 'race',
                entityId: race?.id || null,
                payload: importAuditPayload('paste_import', imported, {
                    text_length: String(text).length,
                    meeting: parsed.meeting,
                    race: parsed.race,
                    race_id: race?.id || null,
                    analysis_generated: Boolean(analysis)
                })
            });

            return res.json({
                ...imported,
                parsed: {
                    meeting: parsed.meeting,
                    race: parsed.race,
                    resultsPlacings: parsed.resultsPlacings || []
                },
                analysisRaceId: race?.id || null,
                analysis
            });
        }

        if (parsed.resultsPlacings?.length > 0) {
            const meetingDate = parsed.meeting?.date || new Date().toISOString().split('T')[0];
            const meetingState = parsed.meeting?.state || 'VIC';
            const meetingTrack = parsed.meeting?.track || 'Unknown';
            const raceNo = parseInt(parsed.race?.race_no, 10);

            let meeting = db.meetings.getByDateTrack(meetingDate, meetingState, meetingTrack);
            const createdMeeting = !meeting;
            if (!meeting) {
                meeting = db.meetings.create({
                    date: meetingDate,
                    state: meetingState,
                    track: meetingTrack,
                    source: 'paste_results'
                });
            }

            let race = Number.isFinite(raceNo) ? db.races.getByMeetingAndNumber(meeting.id, raceNo) : null;
            const createdRace = !race;
            if (!race) {
                race = db.races.create(meeting.id, {
                    race_no: raceNo || 1,
                    race_name: parsed.race?.race_name || `Race ${raceNo || 1}`,
                    start_time: null,
                    distance: parseInt(parsed.race?.distance, 10) || null,
                    track_condition: null,
                    race_class: parsed.race?.race_class || null,
                    prize_money: null
                });
            }

            // Upsert any runners present in placings so the race is usable for analysis.
            for (const placing of parsed.resultsPlacings) {
                db.runners.create(race.id, {
                    saddle_no: parseInt(placing.saddle_no, 10),
                    horse_name: placing.horse_name,
                    barrier: null,
                    weight: null,
                    jockey: null,
                    trainer: null,
                    form_string: null,
                    career_wins: 0,
                    career_places: 0,
                    career_starts: 0,
                    track_wins: 0,
                    track_starts: 0,
                    distance_wins: 0,
                    distance_starts: 0,
                    rating: null,
                    days_since_last_run: null,
                    odds_win: null,
                    odds_place: null
                });
            }

            const resultOrder = parsed.resultsPlacings
                .sort((a, b) => a.position - b.position)
                .slice(0, 3)
                .map(item => item.saddle_no);

            const settlement = awaitRaceSettlement(race.id, resultOrder, userId);
            const analysis = await selector.selectForRace(race.id, race, userId);

            db.settings.set('last_state', meetingState, userId);
            db.settings.set('last_track', meetingTrack, userId);
            db.settings.set('last_date', meetingDate, userId);

            writeAuditLog('PASTE_RESULTS_IMPORTED', `Pasted results imported for ${meetingTrack} R${race.race_no}`, {
                userId,
                entityType: 'race',
                entityId: race.id,
                payload: {
                    source: 'paste_results',
                    text_length: String(text).length,
                    meeting: {
                        date: meetingDate,
                        state: meetingState,
                        track: meetingTrack
                    },
                    race_id: race.id,
                    race_no: race.race_no,
                    race_name: race.race_name,
                    created_meeting: createdMeeting,
                    created_race: createdRace,
                    placings: resultOrder,
                    settled_count: settlement?.settled?.length || 0,
                    analysis_generated: Boolean(analysis)
                }
            });

            return res.json({
                success: true,
                message: createdRace
                    ? 'Parsed results, created race, and completed analysis'
                    : 'Parsed results and updated existing race analysis',
                meetings: createdMeeting ? 1 : 0,
                races: createdRace ? 1 : 0,
                runners: parsed.resultsPlacings.length,
                parsed: {
                    meeting: {
                        date: meetingDate,
                        state: meetingState,
                        track: meetingTrack
                    },
                    race: parsed.race,
                    resultsPlacings: parsed.resultsPlacings
                },
                analysisRaceId: race.id,
                analysis,
                settlement
            });
        }

        const imported = importFormGuideData(parsed.records, 'paste_import');

        db.settings.set('last_state', parsed.meeting.state, userId);
        db.settings.set('last_track', parsed.meeting.track, userId);
        db.settings.set('last_date', parsed.meeting.date, userId);

        writeAuditLog('PASTE_FORM_IMPORTED', `Pasted form guide imported for ${parsed.meeting.track}`, {
            userId,
            entityType: 'import',
            payload: importAuditPayload('paste_import', imported, {
                text_length: String(text).length,
                meeting: parsed.meeting,
                race: parsed.race
            })
        });

        res.json({
            ...imported,
            parsed: {
                meeting: parsed.meeting,
                race: parsed.race
            }
        });
    } catch (err) {
        writeAuditLog('PASTE_IMPORT_FAILED', 'Pasted import failed', {
            userId: getRequestUserId(req),
            entityType: 'import',
            payload: {
                text_length: String(req.body?.text || '').length,
                error: err.message
            }
        });
        res.status(400).json({ error: err.message });
    }
});

function awaitRaceSettlement(raceId, resultOrder, userId) {
    const pendingBets = db.bets.getPendingByRace(raceId, userId);
    if (pendingBets.length === 0) {
        return {
            success: true,
            message: 'No pending bets found for this race',
            settled: [],
            bankroll: bankroll.getBankroll(userId)
        };
    }

    const settled = [];
    for (const bet of pendingBets) {
        let result = 'lost';
        let position = null;

        if (bet.saddle_no === resultOrder[0]) {
            result = 'won';
            position = 1;
        } else if (resultOrder[1] && bet.saddle_no === resultOrder[1]) {
            result = 'placed';
            position = 2;
        } else if (resultOrder[2] && bet.saddle_no === resultOrder[2]) {
            result = 'placed';
            position = 3;
        }

        const settlement = bankroll.settleBet(bet.id, result, position, userId);
        settled.push({
            bet_id: bet.id,
            horse_name: bet.horse_name,
            saddle_no: bet.saddle_no,
            result,
            position,
            profit: settlement.profit
        });
    }

    return {
        success: true,
        settled,
        bankroll: bankroll.getBankroll(userId)
    };
}

// POST /api/import/url - Attempt to import from URL
app.post('/api/import/url', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }
        
        // Try sportsbook adapter first
        let result = await sportsbookAdapter.parseWithAdapter(url);
        
        if (!result.success) {
            // Fall back to generic HTML parser
            result = await genericHtml.parseUrl(url);
        }

        writeAuditLog('URL_IMPORT_ATTEMPTED', result.success ? 'URL import parsed successfully' : 'URL import attempt completed without importable data', {
            entityType: 'import',
            payload: {
                url,
                success: Boolean(result.success),
                parser: result.parser || result.source || null,
                error: result.error || null
            }
        });
        
        res.json(result);
    } catch (err) {
        writeAuditLog('URL_IMPORT_FAILED', 'URL import failed', {
            entityType: 'import',
            payload: {
                url: req.body?.url || null,
                error: err.message
            }
        });
        res.status(500).json({ error: err.message });
    }
});

// Helper function to import form guide data
function importFormGuideData(records, source = 'manual_import') {
    const meetingsCreated = new Set();
    const racesCreated = new Set();
    let runnersCreated = 0;
    
    for (const record of records) {
        // Create/get meeting
        const meetingKey = `${record.date}-${record.state}-${record.track}`;
        let meeting;
        
        if (!meetingsCreated.has(meetingKey)) {
            meeting = db.meetings.create({
                date: record.date,
                state: record.state,
                track: record.track,
                source
            });
            meetingsCreated.add(meetingKey);
        } else {
            meeting = db.meetings.getByDateTrack(record.date, record.state, record.track);
        }
        
        // Create/get race
        const raceKey = `${meeting.id}-${record.race_no}`;
        let race;
        
        if (!racesCreated.has(raceKey)) {
            race = db.races.create(meeting.id, {
                race_no: parseInt(record.race_no),
                race_name: record.race_name,
                start_time: record.start_time,
                distance: parseInt(record.distance) || null,
                track_condition: record.track_condition,
                race_class: record.race_class,
                prize_money: parseInt(record.prize_money) || null
            });
            racesCreated.add(raceKey);
        } else {
            race = db.races.getByMeetingAndNumber(meeting.id, parseInt(record.race_no));
        }
        
        // Create runner
        db.runners.create(race.id, {
            saddle_no: parseInt(record.saddle_no),
            horse_name: record.horse_name,
            barrier: parseInt(record.barrier) || null,
            weight: parseFloat(record.weight) || null,
            jockey: record.jockey,
            trainer: record.trainer,
            form_string: record.form_string,
            career_wins: parseInt(record.career_wins) || 0,
            career_places: parseInt(record.career_places) || 0,
            career_starts: parseInt(record.career_starts) || 0,
            track_wins: parseInt(record.track_wins) || 0,
            track_starts: parseInt(record.track_starts) || 0,
            distance_wins: parseInt(record.distance_wins) || 0,
            distance_starts: parseInt(record.distance_starts) || 0,
            rating: parseFloat(record.rating) || null,
            days_since_last_run: parseInt(record.days_since_last_run) || null,
            odds_win: parseFloat(record.odds_win) || null,
            odds_place: parseFloat(record.odds_place) || null
        });
        
        runnersCreated++;
    }
    
    return {
        success: true,
        meetings: meetingsCreated.size,
        races: racesCreated.size,
        runners: runnersCreated
    };
}

// ============ EXPORT API ============

// GET /api/export/transactions - Export transactions as CSV
app.get('/api/export/transactions', (req, res) => {
    try {
        const userId = getRequestUserId(req);
        const period = req.query.period || 'all_time';
        const csv = bankroll.exportTransactionsCSV(userId, period);
        writeAuditLog('EXPORT_DOWNLOADED', 'Transactions CSV exported', {
            userId,
            entityType: 'export',
            payload: {
                export_type: 'transactions_csv',
                period,
                transaction_count: db.transactions.getAll(10000, userId).length
            }
        });
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=transactions-${period}.csv`);
        res.send(csv);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/export/bets - Export bets as CSV
app.get('/api/export/bets', (req, res) => {
    try {
        const userId = getRequestUserId(req);
        const period = req.query.period || 'all_time';
        const csv = bankroll.exportBetsCSV(userId, period);
        writeAuditLog('EXPORT_DOWNLOADED', 'Bets CSV exported', {
            userId,
            entityType: 'export',
            payload: {
                export_type: 'bets_csv',
                period,
                bet_count: db.bets.getAll(10000, userId).length
            }
        });
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=bets-${period}.csv`);
        res.send(csv);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ BACKUP API ============

// GET /api/backup/db - Download SQLite database
app.get('/api/backup/db', (req, res) => {
    try {
        const dbPath = path.join(__dirname, 'data', 'racing.db');
        if (fs.existsSync(dbPath)) {
            writeAuditLog('BACKUP_DOWNLOADED', 'SQLite database backup downloaded', {
                entityType: 'backup',
                payload: {
                    backup_type: 'sqlite_db',
                    filename: 'racing_backup.db'
                }
            });
            res.download(dbPath, 'racing_backup.db');
        } else {
            res.status(404).json({ error: 'Database file not found' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/backup/json - Export all data as JSON
app.get('/api/backup/json', (req, res) => {
    try {
        const backup = {
            exported_at: new Date().toISOString(),
            settings: db.settings.getAll(),
            meetings: db.meetings.getAll(),
            transactions: db.transactions.getAll(10000),
            bets: db.bets.getAll(10000)
        };

        writeAuditLog('BACKUP_DOWNLOADED', 'JSON backup downloaded', {
            entityType: 'backup',
            payload: {
                backup_type: 'json',
                filename: 'racing_backup.json',
                meeting_count: backup.meetings.length,
                transaction_count: backup.transactions.length,
                bet_count: backup.bets.length
            }
        });
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename=racing_backup.json');
        res.json(backup);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/backup/restore - Restore from JSON backup
app.post('/api/backup/restore', (req, res) => {
    try {
        const backup = req.body;
        
        if (!backup || !backup.settings) {
            return res.status(400).json({ error: 'Invalid backup format' });
        }
        
        // Restore settings
        if (backup.settings) {
            db.settings.setMultiple(backup.settings);
        }

        writeAuditLog('BACKUP_RESTORED', 'Backup settings restored', {
            entityType: 'backup',
            payload: {
                restored_settings: Object.keys(backup.settings || {}),
                backup_exported_at: backup.exported_at || null
            }
        });
        
        res.json({ 
            success: true, 
            message: 'Settings restored. Note: Meetings, races, and runners must be re-imported via CSV/JSON.'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ SPA FALLBACK ============

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server with async init
async function startServer() {
    await ensureDatabaseReady();
    startRacingImportCron({
        enabled: process.env.ENABLE_RACING_CRON,
        importTime: process.env.RACING_IMPORT_TIME
    });
    
    app.listen(PORT, () => {
        console.log(`
╔════════════════════════════════════════════════════════╗
║     Horse Racing Selection & Bankroll Tracker          ║
║     Server running at http://localhost:${PORT}            ║
╚════════════════════════════════════════════════════════╝

⚠️  DISCLAIMER: Gambling involves risk. This app provides 
    estimates, not guarantees. Please gamble responsibly.
        `);
    });
}

startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});

module.exports = app;
