const fs = require('fs');
const path = require('path');
const { RacingProvider } = require('./racingProvider');

const AU_STATES = new Set(['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA']);

function normalizeDate(value) {
    if (!value) return null;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
        return date.toISOString().slice(0, 10);
    }
    return String(value).slice(0, 10);
}

function todayIso() {
    return new Date().toISOString().slice(0, 10);
}

function readJsonFeed(feedPath) {
    if (!feedPath) {
        return null;
    }

    const resolved = path.resolve(feedPath);
    const raw = fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function isAustralianMeeting(meeting) {
    const country = String(meeting.country || 'AUS').toUpperCase();
    const state = String(meeting.state || '').toUpperCase();
    return country === 'AUS' && AU_STATES.has(state);
}

function disabledMessage() {
    return [
        'Racenet automated scraping is disabled.',
        'Racenet robots.txt says automated collection is prohibited unless you have express written permission.',
        'Use manual paste import, TAB API when approved, or set RACENET_FEED_PATH to a compliant JSON feed you are allowed to use.'
    ].join(' ');
}

class RacenetProvider extends RacingProvider {
    constructor(options = {}) {
        super({ name: 'racenet' });
        this.feedPath = options.feedPath || process.env.RACENET_FEED_PATH || '';
        this.allowedCountries = new Set(['AUS']);
        this.feed = null;
    }

    getFeed() {
        if (!this.feed) {
            const parsed = readJsonFeed(this.feedPath);
            if (!parsed) {
                throw new Error(disabledMessage());
            }
            this.feed = parsed;
        }
        return this.feed;
    }

    getFeedMeetings() {
        const feed = this.getFeed();
        return asArray(feed.meetings)
            .filter(isAustralianMeeting)
            .map(meeting => ({
                source: 'racenet',
                source_meeting_id: String(meeting.source_meeting_id || meeting.id || `${meeting.meeting_date || meeting.date}-${meeting.state}-${meeting.track_name || meeting.track}`),
                meeting_date: normalizeDate(meeting.meeting_date || meeting.date),
                track_name: meeting.track_name || meeting.track,
                state: String(meeting.state || 'Unknown').toUpperCase(),
                country: 'AUS',
                race_type: meeting.race_type || 'horse',
                weather: meeting.weather || null,
                rail_position: meeting.rail_position || null,
                races: asArray(meeting.races)
            }));
    }

    async getTodaysMeetings() {
        const targetDate = process.env.RACING_IMPORT_DATE || todayIso();
        return this.getFeedMeetings().filter(meeting => meeting.meeting_date === targetDate);
    }

    async getRacesForMeeting(meeting) {
        const feedMeeting = this.getFeedMeetings().find(item =>
            item.source_meeting_id === meeting.source_meeting_id ||
            (item.meeting_date === (meeting.meeting_date || meeting.date) &&
                item.state === meeting.state &&
                item.track_name === (meeting.track_name || meeting.track))
        );

        return asArray(feedMeeting?.races).map(race => ({
            source: 'racenet',
            source_race_id: String(race.source_race_id || race.id || `${feedMeeting.source_meeting_id}-R${race.race_number || race.race_no}`),
            race_number: parseInt(race.race_number ?? race.race_no, 10),
            race_name: race.race_name || race.name || null,
            start_time: race.start_time || race.jump_time || null,
            distance: parseInt(race.distance, 10) || null,
            class: race.class || race.race_class || null,
            track_condition: race.track_condition || null,
            status: race.status || 'scheduled',
            runners: asArray(race.runners)
        }));
    }

    async getRunnersForRace(race) {
        const meetings = this.getFeedMeetings();
        for (const meeting of meetings) {
            const feedRace = asArray(meeting.races).find(item => {
                const raceNo = parseInt(item.race_number ?? item.race_no, 10);
                const sourceRaceId = String(item.source_race_id || item.id || `${meeting.source_meeting_id}-R${raceNo}`);
                return sourceRaceId === race.source_race_id || raceNo === parseInt(race.race_number ?? race.race_no, 10);
            });

            if (feedRace) {
                return asArray(feedRace.runners).map(runner => ({
                    source: 'racenet',
                    source_runner_id: String(runner.source_runner_id || runner.id || `${race.source_race_id || feedRace.source_race_id}-${runner.runner_number || runner.saddle_no}`),
                    runner_number: parseInt(runner.runner_number ?? runner.saddle_no, 10),
                    horse_name: runner.horse_name || runner.name,
                    barrier: parseInt(runner.barrier, 10) || null,
                    weight: parseFloat(runner.weight) || null,
                    jockey: runner.jockey || null,
                    trainer: runner.trainer || null,
                    scratched: Boolean(runner.scratched),
                    fixed_win_odds: parseFloat(runner.fixed_win_odds ?? runner.odds_win) || null,
                    fixed_place_odds: parseFloat(runner.fixed_place_odds ?? runner.odds_place) || null
                })).filter(runner => runner.runner_number && runner.horse_name);
            }
        }

        return [];
    }
}

module.exports = RacenetProvider;
