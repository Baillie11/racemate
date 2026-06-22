const { RacingProvider } = require('./racingProvider');

class RacenetProvider extends RacingProvider {
    constructor() {
        super({ name: 'racenet' });
    }

    async getTodaysMeetings() {
        throw new Error('Racenet provider is not implemented. Add a compliant API/feed integration before enabling this provider.');
    }

    async getRacesForMeeting() {
        throw new Error('Racenet provider is not implemented. Do not scrape or bypass access controls.');
    }

    async getRunnersForRace() {
        throw new Error('Racenet provider is not implemented. Do not scrape or bypass access controls.');
    }
}

module.exports = RacenetProvider;
