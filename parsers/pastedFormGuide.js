/**
 * Pasted Form Guide Parser
 * Converts pasted markdown/plain-text race snippets into import records.
 */

function normalizeName(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function titleCaseFromSlug(slug) {
    return String(slug || '')
        .split('-')
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
        .trim();
}

function parseDateFromYYYYMMDD(raw) {
    if (!/^\d{8}$/.test(raw || '')) return null;
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

    function getCurrentDateISO() {
        return new Date().toISOString().split('T')[0];
    }

function inferStateFromTrack(track, tracksByState = {}) {
    const wanted = normalizeName(track);
    for (const stateCode of Object.keys(tracksByState)) {
        const list = tracksByState[stateCode] || [];
        const hit = list.some(name => normalizeName(name) === wanted);
        if (hit) return stateCode;
    }

    // Fallback hints for common tracks when source list is incomplete.
    const hints = [
        { state: 'TAS', pattern: /hobart|launceston|devonport|elwick/i },
        { state: 'WA', pattern: /ascot|belmont|pinjarra|kalgoorlie|bunbury|narrogin|broome|northam/i },
        { state: 'SA', pattern: /morphettville|gawler|balaklava|strathalbyn|mt gambier|mount gambier/i },
        { state: 'NT', pattern: /darwin|fannie bay|alice springs/i },
        { state: 'ACT', pattern: /canberra/i }
    ];

    for (const hint of hints) {
        if (hint.pattern.test(track || '')) {
            return hint.state;
        }
    }

    return null;
}

function inferTrackFromText(text, tracksByState = {}) {
    const lines = String(text || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

    for (const line of lines.slice(0, 12)) {
        const exactState = inferStateFromTrack(line, tracksByState);
        if (exactState) {
            return line;
        }
    }

    return null;
}

function readValueAfterLabel(lines, label, startIndex = 0) {
    const labelRegex = new RegExp(`^${label}\\s*:?[\\s]*(.*)$`, 'i');

    for (let i = startIndex; i < lines.length; i++) {
        const match = lines[i].match(labelRegex);
        if (!match) continue;

        const inlineValue = (match[1] || '').trim();
        if (inlineValue) return inlineValue;

        for (let j = i + 1; j < lines.length; j++) {
            const value = lines[j].trim();
            if (value) return value;
        }
    }

    return null;
}

function parseDaysSinceLastRun(chunk) {
    const weekMatch = chunk.match(/(\d+)\s*Weeks?/i);
    if (weekMatch) return parseInt(weekMatch[1], 10) * 7;

    const dayMatch = chunk.match(/(\d+)\s*Days?/i);
    if (dayMatch) return parseInt(dayMatch[1], 10);

    return null;
}

function parseWeightFromJockey(jockeyText) {
    const weightMatch = String(jockeyText || '').match(/(\d+(?:\.\d+)?)\s*kg/i);
    return weightMatch ? parseFloat(weightMatch[1]) : null;
}

function parseCareerStats(chunk) {
    const match = chunk.match(/\n\s*(\d+)\s*:\s*(\d+)\s*-\s*(\d+)\s*-\s*(\d+)\s*\n/);
    if (!match) {
        return { career_starts: 0, career_wins: 0, career_places: 0 };
    }

    return {
        career_starts: parseInt(match[1], 10) || 0,
        career_wins: parseInt(match[2], 10) || 0,
        career_places: parseInt(match[3], 10) || 0
    };
}

function parseFormString(chunk) {
    const lines = chunk.split('\n').map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
        if (/^[0-9xX\-]{2,20}$/.test(line)) {
            return line;
        }
    }
    return null;
}

function parseOdds(chunk) {
    // Ignore prize-money style values like "$251K" and prefer market odds strings.
    const matches = [...chunk.matchAll(/\$(\d+(?:\.\d+)?)(?!\s*[KMBkmb])/g)];
    if (matches.length === 0) {
        return { odds_win: null, odds_place: null };
    }

    const odds = matches
        .map(m => parseFloat(m[1]))
        .filter(v => Number.isFinite(v) && v > 1);

    if (odds.length === 0) {
        return { odds_win: null, odds_place: null };
    }

    return {
        // Bookmaker price is usually the last odds token within a runner block.
        odds_win: odds[odds.length - 1] || null,
        odds_place: odds[1] || null
    };
}

function parseRunnerChunks(text) {
    const runnerHeaderRegex = /(^|\n)\s*(?:\[(?<num1>\d+)\.\s*(?<name1>[^\]]+)\]\([^)]*\)\((?<bar1>\d+)\)|(?<num2>\d+)\.\s*(?<name2>[^\n(]+?)\s*\((?<bar2>\d+)\))/g;
    const matches = [...text.matchAll(runnerHeaderRegex)];
    const chunks = [];

    for (let i = 0; i < matches.length; i++) {
        const current = matches[i];
        const next = matches[i + 1];
        const prefix = current[1] || '';
        const start = (current.index || 0) + prefix.length;
        const end = next ? next.index : text.length;
        const groups = current.groups || {};

        const saddle_no = parseInt(groups.num1 || groups.num2, 10);
        const horse_name = String(groups.name1 || groups.name2 || '').trim();
        const barrier = parseInt(groups.bar1 || groups.bar2, 10);

        if (!Number.isFinite(saddle_no) || !horse_name || !Number.isFinite(barrier)) {
            continue;
        }

        chunks.push({
            saddle_no,
            horse_name,
            barrier,
            chunk: text.slice(start, end)
        });
    }

    return chunks;
}

function parseMeetingMeta(text, tracksByState) {
    const raceUrlMatch = text.match(/\/form-guide\/horse-racing\/([^/]+?)(?:-(\d{8}))?\/[^/]+?\//i);
    if (!raceUrlMatch) {
        const inferredTrack = inferTrackFromText(text, tracksByState);
        const inferredState = inferStateFromTrack(inferredTrack, tracksByState);
        const longDateMatch = text.match(/(?:Sunday|Saturday|Monday|Tuesday|Wednesday|Thursday|Friday)\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
        const date = parseDateFromLongText(longDateMatch ? `${longDateMatch[1]} ${longDateMatch[2]} ${longDateMatch[3]}` : null) || getCurrentDateISO();

        if (inferredTrack) {
            return {
                date,
                track: inferredTrack,
                state: inferredState || 'VIC'
            };
        }

        throw new Error('Could not detect the meeting track in pasted text. Please include the track name and race header when pasting.');
    }

    const trackSlug = raceUrlMatch[1];
    const yyyymmdd = raceUrlMatch[2];

    const date = parseDateFromYYYYMMDD(yyyymmdd) || getCurrentDateISO();

    const track = titleCaseFromSlug(trackSlug);
    const inferredState = inferStateFromTrack(track, tracksByState);

    return {
        date,
        track,
        state: inferredState || 'VIC'
    };
}

function normalizeStartTime(value) {
    const match = String(value || '').trim().match(/^(\d{1,2}):([0-5]\d)$/);
    if (!match) return null;

    const hour = parseInt(match[1], 10);
    if (hour < 0 || hour > 23) return null;

    return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

function parseRaceStartTime(text, raceNo) {
    const lines = String(text || '')
        .split('\n')
        .map(line => line.trim());
    const raceHeaderPattern = new RegExp(`^(?:##\\s*)?R\\s*${raceNo}\\b`, 'i');
    const raceHeaderIndex = lines.findIndex(line => raceHeaderPattern.test(line));

    if (raceHeaderIndex >= 0) {
        for (const line of lines.slice(raceHeaderIndex + 1, raceHeaderIndex + 14)) {
            const explicitTime = normalizeStartTime(line);
            if (explicitTime) return explicitTime;
            if (/^(?:Tips & Race Analysis|Field|Form)$/i.test(line)) break;
        }
    }

    // Some copied meeting headers use three lines: "R", race number, then time.
    for (let i = 0; i < lines.length - 2; i++) {
        if (/^R$/i.test(lines[i]) && parseInt(lines[i + 1], 10) === raceNo) {
            const explicitTime = normalizeStartTime(lines[i + 2]);
            if (explicitTime) return explicitTime;
        }
    }

    // Other sources keep the race number and time on one line.
    const inlinePattern = new RegExp(`^R\\s*${raceNo}\\s+(\\d{1,2}:[0-5]\\d)$`, 'i');
    for (const line of lines) {
        const inlineMatch = line.match(inlinePattern);
        const explicitTime = inlineMatch ? normalizeStartTime(inlineMatch[1]) : null;
        if (explicitTime) return explicitTime;
    }

    return null;
}

function parseRaceMeta(text) {
    const raceMatch = text.match(/^##\s*R(\d+)\s+(.+)$/m) || text.match(/^R(\d+)\s+(.+)$/m);
    if (!raceMatch) {
        throw new Error('Could not detect race number/name header (e.g. ## R5 Race Name).');
    }

    const distanceMatch = text.match(/(\d{3,4})m/i);
    const classMatch = text.match(/Class\s*:\s*([^\n\r]+)/i);
    const raceNo = parseInt(raceMatch[1], 10);

    return {
        race_no: raceNo,
        race_name: raceMatch[2].trim(),
        start_time: parseRaceStartTime(text, raceNo),
        distance: distanceMatch ? parseInt(distanceMatch[1], 10) : null,
        race_class: classMatch ? classMatch[1].trim() : null
    };
}

function parseResultsStyleMeta(text) {
    const raceHeaderMatch = text.match(/^R(\d+)\s+(.+)$/m) || text.match(/^R(\d+)\s+(.+)$/i);
    if (!raceHeaderMatch) {
        return null;
    }

    const lines = text.split('\n').map(line => line.trim());
    const race_no = parseInt(raceHeaderMatch[1], 10);
    const race_name = raceHeaderMatch[2].trim();
    const distanceMatch = text.match(/(\d{3,4})m/i);
    const raceHeaderIndex = lines.findIndex(line => line === raceHeaderMatch[0]);
    const raceLines = raceHeaderIndex >= 0 ? lines.slice(raceHeaderIndex) : lines;
    const raceBlock = raceLines.join('\n');
    const trackProfileMatch = text.match(/Track Profile:\s*([^\n\r]+)/i);
    const dateMatch = text.match(/(?:Sunday|Saturday|Monday|Tuesday|Wednesday|Thursday|Friday)\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);

    return {
        race_no,
        race_name,
        start_time: parseRaceStartTime(text, race_no),
        distance: distanceMatch ? parseInt(distanceMatch[1], 10) : null,
        race_class: readValueAfterLabel(raceLines, 'Class') || null,
        track: trackProfileMatch ? trackProfileMatch[1].trim() : null,
        track_condition: raceBlock.match(/\b(?:Firm|Good|Soft|Heavy|Synthetic)\s+\d+\b/i)?.[0] || text.match(/\b(?:Firm|Good|Soft|Heavy|Synthetic)\s+\d+\b/i)?.[0] || null,
        dateText: dateMatch ? `${dateMatch[1]} ${dateMatch[2]} ${dateMatch[3]}` : null
    };
}

function parseDateFromLongText(dateText) {
    if (!dateText) return null;
    const match = dateText.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
    if (!match) return null;

    const day = String(parseInt(match[1], 10)).padStart(2, '0');
    const monthMap = {
        january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
        july: '07', august: '08', september: '09', october: '10', november: '11', december: '12'
    };
    const month = monthMap[match[2].toLowerCase()];
    if (!month) return null;

    return `${match[3]}-${month}-${day}`;
}

function parseResultsPlacings(text) {
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    const placings = [];

    for (let i = 0; i < lines.length; i++) {
        const runnerMatch = lines[i].match(/^(\d+)\.\s*(.+)$/);
        if (!runnerMatch) continue;

        const saddle_no = parseInt(runnerMatch[1], 10);
        const horse_name = runnerMatch[2].replace(/\s*\([^)]*\)\s*$/, '').trim();
        const nextLine = lines[i + 1] || '';
        const resultMatch = nextLine.match(/^(1st|2nd|3rd)$/i);
        if (resultMatch) {
            placings.push({
                saddle_no,
                horse_name,
                position: resultMatch[1].toLowerCase().startsWith('1') ? 1 : resultMatch[1].toLowerCase().startsWith('2') ? 2 : 3
            });
        }
    }

    return placings;
}

function parsePastedFormGuide(text, tracksByState = {}) {
    const input = String(text || '').replace(/\r\n/g, '\n');

    if (!input.trim()) {
        throw new Error('Paste data is empty.');
    }

    let meeting;
    let race;
    let runnerChunks = parseRunnerChunks(input);
    let resultsPlacings = [];

    try {
        meeting = parseMeetingMeta(input, tracksByState);
        race = parseRaceMeta(input);
    } catch (err) {
        const resultsMeta = parseResultsStyleMeta(input);
        if (!resultsMeta) {
            throw err;
        }

        const inferredTrack = resultsMeta.track || inferTrackFromText(input, tracksByState);
        const inferredState = inferStateFromTrack(inferredTrack, tracksByState);
        const date = parseDateFromLongText(resultsMeta.dateText);

        meeting = {
            date,
            track: inferredTrack || 'Unknown',
            state: inferredState || 'VIC'
        };

        race = {
            race_no: resultsMeta.race_no,
            race_name: resultsMeta.race_name,
            start_time: resultsMeta.start_time,
            distance: resultsMeta.distance,
            race_class: resultsMeta.race_class,
            track_condition: resultsMeta.track_condition
        };

        resultsPlacings = parseResultsPlacings(input);
    }

    meeting.date = meeting.date || getCurrentDateISO();

    if (runnerChunks.length === 0 && resultsPlacings.length === 0) {
        throw new Error('No runners found in pasted text.');
    }

    const records = runnerChunks.map(({ saddle_no, horse_name, barrier, chunk }) => {
        const chunkLines = chunk.split('\n').map(line => line.trim());
        const trainerMatch = chunk.match(/\n\s*T:\[([^\]]+)\]/i);
        const jockeyMatch = chunk.match(/\n\s*J:\[([^\]]+)\]/i);
        const trainer = trainerMatch ? trainerMatch[1].trim() : readValueAfterLabel(chunkLines, 'T');
        const jockey = jockeyMatch ? jockeyMatch[1].trim() : readValueAfterLabel(chunkLines, 'J');

        const { career_starts, career_wins, career_places } = parseCareerStats(chunk);
        const { odds_win, odds_place } = parseOdds(chunk);

        return {
            date: meeting.date,
            state: meeting.state,
            track: meeting.track,
            race_no: race.race_no,
            race_name: race.race_name,
            start_time: race.start_time || null,
            distance: race.distance,
            track_condition: race.track_condition || null,
            race_class: race.race_class,
            prize_money: null,
            saddle_no,
            horse_name,
            barrier,
            weight: parseWeightFromJockey(jockey),
            jockey,
            trainer,
            form_string: parseFormString(chunk),
            career_wins,
            career_places,
            career_starts,
            track_wins: 0,
            track_starts: 0,
            distance_wins: 0,
            distance_starts: 0,
            rating: null,
            days_since_last_run: parseDaysSinceLastRun(chunk),
            odds_win,
            odds_place
        };
    });

    return {
        meeting,
        race,
        records,
        resultsPlacings
    };
}

module.exports = {
    parsePastedFormGuide,
    inferStateFromTrack,
    parseRaceStartTime
};
