const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'racing.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

let db = null;
let SQL = null;
let isInitialized = false;

// Initialize database synchronously after first async init
async function initDB() {
    if (isInitialized) return db;
    
    SQL = await initSqlJs();
    
    if (fs.existsSync(DB_PATH)) {
        const buffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(buffer);
    } else {
        db = new SQL.Database();
    }
    
    isInitialized = true;
    return db;
}

// Save database to file
function saveDB() {
    if (!db) return;
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
}

// Initialize schema
async function initSchema() {
    await initDB();
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    // Split by semicolons and execute each statement
    const statements = schema.split(';').filter(s => s.trim());
    for (const stmt of statements) {
        if (stmt.trim()) {
            try {
                db.run(stmt);
            } catch (e) {
                // Ignore errors for IF NOT EXISTS statements
                if (!e.message.includes('already exists')) {
                    console.warn('Schema warning:', e.message);
                }
            }
        }
    }
    saveDB();
    console.log('Database schema initialized');
}

// Helper to run query and get all results
function all(sql, params = []) {
    if (!db) throw new Error('Database not initialized. Call initDB() first.');
    try {
        const stmt = db.prepare(sql);
        if (params.length > 0) stmt.bind(params);
        const results = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
    } catch (e) {
        console.error('SQL Error:', e.message, sql);
        return [];
    }
}

// Helper to get single row
function get(sql, params = []) {
    const results = all(sql, params);
    return results[0] || null;
}

// Helper to run statement (insert/update/delete)
function run(sql, params = []) {
    if (!db) throw new Error('Database not initialized. Call initDB() first.');
    try {
        db.run(sql, params);
        saveDB();
        const lastId = db.exec("SELECT last_insert_rowid() as id");
        return { lastInsertRowid: lastId[0]?.values[0]?.[0] || 0 };
    } catch (e) {
        console.error('SQL Error:', e.message, sql);
        throw e;
    }
}

// Settings operations
const settings = {
    get(key) {
        const row = get('SELECT value FROM settings WHERE key = ?', [key]);
        return row ? row.value : null;
    },
    getAll() {
        const rows = all('SELECT key, value FROM settings');
        return rows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {});
    },
    set(key, value) {
        run(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`, [key, String(value)]);
    },
    setMultiple(obj) {
        for (const [key, value] of Object.entries(obj)) {
            this.set(key, value);
        }
    }
};

// Meetings operations
const meetings = {
    create(data) {
        run(`INSERT OR REPLACE INTO meetings (date, state, track, source, weather, rail_position, created_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
            [data.date, data.state, data.track, data.source || 'manual', data.weather || null, data.rail_position || null]);
        return this.getByDateTrack(data.date, data.state, data.track);
    },
    getById(id) {
        return get('SELECT * FROM meetings WHERE id = ?', [id]);
    },
    getByDateTrack(date, state, track) {
        return get('SELECT * FROM meetings WHERE date = ? AND state = ? AND track = ?', [date, state, track]);
    },
    updateById(id, data) {
        run(`UPDATE meetings
             SET date = ?, state = ?, track = ?, weather = ?, rail_position = ?
             WHERE id = ?`, [
            data.date,
            data.state,
            data.track,
            data.weather || null,
            data.rail_position || null,
            id
        ]);
        return this.getById(id);
    },
    getByDate(date) {
        return all('SELECT * FROM meetings WHERE date = ? ORDER BY state, track', [date]);
    },
    getAll() {
        return all('SELECT * FROM meetings ORDER BY date DESC, state, track');
    },
    deleteIfEmpty(id) {
        const count = get('SELECT COUNT(*) as count FROM races WHERE meeting_id = ?', [id])?.count || 0;
        if (count > 0) {
            return false;
        }

        run('DELETE FROM meetings WHERE id = ?', [id]);
        return true;
    },
    deleteByDateTrack(date, state, track) {
        const meeting = this.getByDateTrack(date, state, track);
        if (!meeting) {
            return { deleted: false, message: 'Meeting not found' };
        }

        const racesForMeeting = all('SELECT id FROM races WHERE meeting_id = ?', [meeting.id]);
        const raceIds = racesForMeeting.map(r => r.id);

        let selectionIds = [];
        let runnerCount = 0;

        if (raceIds.length > 0) {
            const racePlaceholders = raceIds.map(() => '?').join(', ');

            const runnersForRaces = all(
                `SELECT id FROM runners WHERE race_id IN (${racePlaceholders})`,
                raceIds
            );
            runnerCount = runnersForRaces.length;

            const selectionsForRaces = all(
                `SELECT id FROM selections WHERE race_id IN (${racePlaceholders})`,
                raceIds
            );
            selectionIds = selectionsForRaces.map(s => s.id);
        }

        let betCount = 0;
        if (selectionIds.length > 0) {
            const selectionPlaceholders = selectionIds.map(() => '?').join(', ');
            const betsForSelections = all(
                `SELECT id FROM bets WHERE selection_id IN (${selectionPlaceholders})`,
                selectionIds
            );
            const betIds = betsForSelections.map(b => b.id);
            betCount = betIds.length;

            if (betIds.length > 0) {
                const betPlaceholders = betIds.map(() => '?').join(', ');
                run(`UPDATE transactions SET bet_id = NULL WHERE bet_id IN (${betPlaceholders})`, betIds);
                run(`DELETE FROM bets WHERE id IN (${betPlaceholders})`, betIds);
            }

            run(`DELETE FROM selections WHERE id IN (${selectionPlaceholders})`, selectionIds);
        }

        if (raceIds.length > 0) {
            const racePlaceholders = raceIds.map(() => '?').join(', ');
            run(`DELETE FROM runners WHERE race_id IN (${racePlaceholders})`, raceIds);
            run(`DELETE FROM races WHERE id IN (${racePlaceholders})`, raceIds);
        }

        run('DELETE FROM meetings WHERE id = ?', [meeting.id]);

        return {
            deleted: true,
            meeting,
            counts: {
                races: raceIds.length,
                runners: runnerCount,
                selections: selectionIds.length,
                bets: betCount
            }
        };
    }
};

// Races operations
const races = {
    create(meetingId, data) {
        // Check if exists first
        const existing = this.getByMeetingAndNumber(meetingId, data.race_no);
        if (existing) {
            run(`UPDATE races SET race_name = ?, start_time = ?, distance = ?, track_condition = ?, 
                 race_class = ?, prize_money = ? WHERE id = ?`,
                [data.race_name || null, data.start_time || null, data.distance || null,
                 data.track_condition || null, data.race_class || null, data.prize_money || null, existing.id]);
            return this.getById(existing.id);
        }
        run(`INSERT INTO races (meeting_id, race_no, race_name, start_time, distance, track_condition, race_class, prize_money)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [meetingId, data.race_no, data.race_name || null, data.start_time || null, data.distance || null,
             data.track_condition || null, data.race_class || null, data.prize_money || null]);
        return this.getByMeetingAndNumber(meetingId, data.race_no);
    },
    getById(id) {
        return get('SELECT * FROM races WHERE id = ?', [id]);
    },
    getByMeetingAndNumber(meetingId, raceNo) {
        return get('SELECT * FROM races WHERE meeting_id = ? AND race_no = ?', [meetingId, raceNo]);
    },
    getByMeeting(meetingId) {
        return all('SELECT * FROM races WHERE meeting_id = ? ORDER BY race_no', [meetingId]);
    },
    moveToMeeting(id, meetingId) {
        run('UPDATE races SET meeting_id = ? WHERE id = ?', [meetingId, id]);
        return this.getById(id);
    },
    updateById(id, data) {
        run(`UPDATE races
             SET race_no = ?, race_name = ?, start_time = ?, distance = ?, track_condition = ?, race_class = ?, prize_money = ?
             WHERE id = ?`, [
            data.race_no,
            data.race_name || null,
            data.start_time || null,
            data.distance || null,
            data.track_condition || null,
            data.race_class || null,
            data.prize_money || null,
            id
        ]);
        return this.getById(id);
    },
    deleteById(id) {
        const race = this.getById(id);
        if (!race) {
            return { deleted: false, message: 'Race not found' };
        }

        const meeting = meetings.getById(race.meeting_id);
        const runnersForRace = all('SELECT id FROM runners WHERE race_id = ?', [id]);
        const selectionsForRace = all('SELECT id FROM selections WHERE race_id = ?', [id]);
        const selectionIds = selectionsForRace.map(s => s.id);

        let betCount = 0;
        if (selectionIds.length > 0) {
            const selectionPlaceholders = selectionIds.map(() => '?').join(', ');
            const betsForSelections = all(
                `SELECT id FROM bets WHERE selection_id IN (${selectionPlaceholders})`,
                selectionIds
            );
            const betIds = betsForSelections.map(b => b.id);
            betCount = betIds.length;

            if (betIds.length > 0) {
                const betPlaceholders = betIds.map(() => '?').join(', ');
                run(`UPDATE transactions SET bet_id = NULL WHERE bet_id IN (${betPlaceholders})`, betIds);
                run(`DELETE FROM bets WHERE id IN (${betPlaceholders})`, betIds);
            }

            run(`DELETE FROM selections WHERE id IN (${selectionPlaceholders})`, selectionIds);
        }

        run('DELETE FROM race_results WHERE race_id = ?', [id]);
        run('DELETE FROM runners WHERE race_id = ?', [id]);
        run('DELETE FROM races WHERE id = ?', [id]);

        const removedEmptyMeeting = meetings.deleteIfEmpty(race.meeting_id);

        return {
            deleted: true,
            race,
            meeting,
            removed_empty_meeting: removedEmptyMeeting,
            counts: {
                races: 1,
                runners: runnersForRace.length,
                selections: selectionIds.length,
                bets: betCount
            }
        };
    },
    getWithDetails(raceId) {
        const race = this.getById(raceId);
        if (!race) return null;
        const meeting = meetings.getById(race.meeting_id);
        const runnersData = runners.getByRace(raceId);
        return { ...race, meeting, runners: runnersData };
    }
};

// Runners operations
const runners = {
    create(raceId, data) {
        const existing = this.getByRaceAndSaddle(raceId, data.saddle_no);
        if (existing) {
            run(`UPDATE runners SET horse_name = ?, barrier = ?, weight = ?, jockey = ?, trainer = ?,
                 form_string = ?, career_wins = ?, career_places = ?, career_starts = ?,
                 track_wins = ?, track_starts = ?, distance_wins = ?, distance_starts = ?,
                 rating = ?, days_since_last_run = ?, scratched = ?, odds_win = ?, odds_place = ?
                 WHERE id = ?`,
                [data.horse_name, data.barrier || null, data.weight || null, data.jockey || null, data.trainer || null,
                 data.form_string || null, data.career_wins || 0, data.career_places || 0, data.career_starts || 0,
                 data.track_wins || 0, data.track_starts || 0, data.distance_wins || 0, data.distance_starts || 0,
                 data.rating || null, data.days_since_last_run || null, data.scratched ? 1 : 0,
                 data.odds_win || null, data.odds_place || null, existing.id]);
            return this.getById(existing.id);
        }
        run(`INSERT INTO runners (race_id, saddle_no, horse_name, barrier, weight, jockey, trainer,
             form_string, career_wins, career_places, career_starts, track_wins, track_starts,
             distance_wins, distance_starts, rating, days_since_last_run, scratched, odds_win, odds_place)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [raceId, data.saddle_no, data.horse_name, data.barrier || null, data.weight || null,
             data.jockey || null, data.trainer || null, data.form_string || null,
             data.career_wins || 0, data.career_places || 0, data.career_starts || 0,
             data.track_wins || 0, data.track_starts || 0, data.distance_wins || 0, data.distance_starts || 0,
             data.rating || null, data.days_since_last_run || null, data.scratched ? 1 : 0,
             data.odds_win || null, data.odds_place || null]);
        return this.getByRaceAndSaddle(raceId, data.saddle_no);
    },
    getById(id) {
        return get('SELECT * FROM runners WHERE id = ?', [id]);
    },
    getByRace(raceId) {
        return all('SELECT * FROM runners WHERE race_id = ? ORDER BY saddle_no', [raceId]);
    },
    getByRaceAndSaddle(raceId, saddleNo) {
        return get('SELECT * FROM runners WHERE race_id = ? AND saddle_no = ?', [raceId, saddleNo]);
    },
    updateOdds(runnerId, oddsWin, oddsPlace) {
        run('UPDATE runners SET odds_win = ?, odds_place = ? WHERE id = ?', [oddsWin, oddsPlace, runnerId]);
    },
    scratch(runnerId) {
        run('UPDATE runners SET scratched = 1 WHERE id = ?', [runnerId]);
    }
};

// Selections operations
const selections = {
    create(data) {
        const result = run(`INSERT INTO selections (race_id, runner_id, model_version, score, prob_win_est, prob_place_est,
             odds_win, odds_place, ev_win, ev_place, recommendation_status, explanation_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [data.race_id, data.runner_id, data.model_version || 'v1', data.score,
             data.prob_win_est, data.prob_place_est, data.odds_win, data.odds_place,
             data.ev_win, data.ev_place, data.recommendation_status,
             typeof data.explanation === 'object' ? JSON.stringify(data.explanation) : (data.explanation_json || '{}')]);
        return this.getById(result.lastInsertRowid);
    },
    getById(id) {
        return get('SELECT * FROM selections WHERE id = ?', [id]);
    },
    getByRace(raceId) {
        return all(`SELECT s.*, r.horse_name, r.saddle_no, r.jockey, r.barrier
            FROM selections s JOIN runners r ON s.runner_id = r.id
            WHERE s.race_id = ? ORDER BY s.score DESC`, [raceId]);
    },
    getRecommendation(raceId) {
        return get(`SELECT s.*, r.horse_name, r.saddle_no, r.jockey, r.barrier
            FROM selections s JOIN runners r ON s.runner_id = r.id
            WHERE s.race_id = ? AND s.recommendation_status = 'bet'
            ORDER BY s.score DESC LIMIT 1`, [raceId]);
    },
    deleteByRace(raceId) {
        run('DELETE FROM selections WHERE race_id = ?', [raceId]);
    }
};

// Bets operations
const bets = {
    create(data) {
        const stakeWin = data.stake_win || 0;
        const stakePlace = data.stake_place || 0;
        const oddsWin = data.odds_win ?? null;
        const oddsPlace = data.odds_place ?? null;

        run(`INSERT INTO bets (selection_id, stake_win, stake_place, odds_win, odds_place)
            VALUES (?, ?, ?, ?, ?)`,
            [data.selection_id, stakeWin, stakePlace, oddsWin, oddsPlace]);

        return get(`SELECT * FROM bets
            WHERE selection_id = ? AND stake_win = ? AND stake_place = ?
              AND (odds_win = ? OR (odds_win IS NULL AND ? IS NULL))
              AND (odds_place = ? OR (odds_place IS NULL AND ? IS NULL))
            ORDER BY id DESC LIMIT 1`,
            [data.selection_id, stakeWin, stakePlace, oddsWin, oddsWin, oddsPlace, oddsPlace]);
    },
    getById(id) {
        return get('SELECT * FROM bets WHERE id = ?', [id]);
    },
    getDetailedById(id) {
        return get(`SELECT b.*, s.race_id, r.horse_name, r.saddle_no, rc.race_no, rc.race_name, m.track, m.state, m.date
            FROM bets b
            JOIN selections s ON b.selection_id = s.id
            JOIN runners r ON s.runner_id = r.id
            JOIN races rc ON s.race_id = rc.id
            JOIN meetings m ON rc.meeting_id = m.id
            WHERE b.id = ?`, [id]);
    },
    getPending() {
        return all(`SELECT b.*, s.race_id, r.horse_name, r.saddle_no, rc.race_no, rc.race_name, m.track, m.date
            FROM bets b
            JOIN selections s ON b.selection_id = s.id
            JOIN runners r ON s.runner_id = r.id
            JOIN races rc ON s.race_id = rc.id
            JOIN meetings m ON rc.meeting_id = m.id
            WHERE b.status = 'pending' ORDER BY m.date DESC, rc.race_no`);
    },
    getPendingByRace(raceId) {
        return all(`SELECT b.*, s.race_id, r.horse_name, r.saddle_no, rc.race_no, rc.race_name, m.track, m.date
            FROM bets b
            JOIN selections s ON b.selection_id = s.id
            JOIN runners r ON s.runner_id = r.id
            JOIN races rc ON s.race_id = rc.id
            JOIN meetings m ON rc.meeting_id = m.id
            WHERE b.status = 'pending' AND s.race_id = ? ORDER BY b.placed_at DESC`, [raceId]);
    },
    getByRace(raceId) {
        return all(`SELECT b.*, s.race_id, r.horse_name, r.saddle_no, rc.race_no, rc.race_name, m.track, m.date
            FROM bets b
            JOIN selections s ON b.selection_id = s.id
            JOIN runners r ON s.runner_id = r.id
            JOIN races rc ON s.race_id = rc.id
            JOIN meetings m ON rc.meeting_id = m.id
            WHERE s.race_id = ? ORDER BY b.placed_at DESC`, [raceId]);
    },
    getAll(limit = 100) {
        return all(`SELECT b.*, s.race_id, r.horse_name, r.saddle_no, rc.race_no, rc.race_name, m.track, m.date
            FROM bets b
            JOIN selections s ON b.selection_id = s.id
            JOIN runners r ON s.runner_id = r.id
            JOIN races rc ON s.race_id = rc.id
            JOIN meetings m ON rc.meeting_id = m.id
            ORDER BY b.placed_at DESC LIMIT ?`, [limit]);
    },
    settle(betId, status, position, payoutWin, payoutPlace) {
        run(`UPDATE bets SET status = ?, result_position = ?, payout_win = ?, payout_place = ?, settled_at = datetime('now')
            WHERE id = ?`, [status, position, payoutWin, payoutPlace, betId]);
        return this.getById(betId);
    }
};

// Race results operations
const raceResults = {
    upsert(raceId, firstSaddle = null, secondSaddle = null, thirdSaddle = null) {
        run(`INSERT OR REPLACE INTO race_results (race_id, first_saddle, second_saddle, third_saddle, settled_at)
            VALUES (?, ?, ?, ?, datetime('now'))`, [raceId, firstSaddle, secondSaddle, thirdSaddle]);
        return this.getByRace(raceId);
    },
    getByRace(raceId) {
        return get('SELECT * FROM race_results WHERE race_id = ?', [raceId]);
    }
};

// Audit log operations
const auditLogs = {
    create(data) {
        const result = run(`INSERT INTO audit_logs (event_type, message, entity_type, entity_id, payload_json)
            VALUES (?, ?, ?, ?, ?)`, [
            data.event_type,
            data.message,
            data.entity_type || null,
            data.entity_id || null,
            data.payload_json ? JSON.stringify(data.payload_json) : null
        ]);
        return this.getById(result.lastInsertRowid);
    },
    getById(id) {
        return get('SELECT * FROM audit_logs WHERE id = ?', [id]);
    },
    getAll(limit = 500, eventType = null) {
        if (eventType) {
            return all('SELECT * FROM audit_logs WHERE event_type = ? ORDER BY created_at DESC, id DESC LIMIT ?', [eventType, limit]);
        }
        return all('SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ?', [limit]);
    }
};

// Transactions operations
const transactions = {
    create(data) {
        const result = run(`INSERT INTO transactions (type, amount, bet_id, description) VALUES (?, ?, ?, ?)`,
            [data.type, data.amount, data.bet_id || null, data.description || null]);
        return this.getById(result.lastInsertRowid);
    },
    getById(id) {
        return get('SELECT * FROM transactions WHERE id = ?', [id]);
    },
    getAll(limit = 500) {
        return all('SELECT * FROM transactions ORDER BY created_at DESC LIMIT ?', [limit]);
    },
    getBankroll() {
        const result = get('SELECT COALESCE(SUM(amount), 0) as bankroll FROM transactions');
        return result?.bankroll || 0;
    },
    getDailyLoss(date) {
        const result = get(`SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0) as loss
            FROM transactions WHERE date(created_at) = ?`, [date]);
        return Math.abs(result?.loss || 0);
    }
};

// Stats operations
const stats = {
    getBettingStats(startDate = null, endDate = null, state = null, track = null) {
        let sql = `SELECT COUNT(*) as total_bets,
                SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN status = 'placed' THEN 1 ELSE 0 END) as places,
                SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) as losses,
                SUM(stake_win + stake_place) as total_staked,
                SUM(payout_win + payout_place) as total_returned,
                SUM(payout_win + payout_place - stake_win - stake_place) as profit
            FROM bets b
            JOIN selections s ON b.selection_id = s.id
            JOIN races r ON s.race_id = r.id
            JOIN meetings m ON r.meeting_id = m.id
            WHERE b.status != 'pending'`;
        const params = [];
        if (startDate) { sql += ' AND m.date >= ?'; params.push(startDate); }
        if (endDate) { sql += ' AND m.date <= ?'; params.push(endDate); }
        if (state) { sql += ' AND m.state = ?'; params.push(state); }
        if (track) { sql += ' AND m.track = ?'; params.push(track); }
        return get(sql, params) || { total_bets: 0, wins: 0, places: 0, losses: 0, total_staked: 0, total_returned: 0, profit: 0 };
    },
    getBankrollHistory(days = 30) {
        // sql.js doesn't support window functions well, use a simpler approach
        const txns = all(`SELECT date(created_at) as date, amount, type FROM transactions
            WHERE created_at >= date('now', '-' || ? || ' days') ORDER BY created_at`, [days]);
        let running = 0;
        return txns.map(t => {
            running += t.amount;
            return { ...t, running_balance: running };
        });
    },
    getDrawdown() {
        const history = this.getBankrollHistory(365);
        if (history.length === 0) return { max_drawdown: 0, current_drawdown: 0, peak: 0 };
        let peak = history[0]?.running_balance || 0;
        let maxDrawdown = 0;
        for (const row of history) {
            if (row.running_balance > peak) peak = row.running_balance;
            const dd = peak > 0 ? (peak - row.running_balance) / peak : 0;
            if (dd > maxDrawdown) maxDrawdown = dd;
        }
        const current = history[history.length - 1]?.running_balance || 0;
        const currentDrawdown = peak > 0 ? (peak - current) / peak : 0;
        return { max_drawdown: maxDrawdown, current_drawdown: currentDrawdown, peak };
    }
};

module.exports = { initDB, initSchema, saveDB, settings, meetings, races, runners, selections, bets, raceResults, auditLogs, transactions, stats };
