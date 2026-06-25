const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.RACEMATE_DB_PATH || path.join(__dirname, '..', 'data', 'racing.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

let db = null;
let SQL = null;
let isInitialized = false;
const DEFAULT_USER_ID = 1;

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
    migrateSchema();
    saveDB();
    console.log('Database schema initialized');
}

function tableColumns(tableName) {
    return all(`PRAGMA table_info(${tableName})`).map(row => row.name);
}

function addColumnIfMissing(tableName, columnName, definition) {
    const columns = tableColumns(tableName);
    if (columns.includes(columnName)) return;
    db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function tableHasColumn(tableName, columnName) {
    return tableColumns(tableName).includes(columnName);
}

function runMigrationStatement(sql) {
    try {
        db.run(sql);
    } catch (e) {
        if (!e.message.includes('already exists')) {
            console.warn('Migration warning:', e.message);
        }
    }
}

function normalizeHorseName(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[’‘]/g, "'")
        .replace(/[^a-z0-9']+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function backfillHorseProfiles() {
    const rows = all(`SELECT rn.id, rn.horse_name, rn.trainer, rn.rating, m.date
        FROM runners rn
        JOIN races rc ON rn.race_id = rc.id
        JOIN meetings m ON rc.meeting_id = m.id
        WHERE rn.horse_name IS NOT NULL AND trim(rn.horse_name) != ''
        ORDER BY m.date, rn.id`);

    for (const row of rows) {
        const normalizedName = normalizeHorseName(row.horse_name);
        if (!normalizedName) continue;

        let horse = get('SELECT * FROM horses WHERE normalized_name = ?', [normalizedName]);
        if (!horse) {
            db.run(`INSERT INTO horses
                (normalized_name, display_name, latest_trainer, latest_rating, first_seen_date, last_seen_date)
                VALUES (?, ?, ?, ?, ?, ?)`, [
                normalizedName,
                row.horse_name,
                row.trainer || null,
                row.rating || null,
                row.date || null,
                row.date || null
            ]);
            horse = get('SELECT * FROM horses WHERE normalized_name = ?', [normalizedName]);
        } else {
            db.run(`UPDATE horses SET
                display_name = ?,
                latest_trainer = COALESCE(?, latest_trainer),
                latest_rating = COALESCE(?, latest_rating),
                first_seen_date = CASE
                    WHEN first_seen_date IS NULL OR ? < first_seen_date THEN ?
                    ELSE first_seen_date
                END,
                last_seen_date = CASE
                    WHEN last_seen_date IS NULL OR ? > last_seen_date THEN ?
                    ELSE last_seen_date
                END,
                updated_at = datetime('now')
                WHERE id = ?`, [
                row.horse_name,
                row.trainer || null,
                row.rating || null,
                row.date,
                row.date,
                row.date,
                row.date,
                horse.id
            ]);
        }

        if (horse?.id) {
            db.run('UPDATE runners SET horse_id = ? WHERE id = ?', [horse.id, row.id]);
        }
    }
}

function migrateSchema() {
    runMigrationStatement(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    runMigrationStatement(`CREATE TABLE IF NOT EXISTS user_settings (
        user_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, key),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    runMigrationStatement("INSERT OR IGNORE INTO users (id, name, is_active) VALUES (1, 'Default User', 1)");

    addColumnIfMissing('meetings', 'source_meeting_id', 'TEXT');
    addColumnIfMissing('meetings', 'country', "TEXT DEFAULT 'AUS'");
    addColumnIfMissing('meetings', 'race_type', "TEXT DEFAULT 'horse'");
    addColumnIfMissing('meetings', 'updated_at', 'DATETIME');

    addColumnIfMissing('races', 'source', "TEXT DEFAULT 'manual'");
    addColumnIfMissing('races', 'source_race_id', 'TEXT');
    addColumnIfMissing('races', 'status', "TEXT DEFAULT 'scheduled'");
    addColumnIfMissing('races', 'updated_at', 'DATETIME');

    addColumnIfMissing('runners', 'source', "TEXT DEFAULT 'manual'");
    addColumnIfMissing('runners', 'source_runner_id', 'TEXT');
    addColumnIfMissing('runners', 'horse_id', 'INTEGER');
    addColumnIfMissing('runners', 'updated_at', 'DATETIME');

    addColumnIfMissing('selections', 'user_id', 'INTEGER NOT NULL DEFAULT 1');
    addColumnIfMissing('bets', 'user_id', 'INTEGER NOT NULL DEFAULT 1');
    addColumnIfMissing('audit_logs', 'user_id', 'INTEGER');
    addColumnIfMissing('transactions', 'user_id', 'INTEGER NOT NULL DEFAULT 1');

    if (!tableHasColumn('race_results', 'user_id')) {
        runMigrationStatement('ALTER TABLE race_results RENAME TO race_results_legacy');
        runMigrationStatement(`CREATE TABLE IF NOT EXISTS race_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL DEFAULT 1,
            race_id INTEGER NOT NULL,
            first_saddle INTEGER,
            second_saddle INTEGER,
            third_saddle INTEGER,
            settled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (race_id) REFERENCES races(id) ON DELETE CASCADE,
            UNIQUE(user_id, race_id)
        )`);
        runMigrationStatement(`INSERT OR IGNORE INTO race_results
            (id, user_id, race_id, first_saddle, second_saddle, third_saddle, settled_at)
            SELECT id, 1, race_id, first_saddle, second_saddle, third_saddle, settled_at
            FROM race_results_legacy`);
        runMigrationStatement('DROP TABLE race_results_legacy');
    }

    [
        'CREATE INDEX IF NOT EXISTS idx_user_settings_user ON user_settings(user_id)',
        'CREATE INDEX IF NOT EXISTS idx_meetings_source ON meetings(source, source_meeting_id)',
        'CREATE INDEX IF NOT EXISTS idx_races_source ON races(source, source_race_id)',
        'CREATE INDEX IF NOT EXISTS idx_horses_name ON horses(normalized_name)',
        'CREATE INDEX IF NOT EXISTS idx_horses_last_seen ON horses(last_seen_date)',
        'CREATE INDEX IF NOT EXISTS idx_runners_horse ON runners(horse_id)',
        'CREATE INDEX IF NOT EXISTS idx_runners_source ON runners(source, source_runner_id)',
        'CREATE INDEX IF NOT EXISTS idx_odds_snapshots_runner ON odds_snapshots(runner_id)',
        'CREATE INDEX IF NOT EXISTS idx_odds_snapshots_recorded ON odds_snapshots(recorded_at)',
        'CREATE INDEX IF NOT EXISTS idx_results_race ON results(race_id)',
        'CREATE INDEX IF NOT EXISTS idx_tips_race ON tips(race_id)',
        'CREATE INDEX IF NOT EXISTS idx_selections_user_race ON selections(user_id, race_id)',
        'CREATE INDEX IF NOT EXISTS idx_bets_user_status ON bets(user_id, status)',
        'CREATE INDEX IF NOT EXISTS idx_race_results_user_race ON race_results(user_id, race_id)',
        'CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id)',
        'CREATE INDEX IF NOT EXISTS idx_transactions_user_created ON transactions(user_id, created_at)'
    ].forEach(runMigrationStatement);

    backfillHorseProfiles();
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
    get(key, userId = null) {
        if (userId) {
            const userRow = get('SELECT value FROM user_settings WHERE user_id = ? AND key = ?', [userId, key]);
            if (userRow) return userRow.value;
        }
        const row = get('SELECT value FROM settings WHERE key = ?', [key]);
        return row ? row.value : null;
    },
    getAll(userId = null) {
        const rows = all('SELECT key, value FROM settings');
        const values = rows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {});
        if (!userId) return values;

        const userRows = all('SELECT key, value FROM user_settings WHERE user_id = ?', [userId]);
        return userRows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), values);
    },
    set(key, value, userId = null) {
        if (userId) {
            run(`INSERT OR REPLACE INTO user_settings (user_id, key, value, updated_at)
                VALUES (?, ?, ?, datetime('now'))`, [userId, key, String(value)]);
            return;
        }
        run(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`, [key, String(value)]);
    },
    setMultiple(obj, userId = null) {
        for (const [key, value] of Object.entries(obj)) {
            this.set(key, value, userId);
        }
    }
};

const users = {
    getDefault() {
        return get('SELECT * FROM users WHERE id = ?', [DEFAULT_USER_ID]);
    },
    getById(id) {
        return get('SELECT * FROM users WHERE id = ? AND is_active = 1', [id]);
    },
    getAll() {
        return all('SELECT * FROM users WHERE is_active = 1 ORDER BY name COLLATE NOCASE');
    },
    create(name) {
        const cleanName = String(name || '').trim();
        if (!cleanName) throw new Error('User name is required');
        const result = run(`INSERT INTO users (name, is_active, created_at, updated_at)
            VALUES (?, 1, datetime('now'), datetime('now'))`, [cleanName]);
        return this.getById(result.lastInsertRowid);
    },
    ensureDefault() {
        run("INSERT OR IGNORE INTO users (id, name, is_active) VALUES (1, 'Default User', 1)");
        return this.getDefault();
    }
};

// Meetings operations
const meetings = {
    create(data) {
        const existing = this.getByDateTrack(data.date, data.state, data.track);
        if (existing) {
            run(`UPDATE meetings
                 SET source = ?, weather = ?, rail_position = ?, updated_at = datetime('now')
                 WHERE id = ?`, [
                data.source || existing.source || 'manual',
                data.weather || existing.weather || null,
                data.rail_position || existing.rail_position || null,
                existing.id
            ]);
            return this.getById(existing.id);
        }

        run(`INSERT INTO meetings (date, state, track, source, weather, rail_position, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
            [data.date, data.state, data.track, data.source || 'manual', data.weather || null, data.rail_position || null]);
        return this.getByDateTrack(data.date, data.state, data.track);
    },
    upsertFromProvider(data) {
        const source = data.source || 'sample';
        const date = data.meeting_date || data.date;
        const track = data.track_name || data.track;
        const state = data.state || 'Unknown';
        const existing = data.source_meeting_id
            ? get('SELECT * FROM meetings WHERE source = ? AND source_meeting_id = ?', [source, data.source_meeting_id])
            : this.getByDateTrack(date, state, track);

        if (existing) {
            run(`UPDATE meetings
                 SET date = ?, state = ?, track = ?, source = ?, source_meeting_id = ?,
                     country = ?, race_type = ?, weather = ?, rail_position = ?, updated_at = datetime('now')
                 WHERE id = ?`, [
                date,
                state,
                track,
                source,
                data.source_meeting_id || existing.source_meeting_id || null,
                data.country || existing.country || 'AUS',
                data.race_type || existing.race_type || 'horse',
                data.weather || existing.weather || null,
                data.rail_position || existing.rail_position || null,
                existing.id
            ]);
            return this.getById(existing.id);
        }

        run(`INSERT INTO meetings
             (date, state, track, source, source_meeting_id, country, race_type, weather, rail_position, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`, [
            date,
            state,
            track,
            source,
            data.source_meeting_id || null,
            data.country || 'AUS',
            data.race_type || 'horse',
            data.weather || null,
            data.rail_position || null
        ]);
        return data.source_meeting_id
            ? get('SELECT * FROM meetings WHERE source = ? AND source_meeting_id = ?', [source, data.source_meeting_id])
            : this.getByDateTrack(date, state, track);
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
    getImportedByDate(date) {
        return all(`SELECT * FROM meetings
            WHERE date = ? AND source_meeting_id IS NOT NULL
            ORDER BY state, track`, [date]);
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
                [data.race_name || null, data.start_time || existing.start_time || null, data.distance || null,
                 data.track_condition || null, data.race_class || null, data.prize_money || null, existing.id]);
            return this.getById(existing.id);
        }
        run(`INSERT INTO races (meeting_id, race_no, race_name, start_time, distance, track_condition, race_class, prize_money)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [meetingId, data.race_no, data.race_name || null, data.start_time || null, data.distance || null,
             data.track_condition || null, data.race_class || null, data.prize_money || null]);
        return this.getByMeetingAndNumber(meetingId, data.race_no);
    },
    upsertFromProvider(meetingId, data) {
        const source = data.source || 'sample';
        const raceNo = parseInt(data.race_number ?? data.race_no, 10);
        const existing = data.source_race_id
            ? get('SELECT * FROM races WHERE source = ? AND source_race_id = ?', [source, data.source_race_id])
            : this.getByMeetingAndNumber(meetingId, raceNo);

        const payload = {
            race_no: raceNo,
            race_name: data.race_name || null,
            start_time: data.start_time || null,
            distance: parseInt(data.distance, 10) || null,
            track_condition: data.track_condition || null,
            race_class: data.class || data.race_class || null,
            prize_money: parseInt(data.prize_money, 10) || null,
            status: data.status || 'scheduled'
        };

        if (existing) {
            run(`UPDATE races
                 SET meeting_id = ?, race_no = ?, source = ?, source_race_id = ?, race_name = ?,
                     start_time = ?, distance = ?, track_condition = ?, race_class = ?, prize_money = ?,
                     status = ?, updated_at = datetime('now')
                 WHERE id = ?`, [
                meetingId,
                payload.race_no,
                source,
                data.source_race_id || existing.source_race_id || null,
                payload.race_name,
                payload.start_time,
                payload.distance,
                payload.track_condition,
                payload.race_class,
                payload.prize_money,
                payload.status,
                existing.id
            ]);
            return this.getById(existing.id);
        }

        run(`INSERT INTO races
             (meeting_id, race_no, source, source_race_id, race_name, start_time, distance,
              track_condition, race_class, prize_money, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`, [
            meetingId,
            payload.race_no,
            source,
            data.source_race_id || null,
            payload.race_name,
            payload.start_time,
            payload.distance,
            payload.track_condition,
            payload.race_class,
            payload.prize_money,
            payload.status
        ]);

        return data.source_race_id
            ? get('SELECT * FROM races WHERE source = ? AND source_race_id = ?', [source, data.source_race_id])
            : this.getByMeetingAndNumber(meetingId, payload.race_no);
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

// Horse profiles are permanent identities; runners are their race-by-race appearances.
const horses = {
    ensureAppearance(horseName, raceId, data = {}) {
        const normalizedName = normalizeHorseName(horseName);
        if (!normalizedName) return null;

        const raceContext = get(`SELECT m.date
            FROM races rc
            JOIN meetings m ON rc.meeting_id = m.id
            WHERE rc.id = ?`, [raceId]);
        const appearanceDate = raceContext?.date || null;
        let horse = get('SELECT * FROM horses WHERE normalized_name = ?', [normalizedName]);

        if (!horse) {
            const result = run(`INSERT INTO horses
                (normalized_name, display_name, latest_trainer, latest_rating, first_seen_date, last_seen_date)
                VALUES (?, ?, ?, ?, ?, ?)`, [
                normalizedName,
                String(horseName).trim(),
                data.trainer || null,
                data.rating || null,
                appearanceDate,
                appearanceDate
            ]);
            return this.getById(result.lastInsertRowid);
        }

        const isLatestAppearance = !horse.last_seen_date || !appearanceDate || appearanceDate >= horse.last_seen_date;
        run(`UPDATE horses SET
            display_name = ?,
            latest_trainer = ?,
            latest_rating = ?,
            first_seen_date = ?,
            last_seen_date = ?,
            updated_at = datetime('now')
            WHERE id = ?`, [
            String(horseName).trim(),
            isLatestAppearance ? (data.trainer || horse.latest_trainer || null) : horse.latest_trainer,
            isLatestAppearance ? (data.rating || horse.latest_rating || null) : horse.latest_rating,
            !horse.first_seen_date || (appearanceDate && appearanceDate < horse.first_seen_date)
                ? appearanceDate
                : horse.first_seen_date,
            appearanceDate && (!horse.last_seen_date || appearanceDate > horse.last_seen_date)
                ? appearanceDate
                : horse.last_seen_date,
            horse.id
        ]);
        return this.getById(horse.id);
    },
    getById(id) {
        return get('SELECT * FROM horses WHERE id = ?', [id]);
    },
    list(search = '', limit = 250) {
        const cleanSearch = String(search || '').trim();
        const params = [];
        let where = '';
        if (cleanSearch) {
            where = 'WHERE h.display_name LIKE ? OR h.latest_trainer LIKE ?';
            params.push(`%${cleanSearch}%`, `%${cleanSearch}%`);
        }
        params.push(Math.min(Math.max(parseInt(limit, 10) || 250, 1), 1000));

        return all(`SELECT h.*,
                COUNT(rn.id) AS appearances,
                COUNT(DISTINCT rc.id) AS races,
                MAX(m.date) AS latest_race_date
            FROM horses h
            LEFT JOIN runners rn ON rn.horse_id = h.id
            LEFT JOIN races rc ON rn.race_id = rc.id
            LEFT JOIN meetings m ON rc.meeting_id = m.id
            ${where}
            GROUP BY h.id
            ORDER BY COALESCE(MAX(m.date), h.last_seen_date) DESC, h.display_name
            LIMIT ?`, params);
    },
    getSummary() {
        return get(`SELECT
                COUNT(*) AS profiles,
                COALESCE(SUM(appearance_count), 0) AS appearances,
                COALESCE(SUM(CASE WHEN appearance_count > 1 THEN 1 ELSE 0 END), 0) AS repeat_runners
            FROM (
                SELECT h.id, COUNT(rn.id) AS appearance_count
                FROM horses h
                LEFT JOIN runners rn ON rn.horse_id = h.id
                GROUP BY h.id
            )`);
    },
    getProfile(id) {
        const horse = this.getById(id);
        if (!horse) return null;

        const appearances = all(`SELECT rn.*, rc.race_no, rc.race_name, rc.start_time,
                rc.distance, rc.track_condition, rc.race_class, rc.status AS race_status,
                m.date, m.track, m.state,
                COALESCE(pr.finishing_position,
                    CASE
                        WHEN rr.first_saddle = rn.saddle_no THEN 1
                        WHEN rr.second_saddle = rn.saddle_no THEN 2
                        WHEN rr.third_saddle = rn.saddle_no THEN 3
                        ELSE NULL
                    END
                ) AS finishing_position
            FROM runners rn
            JOIN races rc ON rn.race_id = rc.id
            JOIN meetings m ON rc.meeting_id = m.id
            LEFT JOIN results pr ON pr.race_id = rc.id AND pr.runner_id = rn.id
            LEFT JOIN race_results rr ON rr.id = (
                SELECT MIN(rr2.id) FROM race_results rr2 WHERE rr2.race_id = rc.id
            )
            WHERE rn.horse_id = ?
            ORDER BY m.date DESC, rc.race_no DESC`, [id]);

        const completed = appearances.filter(row => Number(row.finishing_position) > 0);
        return {
            horse,
            summary: {
                appearances: appearances.length,
                completed: completed.length,
                wins: completed.filter(row => Number(row.finishing_position) === 1).length,
                places: completed.filter(row => Number(row.finishing_position) <= 3).length
            },
            appearances
        };
    }
};

// Runners operations
const runners = {
    create(raceId, data) {
        const horse = horses.ensureAppearance(data.horse_name, raceId, data);
        const existing = this.getByRaceAndSaddle(raceId, data.saddle_no);
        if (existing) {
            run(`UPDATE runners SET horse_id = ?, horse_name = ?, barrier = ?, weight = ?, jockey = ?, trainer = ?,
                 form_string = ?, career_wins = ?, career_places = ?, career_starts = ?,
                 track_wins = ?, track_starts = ?, distance_wins = ?, distance_starts = ?,
                 rating = ?, days_since_last_run = ?, scratched = ?, odds_win = ?, odds_place = ?
                 WHERE id = ?`,
                [horse?.id || existing.horse_id || null, data.horse_name, data.barrier || null, data.weight || null, data.jockey || null, data.trainer || null,
                 data.form_string || null, data.career_wins || 0, data.career_places || 0, data.career_starts || 0,
                 data.track_wins || 0, data.track_starts || 0, data.distance_wins || 0, data.distance_starts || 0,
                 data.rating || null, data.days_since_last_run || null, data.scratched ? 1 : 0,
                 data.odds_win || null, data.odds_place || null, existing.id]);
            return this.getById(existing.id);
        }
        run(`INSERT INTO runners (race_id, horse_id, saddle_no, horse_name, barrier, weight, jockey, trainer,
             form_string, career_wins, career_places, career_starts, track_wins, track_starts,
             distance_wins, distance_starts, rating, days_since_last_run, scratched, odds_win, odds_place)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [raceId, horse?.id || null, data.saddle_no, data.horse_name, data.barrier || null, data.weight || null,
             data.jockey || null, data.trainer || null, data.form_string || null,
             data.career_wins || 0, data.career_places || 0, data.career_starts || 0,
             data.track_wins || 0, data.track_starts || 0, data.distance_wins || 0, data.distance_starts || 0,
             data.rating || null, data.days_since_last_run || null, data.scratched ? 1 : 0,
             data.odds_win || null, data.odds_place || null]);
        return this.getByRaceAndSaddle(raceId, data.saddle_no);
    },
    upsertFromProvider(raceId, data) {
        const horse = horses.ensureAppearance(data.horse_name, raceId, data);
        const source = data.source || 'sample';
        const saddleNo = parseInt(data.runner_number ?? data.saddle_no, 10);
        const existing = data.source_runner_id
            ? get('SELECT * FROM runners WHERE source = ? AND source_runner_id = ?', [source, data.source_runner_id])
            : this.getByRaceAndSaddle(raceId, saddleNo);

        const payload = {
            saddle_no: saddleNo,
            horse_name: data.horse_name,
            barrier: parseInt(data.barrier, 10) || null,
            weight: parseFloat(data.weight) || null,
            jockey: data.jockey || null,
            trainer: data.trainer || null,
            scratched: data.scratched ? 1 : 0,
            odds_win: parseFloat(data.fixed_win_odds ?? data.odds_win) || null,
            odds_place: parseFloat(data.fixed_place_odds ?? data.odds_place) || null
        };

        if (existing) {
            run(`UPDATE runners
                 SET race_id = ?, horse_id = ?, saddle_no = ?, source = ?, source_runner_id = ?, horse_name = ?,
                     barrier = ?, weight = ?, jockey = ?, trainer = ?, scratched = ?,
                     odds_win = ?, odds_place = ?, updated_at = datetime('now')
                 WHERE id = ?`, [
                raceId,
                horse?.id || existing.horse_id || null,
                payload.saddle_no,
                source,
                data.source_runner_id || existing.source_runner_id || null,
                payload.horse_name,
                payload.barrier,
                payload.weight,
                payload.jockey,
                payload.trainer,
                payload.scratched,
                payload.odds_win,
                payload.odds_place,
                existing.id
            ]);
            return this.getById(existing.id);
        }

        run(`INSERT INTO runners
             (race_id, horse_id, saddle_no, source, source_runner_id, horse_name, barrier, weight,
              jockey, trainer, scratched, odds_win, odds_place, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`, [
            raceId,
            horse?.id || null,
            payload.saddle_no,
            source,
            data.source_runner_id || null,
            payload.horse_name,
            payload.barrier,
            payload.weight,
            payload.jockey,
            payload.trainer,
            payload.scratched,
            payload.odds_win,
            payload.odds_place
        ]);

        return data.source_runner_id
            ? get('SELECT * FROM runners WHERE source = ? AND source_runner_id = ?', [source, data.source_runner_id])
            : this.getByRaceAndSaddle(raceId, payload.saddle_no);
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
        const userId = data.user_id || DEFAULT_USER_ID;
        const result = run(`INSERT INTO selections (user_id, race_id, runner_id, model_version, score, prob_win_est, prob_place_est,
             odds_win, odds_place, ev_win, ev_place, recommendation_status, explanation_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, data.race_id, data.runner_id, data.model_version || 'v1', data.score,
             data.prob_win_est, data.prob_place_est, data.odds_win, data.odds_place,
             data.ev_win, data.ev_place, data.recommendation_status,
             typeof data.explanation === 'object' ? JSON.stringify(data.explanation) : (data.explanation_json || '{}')]);
        return this.getById(result.lastInsertRowid);
    },
    getById(id, userId = null) {
        if (userId) {
            return get('SELECT * FROM selections WHERE id = ? AND user_id = ?', [id, userId]);
        }
        return get('SELECT * FROM selections WHERE id = ?', [id]);
    },
    getByRace(raceId, userId = DEFAULT_USER_ID) {
        return all(`SELECT s.*, r.horse_name, r.saddle_no, r.jockey, r.barrier
            FROM selections s JOIN runners r ON s.runner_id = r.id
            WHERE s.race_id = ? AND s.user_id = ? ORDER BY s.score DESC`, [raceId, userId]);
    },
    getRecommendation(raceId, userId = DEFAULT_USER_ID) {
        return get(`SELECT s.*, r.horse_name, r.saddle_no, r.jockey, r.barrier
            FROM selections s JOIN runners r ON s.runner_id = r.id
            WHERE s.race_id = ? AND s.recommendation_status = 'bet'
              AND s.user_id = ?
            ORDER BY s.score DESC LIMIT 1`, [raceId, userId]);
    },
    deleteByRace(raceId, userId = DEFAULT_USER_ID) {
        run('DELETE FROM selections WHERE race_id = ? AND user_id = ?', [raceId, userId]);
    }
};

// Bets operations
const bets = {
    create(data) {
        const userId = data.user_id || DEFAULT_USER_ID;
        const stakeWin = data.stake_win || 0;
        const stakePlace = data.stake_place || 0;
        const oddsWin = data.odds_win ?? null;
        const oddsPlace = data.odds_place ?? null;

        run(`INSERT INTO bets (user_id, selection_id, stake_win, stake_place, odds_win, odds_place)
            VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, data.selection_id, stakeWin, stakePlace, oddsWin, oddsPlace]);

        return get(`SELECT * FROM bets
            WHERE user_id = ? AND selection_id = ? AND stake_win = ? AND stake_place = ?
              AND (odds_win = ? OR (odds_win IS NULL AND ? IS NULL))
              AND (odds_place = ? OR (odds_place IS NULL AND ? IS NULL))
            ORDER BY id DESC LIMIT 1`,
            [userId, data.selection_id, stakeWin, stakePlace, oddsWin, oddsWin, oddsPlace, oddsPlace]);
    },
    getById(id, userId = null) {
        if (userId) {
            return get('SELECT * FROM bets WHERE id = ? AND user_id = ?', [id, userId]);
        }
        return get('SELECT * FROM bets WHERE id = ?', [id]);
    },
    getDetailedById(id, userId = null) {
        const userClause = userId ? ' AND b.user_id = ?' : '';
        const params = userId ? [id, userId] : [id];
        return get(`SELECT b.*, s.race_id, r.horse_name, r.saddle_no, rc.race_no, rc.race_name, rc.start_time, m.track, m.state, m.date,
                   rr.first_saddle, rr.second_saddle, rr.third_saddle, rr.settled_at AS race_result_settled_at
            FROM bets b
            JOIN selections s ON b.selection_id = s.id
            JOIN runners r ON s.runner_id = r.id
            JOIN races rc ON s.race_id = rc.id
            JOIN meetings m ON rc.meeting_id = m.id
            LEFT JOIN race_results rr ON rr.race_id = rc.id AND rr.user_id = b.user_id
            WHERE b.id = ?${userClause}`, params);
    },
    getPending(userId = DEFAULT_USER_ID) {
        return all(`SELECT b.*, s.race_id, r.horse_name, r.saddle_no, rc.race_no, rc.race_name, rc.start_time, m.track, m.date,
                   rr.first_saddle, rr.second_saddle, rr.third_saddle, rr.settled_at AS race_result_settled_at
            FROM bets b
            JOIN selections s ON b.selection_id = s.id
            JOIN runners r ON s.runner_id = r.id
            JOIN races rc ON s.race_id = rc.id
            JOIN meetings m ON rc.meeting_id = m.id
            LEFT JOIN race_results rr ON rr.race_id = rc.id AND rr.user_id = b.user_id
            WHERE b.status = 'pending' AND b.user_id = ? ORDER BY m.date DESC, rc.race_no`, [userId]);
    },
    getPendingByRace(raceId, userId = DEFAULT_USER_ID) {
        return all(`SELECT b.*, s.race_id, r.horse_name, r.saddle_no, rc.race_no, rc.race_name, rc.start_time, m.track, m.date,
                   rr.first_saddle, rr.second_saddle, rr.third_saddle, rr.settled_at AS race_result_settled_at
            FROM bets b
            JOIN selections s ON b.selection_id = s.id
            JOIN runners r ON s.runner_id = r.id
            JOIN races rc ON s.race_id = rc.id
            JOIN meetings m ON rc.meeting_id = m.id
            LEFT JOIN race_results rr ON rr.race_id = rc.id AND rr.user_id = b.user_id
            WHERE b.status = 'pending' AND s.race_id = ? AND b.user_id = ? ORDER BY b.placed_at DESC`, [raceId, userId]);
    },
    getByRace(raceId, userId = DEFAULT_USER_ID) {
        return all(`SELECT b.*, s.race_id, r.horse_name, r.saddle_no, rc.race_no, rc.race_name, rc.start_time, m.track, m.date,
                   rr.first_saddle, rr.second_saddle, rr.third_saddle, rr.settled_at AS race_result_settled_at
            FROM bets b
            JOIN selections s ON b.selection_id = s.id
            JOIN runners r ON s.runner_id = r.id
            JOIN races rc ON s.race_id = rc.id
            JOIN meetings m ON rc.meeting_id = m.id
            LEFT JOIN race_results rr ON rr.race_id = rc.id AND rr.user_id = b.user_id
            WHERE s.race_id = ? AND b.user_id = ? ORDER BY b.placed_at DESC`, [raceId, userId]);
    },
    getAll(limit = 100, userId = DEFAULT_USER_ID) {
        return all(`SELECT b.*, s.race_id, r.horse_name, r.saddle_no, rc.race_no, rc.race_name, rc.start_time, m.track, m.date,
                   rr.first_saddle, rr.second_saddle, rr.third_saddle, rr.settled_at AS race_result_settled_at
            FROM bets b
            JOIN selections s ON b.selection_id = s.id
            JOIN runners r ON s.runner_id = r.id
            JOIN races rc ON s.race_id = rc.id
            JOIN meetings m ON rc.meeting_id = m.id
            LEFT JOIN race_results rr ON rr.race_id = rc.id AND rr.user_id = b.user_id
            WHERE b.user_id = ?
            ORDER BY b.placed_at DESC LIMIT ?`, [userId, limit]);
    },
    settle(betId, status, position, payoutWin, payoutPlace, userId = DEFAULT_USER_ID) {
        run(`UPDATE bets SET status = ?, result_position = ?, payout_win = ?, payout_place = ?, settled_at = datetime('now')
            WHERE id = ? AND user_id = ?`, [status, position, payoutWin, payoutPlace, betId, userId]);
        return this.getById(betId, userId);
    }
};

// Race results operations
const raceResults = {
    upsert(raceId, firstSaddle = null, secondSaddle = null, thirdSaddle = null, userId = DEFAULT_USER_ID) {
        const existing = this.getByRace(raceId, userId);
        if (existing) {
            run(`UPDATE race_results
                 SET first_saddle = ?, second_saddle = ?, third_saddle = ?, settled_at = datetime('now')
                 WHERE id = ?`, [firstSaddle, secondSaddle, thirdSaddle, existing.id]);
            return this.getByRace(raceId, userId);
        }

        run(`INSERT INTO race_results (user_id, race_id, first_saddle, second_saddle, third_saddle, settled_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))`, [userId, raceId, firstSaddle, secondSaddle, thirdSaddle]);
        return this.getByRace(raceId, userId);
    },
    getByRace(raceId, userId = DEFAULT_USER_ID) {
        return get('SELECT * FROM race_results WHERE race_id = ? AND user_id = ?', [raceId, userId]);
    }
};

const oddsSnapshots = {
    create(data) {
        const result = run(`INSERT INTO odds_snapshots (runner_id, source, win_odds, place_odds, recorded_at)
            VALUES (?, ?, ?, ?, datetime('now'))`, [
            data.runner_id,
            data.source || 'sample',
            data.win_odds ?? null,
            data.place_odds ?? null
        ]);
        return get('SELECT * FROM odds_snapshots WHERE id = ?', [result.lastInsertRowid]);
    },
    getByRunner(runnerId, limit = 100) {
        return all('SELECT * FROM odds_snapshots WHERE runner_id = ? ORDER BY recorded_at DESC LIMIT ?', [runnerId, limit]);
    }
};

const importedResults = {
    upsert(data) {
        const existing = get('SELECT * FROM results WHERE race_id = ? AND runner_id = ?', [data.race_id, data.runner_id || null]);
        if (existing) {
            run(`UPDATE results
                 SET finishing_position = ?, margin = ?, starting_price = ?, updated_at = datetime('now')
                 WHERE id = ?`, [
                data.finishing_position ?? null,
                data.margin || null,
                data.starting_price ?? null,
                existing.id
            ]);
            return get('SELECT * FROM results WHERE id = ?', [existing.id]);
        }

        const result = run(`INSERT INTO results
            (race_id, runner_id, finishing_position, margin, starting_price, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`, [
            data.race_id,
            data.runner_id || null,
            data.finishing_position ?? null,
            data.margin || null,
            data.starting_price ?? null
        ]);
        return get('SELECT * FROM results WHERE id = ?', [result.lastInsertRowid]);
    }
};

const tips = {
    upsert(data) {
        const existing = get(`SELECT * FROM tips
            WHERE race_id = ? AND runner_id = ? AND tip_type = ?`, [
            data.race_id,
            data.runner_id || null,
            data.tip_type || 'provider'
        ]);
        if (existing) {
            run(`UPDATE tips
                 SET confidence = ?, reasoning = ?, updated_at = datetime('now')
                 WHERE id = ?`, [
                data.confidence ?? null,
                data.reasoning || null,
                existing.id
            ]);
            return get('SELECT * FROM tips WHERE id = ?', [existing.id]);
        }

        const result = run(`INSERT INTO tips
            (race_id, runner_id, tip_type, confidence, reasoning, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`, [
            data.race_id,
            data.runner_id || null,
            data.tip_type || 'provider',
            data.confidence ?? null,
            data.reasoning || null
        ]);
        return get('SELECT * FROM tips WHERE id = ?', [result.lastInsertRowid]);
    }
};

// Audit log operations
const auditLogs = {
    create(data) {
        const result = run(`INSERT INTO audit_logs (user_id, event_type, message, entity_type, entity_id, payload_json)
            VALUES (?, ?, ?, ?, ?, ?)`, [
            data.user_id || null,
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
    getAll(limit = 500, eventType = null, userId = null) {
        const params = [];
        let sql = 'SELECT * FROM audit_logs WHERE 1 = 1';
        if (eventType) {
            sql += ' AND event_type = ?';
            params.push(eventType);
        }
        if (userId) {
            sql += ' AND (user_id = ? OR user_id IS NULL)';
            params.push(userId);
        }
        sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
        params.push(limit);
        return all(sql, params);
    }
};

// Transactions operations
const transactions = {
    create(data) {
        const result = run(`INSERT INTO transactions (user_id, type, amount, bet_id, description) VALUES (?, ?, ?, ?, ?)`,
            [data.user_id || DEFAULT_USER_ID, data.type, data.amount, data.bet_id || null, data.description || null]);
        return this.getById(result.lastInsertRowid);
    },
    getById(id, userId = null) {
        if (userId) {
            return get('SELECT * FROM transactions WHERE id = ? AND user_id = ?', [id, userId]);
        }
        return get('SELECT * FROM transactions WHERE id = ?', [id]);
    },
    getAll(limit = 500, userId = DEFAULT_USER_ID) {
        return all('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, limit]);
    },
    getBankroll(userId = DEFAULT_USER_ID) {
        const result = get('SELECT COALESCE(SUM(amount), 0) as bankroll FROM transactions WHERE user_id = ?', [userId]);
        return result?.bankroll || 0;
    },
    getDailyLoss(date, userId = DEFAULT_USER_ID) {
        const result = get(`SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0) as loss
            FROM transactions WHERE user_id = ? AND date(created_at) = ?`, [userId, date]);
        return Math.abs(result?.loss || 0);
    }
};

// Stats operations
const stats = {
    getBettingStats(startDate = null, endDate = null, state = null, track = null, userId = DEFAULT_USER_ID) {
        let sql = `SELECT COUNT(*) as total_bets,
                SUM(CASE WHEN b.status = 'won' THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN b.status = 'placed' THEN 1 ELSE 0 END) as places,
                SUM(CASE WHEN b.status = 'lost' THEN 1 ELSE 0 END) as losses,
                SUM(b.stake_win + b.stake_place) as total_staked,
                SUM(b.payout_win + b.payout_place) as total_returned,
                SUM(b.payout_win + b.payout_place - b.stake_win - b.stake_place) as profit
            FROM bets b
            JOIN selections s ON b.selection_id = s.id
            JOIN races r ON s.race_id = r.id
            JOIN meetings m ON r.meeting_id = m.id
            WHERE b.status != 'pending' AND b.user_id = ?`;
        const params = [userId];
        if (startDate) { sql += ' AND m.date >= ?'; params.push(startDate); }
        if (endDate) { sql += ' AND m.date <= ?'; params.push(endDate); }
        if (state) { sql += ' AND m.state = ?'; params.push(state); }
        if (track) { sql += ' AND m.track = ?'; params.push(track); }
        return get(sql, params) || { total_bets: 0, wins: 0, places: 0, losses: 0, total_staked: 0, total_returned: 0, profit: 0 };
    },
    getBankrollHistory(days = 30, userId = DEFAULT_USER_ID) {
        // sql.js doesn't support window functions well, use a simpler approach
        const txns = all(`SELECT t.id, date(t.created_at) as date, t.created_at, t.amount, t.type,
                t.description, t.bet_id,
                b.stake_win, b.stake_place, b.odds_win, b.odds_place, b.status as bet_status,
                b.payout_win, b.payout_place,
                s.race_id, rn.saddle_no, rn.horse_name,
                rc.race_no, rc.race_name, rc.start_time,
                m.track, m.state
            FROM transactions t
            LEFT JOIN bets b ON t.bet_id = b.id
            LEFT JOIN selections s ON b.selection_id = s.id
            LEFT JOIN runners rn ON s.runner_id = rn.id
            LEFT JOIN races rc ON s.race_id = rc.id
            LEFT JOIN meetings m ON rc.meeting_id = m.id
            WHERE t.user_id = ? AND t.created_at >= date('now', '-' || ? || ' days')
            ORDER BY t.created_at, t.id`, [userId, days]);
        let running = 0;
        return txns.map(t => {
            running += t.amount;
            return { ...t, running_balance: running };
        });
    },
    getDrawdown(userId = DEFAULT_USER_ID) {
        const history = this.getBankrollHistory(365, userId);
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

module.exports = {
    initDB,
    initSchema,
    saveDB,
    users,
    settings,
    meetings,
    races,
    horses,
    runners,
    selections,
    bets,
    raceResults,
    oddsSnapshots,
    importedResults,
    tips,
    auditLogs,
    transactions,
    stats
};
