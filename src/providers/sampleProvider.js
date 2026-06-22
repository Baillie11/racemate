const { RacingProvider } = require('./racingProvider');
const { todayISO } = require('../utils/racingDate');

class SampleRacingProvider extends RacingProvider {
    constructor() {
        super({ name: 'sample' });
    }

    async getTodaysMeetings() {
        const meetingDate = todayISO();
        return [
            {
                source: this.name,
                source_meeting_id: `sample-${meetingDate}-flemington`,
                meeting_date: meetingDate,
                track_name: 'Flemington',
                state: 'VIC',
                country: 'AUS',
                race_type: 'horse'
            },
            {
                source: this.name,
                source_meeting_id: `sample-${meetingDate}-townsville`,
                meeting_date: meetingDate,
                track_name: 'Townsville',
                state: 'QLD',
                country: 'AUS',
                race_type: 'horse'
            }
        ];
    }

    async getRacesForMeeting(meeting) {
        const baseId = meeting.source_meeting_id;
        if (String(baseId).includes('townsville')) {
            return [
                {
                    source: this.name,
                    source_race_id: `${baseId}-r1`,
                    race_number: 1,
                    race_name: 'Sample North Queensland Maiden',
                    start_time: '12:45',
                    distance: 1200,
                    class: 'Maiden',
                    track_condition: 'Soft 5',
                    status: 'scheduled'
                }
            ];
        }

        return [
            {
                source: this.name,
                source_race_id: `${baseId}-r1`,
                race_number: 1,
                race_name: 'Sample Sprint Handicap',
                start_time: '13:05',
                distance: 1000,
                class: 'Benchmark 64',
                track_condition: 'Good 4',
                status: 'scheduled'
            },
            {
                source: this.name,
                source_race_id: `${baseId}-r2`,
                race_number: 2,
                race_name: 'Sample Staying Plate',
                start_time: '13:40',
                distance: 1600,
                class: 'Open',
                track_condition: 'Good 4',
                status: 'scheduled'
            }
        ];
    }

    async getRunnersForRace(race) {
        return [
            {
                source: this.name,
                source_runner_id: `${race.source_race_id}-runner-1`,
                runner_number: 1,
                horse_name: 'Sample Runner One',
                barrier: 3,
                weight: 58.5,
                jockey: 'A Rider',
                trainer: 'T Trainer',
                scratched: false,
                fixed_win_odds: 4.2,
                fixed_place_odds: 1.8
            },
            {
                source: this.name,
                source_runner_id: `${race.source_race_id}-runner-2`,
                runner_number: 2,
                horse_name: 'Sample Runner Two',
                barrier: 7,
                weight: 57,
                jockey: 'B Rider',
                trainer: 'S Stable',
                scratched: false,
                fixed_win_odds: 6,
                fixed_place_odds: 2.1
            },
            {
                source: this.name,
                source_runner_id: `${race.source_race_id}-runner-3`,
                runner_number: 3,
                horse_name: 'Sample Late Scratching',
                barrier: 1,
                weight: 56,
                jockey: 'C Rider',
                trainer: 'M Yard',
                scratched: true,
                fixed_win_odds: null,
                fixed_place_odds: null
            }
        ];
    }
}

module.exports = SampleRacingProvider;
