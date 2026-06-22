const db = require('../../db/database');
const { createRacingProvider } = require('../providers');

function writeImportLog(eventType, message, payload = {}) {
    try {
        db.auditLogs.create({
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

async function importResults() {
    return {
        success: false,
        message: 'Results import is stubbed until a compliant provider is configured.'
    };
}

async function importOdds() {
    return {
        success: false,
        message: 'Odds import is stubbed until a compliant provider is configured.'
    };
}

module.exports = { importToday, importResults, importOdds };
