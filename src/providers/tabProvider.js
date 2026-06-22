const { RacingProvider } = require('./racingProvider');

class TabProvider extends RacingProvider {
    constructor() {
        super({ name: 'tab' });
    }

    async getTodaysMeetings() {
        throw new Error('TAB provider is not implemented. Add a compliant API/feed integration before enabling this provider.');
    }

    async getRacesForMeeting() {
        throw new Error('TAB provider is not implemented. Do not scrape or bypass access controls.');
    }

    async getRunnersForRace() {
        throw new Error('TAB provider is not implemented. Do not scrape or bypass access controls.');
    }
}

module.exports = TabProvider;
