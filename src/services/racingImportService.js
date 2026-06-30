const db = require('../../db/database');
const bankroll = require('../../services/bankroll');
const { createRacingProvider } = require('../providers');

function writeImportLog(eventType, message, payload = {}, userId = null) {
    try {
        db.auditLogs.create({
            user_id: userId || null,
            event_type: eventType,
            message,
            entity_type: 'racing_import',
            payload_json: payload
        });
    } catch (err) {
        console.error('Failed to write racing import log:', err.message);
    }
}

function providerName(provider) {
    return provider?.name || process.env.RACING_PROVIDER || 'sample';
}

function parsePositiveInt(value) {
    const parsed = parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeResultRows(rawResults = []) {
    const rows = Array.isArray(rawResults)
        ? rawResults
        : (Array.isArray(rawResults.results) ? rawResults.results : (Array.isArray(rawResults.placings) ? rawResults.placings : []));

    return rows
        .map(row => ({
            saddle_no: parsePositiveInt(row.saddle_no ?? row.runner_number ?? row.number),
            horse_name: row.horse_name || row.runner_name || row.name || null,
            finishing_position: parsePositiveInt(row.finishing_position ?? row.position ?? row.place),
            margin: row.margin || null,
            starting_price: row.starting_price ?? row.sp ?? row.fixed_win_odds ?? null
        }))
        .filter(row => row.saddle_no && row.finishing_position)
        .sort((a, b) => a.finishing_position - b.finishing_position);
}

function getRaceCandidates(options = {}) {
    const hasRaceId = Object.prototype.hasOwnProperty.call(options, 'raceId') ||
        Object.prototype.hasOwnProperty.call(options, 'race_id');
    const raceId = parsePositiveInt(options.raceId || options.race_id);
    if (hasRaceId && !raceId) {
        return [];
    }

    if (raceId) {
        const race = db.races.getById(raceId);
        const meeting = race ? db.meetings.getById(race.meeting_id) : null;
        return race && meeting ? [{ race, meeting }] : [];
    }

    const targetDate = options.date || null;
    const meetings = targetDate ? db.meetings.getByDate(targetDate) : db.meetings.getAll();
    return meetings.flatMap(meeting =>
        db.races.getByMeeting(meeting.id).map(race => ({ race, meeting }))
    );
}

function settlePendingBetsForOrder(raceId, resultOrder, userId) {
    const pendingBets = db.bets.getPendingByRace(raceId, userId);
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

    return settled;
}

async function importToday(options = {}) {
    const provider = options.provider || createRacingProvider(options.providerName);
    const source = providerName(provider);
    const startedAt = new Date().toISOString();
    const summary = {
        provider: source,
        started_at: startedAt,
        completed_at: null,
        meetings: 0,
        races: 0,
        runners: 0,
        odds_snapshots: 0,
        results: 0,
        errors: []
    };

    let meetings = [];
    try {
        meetings = await provider.getTodaysMeetings();
    } catch (err) {
        summary.errors.push({ scope: 'meetings', message: err.message });
        summary.completed_at = new Date().toISOString();
        writeImportLog('RACING_IMPORT_FAILED', 'Racing import failed before meetings loaded', summary);
        return { success: false, summary };
    }

    for (const providerMeeting of meetings) {
        let storedMeeting;
        try {
            storedMeeting = db.meetings.upsertFromProvider({ ...providerMeeting, source });
            summary.meetings += 1;
        } catch (err) {
            summary.errors.push({
                scope: 'meeting',
                source_meeting_id: providerMeeting.source_meeting_id || null,
                message: err.message
            });
            continue;
        }

        let races = [];
        try {
            races = await provider.getRacesForMeeting(providerMeeting);
        } catch (err) {
            summary.errors.push({
                scope: 'races',
                meeting_id: storedMeeting.id,
                message: err.message
            });
            continue;
        }

        for (const providerRace of races) {
            let storedRace;
            try {
                storedRace = db.races.upsertFromProvider(storedMeeting.id, { ...providerRace, source });
                summary.races += 1;
            } catch (err) {
                summary.errors.push({
                    scope: 'race',
                    meeting_id: storedMeeting.id,
                    source_race_id: providerRace.source_race_id || null,
                    message: err.message
                });
                continue;
            }

            try {
                const runners = await provider.getRunnersForRace(providerRace);
                for (const providerRunner of runners) {
                    const storedRunner = db.runners.upsertFromProvider(storedRace.id, { ...providerRunner, source });
                    summary.runners += 1;
                    if (providerRunner.fixed_win_odds || providerRunner.fixed_place_odds) {
                        db.oddsSnapshots.create({
                            runner_id: storedRunner.id,
                            source,
                            win_odds: providerRunner.fixed_win_odds ?? null,
                            place_odds: providerRunner.fixed_place_odds ?? null
                        });
                        summary.odds_snapshots += 1;
                    }
                }
            } catch (err) {
                summary.errors.push({
                    scope: 'runners',
                    race_id: storedRace.id,
                    source_race_id: providerRace.source_race_id || null,
                    message: err.message
                });
            }
        }
    }

    summary.completed_at = new Date().toISOString();
    db.settings.set('last_racing_import_at', summary.completed_at);
    db.settings.set('racing_provider', source);
    writeImportLog(
        summary.errors.length ? 'RACING_IMPORT_COMPLETED_WITH_ERRORS' : 'RACING_IMPORT_COMPLETED',
        `Racing import completed: ${summary.meetings} meetings, ${summary.races} races, ${summary.runners} runners`,
        summary
    );

    return { success: summary.errors.length === 0, summary };
}

async function importResults(options = {}) {
    const provider = options.provider || createRacingProvider(options.providerName);
    const source = providerName(provider);
    const userId = parsePositiveInt(options.userId || options.user_id) || 1;
    const candidates = getRaceCandidates(options);
    const summary = {
        provider: source,
        date: options.date || null,
        race_id: parsePositiveInt(options.raceId || options.race_id),
        checked: 0,
        results_imported: 0,
        races_settled: 0,
        bets_settled: 0,
        skipped: 0,
        errors: []
    };
    const races = [];

    for (const { race, meeting } of candidates) {
        if (options.onlyUnsettled !== false && db.raceResults.getByRace(race.id, userId)) {
            summary.skipped += 1;
            continue;
        }

        if (options.onlyPendingBets && db.bets.getPendingByRace(race.id, userId).length === 0) {
            summary.skipped += 1;
            continue;
        }

        summary.checked += 1;

        let providerResults = [];
        try {
            providerResults = await provider.getResultsForRace({
                ...race,
                race_number: race.race_no,
                race_no: race.race_no,
                meeting,
                meeting_date: meeting.date,
                track_name: meeting.track,
                state: meeting.state
            });
        } catch (err) {
            summary.errors.push({
                race_id: race.id,
                race_no: race.race_no,
                track: meeting.track,
                message: err.message
            });
            continue;
        }

        const resultRows = normalizeResultRows(providerResults);
        const topThree = resultRows
            .filter(row => row.finishing_position <= 3)
            .sort((a, b) => a.finishing_position - b.finishing_position)
            .slice(0, 3);

        if (topThree.length === 0) {
            summary.skipped += 1;
            continue;
        }

        const resultOrder = topThree.map(row => row.saddle_no);
        const storedResult = db.raceResults.upsert(
            race.id,
            resultOrder[0] || null,
            resultOrder[1] || null,
            resultOrder[2] || null,
            userId
        );

        for (const resultRow of resultRows) {
            const runner = db.runners.getByRaceAndSaddle(race.id, resultRow.saddle_no);
            db.importedResults.upsert({
                race_id: race.id,
                runner_id: runner?.id || null,
                finishing_position: resultRow.finishing_position,
                margin: resultRow.margin,
                starting_price: resultRow.starting_price
            });
        }

        const settled = settlePendingBetsForOrder(race.id, resultOrder, userId);
        summary.results_imported += resultRows.length;
        summary.races_settled += 1;
        summary.bets_settled += settled.length;
        races.push({
            race_id: race.id,
            race_no: race.race_no,
            race_name: race.race_name,
            track: meeting.track,
            state: meeting.state,
            date: meeting.date,
            placings: {
                first: storedResult?.first_saddle || null,
                second: storedResult?.second_saddle || null,
                third: storedResult?.third_saddle || null
            },
            settled
        });
    }

    writeImportLog(
        summary.errors.length ? 'RACING_RESULTS_IMPORT_COMPLETED_WITH_ERRORS' : 'RACING_RESULTS_IMPORT_COMPLETED',
        `Racing results import completed: ${summary.races_settled} races settled, ${summary.bets_settled} bets settled`,
        summary,
        userId
    );

    return {
        success: summary.errors.length === 0,
        summary,
        races,
        bankroll: bankroll.getBankroll(userId)
    };
}

async function importOdds() {
    return {
        success: false,
        message: 'Odds import is stubbed until a compliant provider is configured.'
    };
}

module.exports = { importToday, importResults, importOdds };
