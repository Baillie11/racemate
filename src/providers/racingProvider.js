class RacingProvider {
    constructor(options = {}) {
        this.name = options.name || 'base';
    }

    async getTodaysMeetings() {
        throw new Error(`${this.name} provider has not implemented getTodaysMeetings()`);
    }

    async getRacesForMeeting() {
        throw new Error(`${this.name} provider has not implemented getRacesForMeeting()`);
    }

    async getRunnersForRace() {
        throw new Error(`${this.name} provider has not implemented getRunnersForRace()`);
    }

    async getResultsForRace() {
        return [];
    }

    async getOddsForRace() {
        return [];
    }
}

function assertProvider(provider) {
    const requiredMethods = [
        'getTodaysMeetings',
        'getRacesForMeeting',
        'getRunnersForRace',
        'getResultsForRace',
        'getOddsForRace'
    ];

    for (const method of requiredMethods) {
        if (!provider || typeof provider[method] !== 'function') {
            throw new Error(`Racing provider is missing ${method}()`);
        }
    }

    return provider;
}

module.exports = { RacingProvider, assertProvider };
