const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DB_PATH = process.env.RACEMATE_DB_PATH || path.join(__dirname, '..', 'data', 'racing.db');

async function main() {
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(DB_PATH));

    const all = (sql, params = []) => {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
    };
    const get = (sql, params = []) => all(sql, params)[0] || null;
    const run = (sql, params = []) => db.run(sql, params);

    const logs = all('SELECT * FROM audit_logs ORDER BY id ASC');
    const deletedRaceKeys = new Set();
    for (const log of logs) {
        if (log.event_type !== 'RACE_DELETED') continue;
        let payload = {};
        try {
            payload = JSON.parse(log.payload_json || '{}');
        } catch {
            payload = {};
        }
        if (payload.race_id) deletedRaceKeys.add(`id:${payload.race_id}`);
        if (payload.date && payload.track && payload.race_no) {
            deletedRaceKeys.add(`${payload.date}|${payload.track}|${payload.race_no}`);
        }
    }

    let repaired = 0;
    let skipped = 0;
    for (const log of logs) {
        if (log.event_type !== 'BET_PLACED') continue;

        let payload = {};
        try {
            payload = JSON.parse(log.payload_json || '{}');
        } catch {
            skipped += 1;
            continue;
        }

        if (!payload.bet_id) {
            skipped += 1;
            continue;
        }

        const raceDeleted = deletedRaceKeys.has(`id:${payload.race_id}`) ||
            deletedRaceKeys.has(`${payload.date}|${payload.track}|${payload.race_no}`);
        if (raceDeleted) {
            const repairedBet = get(`SELECT b.*, s.model_version
                FROM bets b LEFT JOIN selections s ON b.selection_id = s.id
                WHERE b.id = ?`, [payload.bet_id]);
            if (repairedBet && repairedBet.model_version === 'audit-repair') {
                run('DELETE FROM bets WHERE id = ?', [payload.bet_id]);
                run('DELETE FROM selections WHERE id = ?', [repairedBet.selection_id]);
            }
            skipped += 1;
            continue;
        }

        let meeting = get(
            'SELECT * FROM meetings WHERE date = ? AND state = ? AND track = ?',
            [payload.date, payload.state, payload.track]
        );
        if (!meeting) {
            run(`INSERT INTO meetings (date, state, track, source, created_at, updated_at)
                 VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`, [
                payload.date,
                payload.state || 'Unknown',
                payload.track || 'Unknown',
                'audit_repair'
            ]);
            meeting = get(
                'SELECT * FROM meetings WHERE date = ? AND state = ? AND track = ?',
                [payload.date, payload.state, payload.track]
            );
        }

        let race = get('SELECT * FROM races WHERE meeting_id = ? AND race_no = ?', [meeting.id, payload.race_no]);
        if (!race) {
            run(`INSERT INTO races (meeting_id, race_no, race_name, distance, source, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`, [
                meeting.id,
                payload.race_no,
                payload.race_name || `Race ${payload.race_no}`,
                null,
                'audit_repair'
            ]);
            race = get('SELECT * FROM races WHERE meeting_id = ? AND race_no = ?', [meeting.id, payload.race_no]);
        }

        let runner = get('SELECT * FROM runners WHERE race_id = ? AND saddle_no = ?', [race.id, payload.saddle_no]);
        if (!runner) {
            run(`INSERT INTO runners (race_id, saddle_no, horse_name, odds_win, odds_place, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`, [
                race.id,
                payload.saddle_no,
                payload.horse_name || 'Unknown runner',
                payload.odds_win ?? null,
                payload.odds_place ?? null
            ]);
            runner = get('SELECT * FROM runners WHERE race_id = ? AND saddle_no = ?', [race.id, payload.saddle_no]);
        }

        run(`INSERT INTO selections
             (user_id, race_id, runner_id, model_version, odds_win, odds_place, recommendation_status, explanation_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            1,
            race.id,
            runner.id,
            'audit-repair',
            payload.odds_win ?? null,
            payload.odds_place ?? null,
            'bet',
            JSON.stringify({
                reason: 'Recreated from audit log after prior meeting import overwrite',
                audit_log_id: log.id
            }),
            log.created_at
        ]);

        const selection = get(
            'SELECT * FROM selections WHERE user_id = 1 AND race_id = ? AND runner_id = ? ORDER BY id DESC LIMIT 1',
            [race.id, runner.id]
        );

        const existingBet = get('SELECT * FROM bets WHERE id = ?', [payload.bet_id]);
        if (existingBet) {
            run(`UPDATE bets
                 SET user_id = ?, selection_id = ?, stake_win = ?, stake_place = ?,
                     odds_win = ?, odds_place = ?, placed_at = ?, status = ?
                 WHERE id = ?`, [
                1,
                selection.id,
                payload.stake_win || 0,
                payload.stake_place || 0,
                payload.odds_win ?? null,
                payload.odds_place ?? null,
                log.created_at,
                existingBet.status || 'pending',
                payload.bet_id
            ]);
        } else {
            run(`INSERT INTO bets
                 (id, user_id, selection_id, stake_win, stake_place, odds_win, odds_place, placed_at, status, payout_win, payout_place)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                payload.bet_id,
                1,
                selection.id,
                payload.stake_win || 0,
                payload.stake_place || 0,
                payload.odds_win ?? null,
                payload.odds_place ?? null,
                log.created_at,
                'pending',
                0,
                0
            ]);
        }

        repaired += 1;
    }

    fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
    console.log(JSON.stringify({ repaired, skipped }, null, 2));
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
