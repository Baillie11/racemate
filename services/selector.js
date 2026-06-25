/**
 * Selection Engine v1
 * Scores runners, estimates probabilities, calculates EV, and makes recommendations
 */

const { settings, runners: runnersDb, selections: selectionsDb } = require('../db/database');

// Scoring weights (v1 - simple, explainable model)
const WEIGHTS = {
    form: 0.25,           // Recent form string
    barrier: 0.15,        // Barrier position
    weight: 0.10,         // Weight carried
    careerWinRate: 0.15,  // Career win percentage
    trackRecord: 0.10,    // Track-specific performance
    distanceRecord: 0.10, // Distance-specific performance
    recency: 0.10,        // Days since last run
    rating: 0.05          // Official rating if available
};

/**
 * Parse form string (e.g., "1x324" where x=10+, 0=unplaced)
 * Returns score 0-100 based on recent form
 */
function parseFormScore(formString) {
    if (!formString) return 50; // Neutral if no form
    
    const recent = formString.slice(0, 5); // Last 5 starts
    let score = 0;
    let weight = 1.0;
    
    for (const char of recent) {
        let position;
        if (char === 'x' || char === 'X') position = 10;
        else if (char === '0') position = 10;
        else position = parseInt(char) || 10;
        
        // Score based on position (1st=100, 2nd=80, 3rd=60, etc.)
        const posScore = Math.max(0, 100 - (position - 1) * 20);
        score += posScore * weight;
        weight *= 0.8; // More recent = more weight
    }
    
    // Normalize to 0-100
    const maxPossible = 100 * (1 + 0.8 + 0.64 + 0.512 + 0.4096);
    return (score / maxPossible) * 100;
}

/**
 * Score barrier position (favors inside barriers in sprints, middle barriers in distance)
 */
function scoreBarrier(barrier, fieldSize, distance) {
    if (!barrier || !fieldSize) return 50;
    
    const relativePosn = barrier / fieldSize;
    
    if (distance && distance <= 1200) {
        // Sprints: inside barriers preferred
        return 100 - (relativePosn * 50);
    } else if (distance && distance >= 2000) {
        // Distance: middle barriers preferred
        const idealPosn = 0.4;
        return 100 - Math.abs(relativePosn - idealPosn) * 100;
    } else {
        // Mid-distance: slight inside preference
        return 100 - (relativePosn * 30);
    }
}

/**
 * Score weight (lighter = better, with diminishing returns)
 */
function scoreWeight(weight, fieldWeights) {
    if (!weight || !fieldWeights || fieldWeights.length === 0) return 50;
    
    const minWeight = Math.min(...fieldWeights);
    const maxWeight = Math.max(...fieldWeights);
    const range = maxWeight - minWeight;
    
    if (range === 0) return 50;
    
    // Lower weight = higher score
    return 100 - ((weight - minWeight) / range) * 100;
}

/**
 * Calculate win rate score
 */
function scoreWinRate(wins, starts) {
    if (!starts || starts === 0) return 40;
    const rate = wins / starts;
    return Math.min(100, rate * 400); // 25% win rate = 100
}

/**
 * Score recency (prefer horses that have raced recently but not too recently)
 */
function scoreRecency(daysSinceLastRun) {
    if (!daysSinceLastRun) return 50;
    
    // Ideal: 14-28 days
    if (daysSinceLastRun >= 14 && daysSinceLastRun <= 28) return 100;
    if (daysSinceLastRun < 7) return 60; // Too fresh
    if (daysSinceLastRun < 14) return 80;
    if (daysSinceLastRun <= 42) return 70;
    if (daysSinceLastRun <= 60) return 50;
    return 30; // Long layoff
}

/**
 * Score official rating
 */
function scoreRating(rating, fieldRatings) {
    if (!rating || !fieldRatings || fieldRatings.length === 0) return 50;
    
    const maxRating = Math.max(...fieldRatings);
    const minRating = Math.min(...fieldRatings);
    const range = maxRating - minRating;
    
    if (range === 0) return 50;
    
    return ((rating - minRating) / range) * 100;
}

/**
 * Calculate composite score for a runner
 */
function calculateScore(runner, fieldData) {
    const scores = {};
    
    // Form score
    scores.form = parseFormScore(runner.form_string);
    
    // Barrier score
    scores.barrier = scoreBarrier(
        runner.barrier,
        fieldData.fieldSize,
        fieldData.distance
    );
    
    // Weight score
    scores.weight = scoreWeight(
        runner.weight,
        fieldData.weights
    );
    
    // Career win rate
    scores.careerWinRate = scoreWinRate(
        runner.career_wins,
        runner.career_starts
    );
    
    // Track record
    scores.trackRecord = scoreWinRate(
        runner.track_wins,
        runner.track_starts
    );
    
    // Distance record
    scores.distanceRecord = scoreWinRate(
        runner.distance_wins,
        runner.distance_starts
    );
    
    // Recency
    scores.recency = scoreRecency(runner.days_since_last_run);
    
    // Rating
    scores.rating = scoreRating(runner.rating, fieldData.ratings);
    
    // Calculate weighted composite
    let composite = 0;
    let dataCompleteness = 0;
    
    for (const [factor, weight] of Object.entries(WEIGHTS)) {
        const score = scores[factor];
        if (score !== 50) { // 50 is our "no data" neutral value
            dataCompleteness += weight;
        }
        composite += score * weight;
    }
    
    return {
        composite,
        components: scores,
        dataCompleteness
    };
}

/**
 * Convert scores to probability estimates (normalized across field)
 */
function scoresToProbabilities(scoredRunners) {
    // Use softmax-like transformation
    const total = scoredRunners.reduce((sum, r) => sum + Math.exp(r.score / 20), 0);
    
    return scoredRunners.map(r => ({
        ...r,
        prob_win: Math.exp(r.score / 20) / total,
        // Place probability: roughly 2-3x win probability (capped)
        prob_place: Math.min(0.95, (Math.exp(r.score / 20) / total) * 2.5)
    }));
}

/**
 * Calculate Expected Value
 * EV = p * (odds - 1) - (1 - p)
 */
function calculateEV(probability, odds) {
    if (!odds || odds <= 1) return null;
    return probability * (odds - 1) - (1 - probability);
}

/**
 * Check if runner meets betting thresholds
 */
function meetsThresholds(runner, settings_) {
    const targetROI = parseFloat(settings_.target_roi) || 1.20;
    const minConfidence = parseFloat(settings_.min_confidence) || 0.15;
    const dataThreshold = parseFloat(settings_.data_completeness_threshold) || 0.6;
    
    // Must have odds
    if (!runner.odds_win) {
        return { meets: false, reason: 'Missing win odds' };
    }
    
    // Data completeness check
    if (runner.dataCompleteness < dataThreshold) {
        return { 
            meets: false, 
            reason: `Insufficient data (${(runner.dataCompleteness * 100).toFixed(0)}% < ${(dataThreshold * 100).toFixed(0)}% required)` 
        };
    }
    
    // Confidence check (probability)
    if (runner.prob_win < minConfidence) {
        return { 
            meets: false, 
            reason: `Low confidence (${(runner.prob_win * 100).toFixed(1)}% < ${(minConfidence * 100).toFixed(0)}% required)` 
        };
    }
    
    // ROI check
    const impliedProb = 1 / runner.odds_win;
    const expectedROI = runner.prob_win / impliedProb;
    
    if (expectedROI < targetROI) {
        return { 
            meets: false, 
            reason: `Insufficient value (${(expectedROI * 100).toFixed(0)}% ROI < ${(targetROI * 100).toFixed(0)}% target)` 
        };
    }
    
    return { meets: true, expectedROI };
}

/**
 * Generate explanation object for a selection
 */
function generateExplanation(runner, thresholdResult, allRunners) {
    const explanation = {
        factors: [],
        probabilities: {
            win: runner.prob_win,
            place: runner.prob_place
        },
        odds: {
            win: runner.odds_win,
            place: runner.odds_place
        },
        ev: {
            win: runner.ev_win,
            place: runner.ev_place
        },
        thresholds: thresholdResult,
        ranking: {
            position: allRunners.findIndex(r => r.id === runner.id) + 1,
            totalRunners: allRunners.length
        }
    };
    
    // Add top factors (sorted by impact)
    const components = runner.components;
    const factorScores = Object.entries(components)
        .map(([factor, score]) => ({
            factor,
            score,
            weight: WEIGHTS[factor],
            impact: (score - 50) * WEIGHTS[factor], // Deviation from neutral
            description: getFactorDescription(factor, score)
        }))
        .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
        .slice(0, 6);
    
    explanation.factors = factorScores;
    
    return explanation;
}

function getFactorDescription(factor, score) {
    const descriptions = {
        form: score > 70 ? 'Strong recent form' : score < 30 ? 'Poor recent form' : 'Average form',
        barrier: score > 70 ? 'Favorable barrier' : score < 30 ? 'Difficult barrier' : 'Neutral barrier',
        weight: score > 70 ? 'Light weight advantage' : score < 30 ? 'Weight disadvantage' : 'Average weight',
        careerWinRate: score > 70 ? 'High career win rate' : score < 30 ? 'Low career win rate' : 'Average win rate',
        trackRecord: score > 70 ? 'Good track record' : score < 30 ? 'Poor track record' : 'Limited track data',
        distanceRecord: score > 70 ? 'Suited to distance' : score < 30 ? 'Distance concern' : 'Adequate at distance',
        recency: score > 70 ? 'Ideal racing gap' : score < 30 ? 'Layoff concern' : 'Acceptable freshness',
        rating: score > 70 ? 'Top-rated in field' : score < 30 ? 'Low rating' : 'Mid-range rating'
    };
    return descriptions[factor] || 'Unknown factor';
}

/**
 * Main selection function for a race
 */
async function selectForRace(raceId, raceData, userId = null) {
    const runnersData = runnersDb.getByRace(raceId)
        .filter(r => !r.scratched);
    
    if (runnersData.length === 0) {
        return { 
            recommendation: null, 
            status: 'no_data', 
            reason: 'No runners available' 
        };
    }
    
    // Prepare field data for scoring
    const fieldData = {
        fieldSize: runnersData.length,
        distance: raceData?.distance,
        weights: runnersData.map(r => r.weight).filter(Boolean),
        ratings: runnersData.map(r => r.rating).filter(Boolean)
    };
    
    // Score all runners
    let scoredRunners = runnersData.map(runner => {
        const { composite, components, dataCompleteness } = calculateScore(runner, fieldData);
        return {
            ...runner,
            score: composite,
            components,
            dataCompleteness
        };
    });
    
    // Convert to probabilities
    scoredRunners = scoresToProbabilities(scoredRunners);
    
    // Calculate EV
    scoredRunners = scoredRunners.map(r => ({
        ...r,
        ev_win: calculateEV(r.prob_win, r.odds_win),
        ev_place: calculateEV(r.prob_place, r.odds_place)
    }));
    
    // Sort by score descending
    scoredRunners.sort((a, b) => b.score - a.score);
    
    // Get settings for threshold checks
    const settings_ = settings.getAll(userId);
    
    // Find top runner that meets thresholds
    let recommendation = null;
    let status = 'skip';
    let skipReasons = [];
    
    for (const runner of scoredRunners) {
        const thresholdResult = meetsThresholds(runner, settings_);
        
        if (thresholdResult.meets) {
            const explanation = generateExplanation(runner, thresholdResult, scoredRunners);
            recommendation = {
                runner_id: runner.id,
                horse_name: runner.horse_name,
                saddle_no: runner.saddle_no,
                score: runner.score,
                prob_win_est: runner.prob_win,
                prob_place_est: runner.prob_place,
                odds_win: runner.odds_win,
                odds_place: runner.odds_place,
                ev_win: runner.ev_win,
                ev_place: runner.ev_place,
                explanation
            };
            status = 'bet';
            break;
        } else {
            const runnerLabel = `${runner.saddle_no || '?'}. ${runner.horse_name}`;
            skipReasons.push(`${runnerLabel}: ${thresholdResult.reason}`);
        }
    }
    
    // Store selections in DB
    selectionsDb.deleteByRace(raceId, userId);
    
    for (const runner of scoredRunners) {
        const thresholdResult = meetsThresholds(runner, settings_);
        const isRecommended = recommendation?.runner_id === runner.id;
        
        selectionsDb.create({
            user_id: userId,
            race_id: raceId,
            runner_id: runner.id,
            model_version: 'v1',
            score: runner.score,
            prob_win_est: runner.prob_win,
            prob_place_est: runner.prob_place,
            odds_win: runner.odds_win,
            odds_place: runner.odds_place,
            ev_win: runner.ev_win,
            ev_place: runner.ev_place,
            recommendation_status: isRecommended ? 'bet' : 'skip',
            explanation: isRecommended ? recommendation.explanation : { 
                reason: thresholdResult.reason,
                score: runner.score 
            }
        });
    }
    
    return {
        recommendation,
        status,
        allSelections: scoredRunners.map(r => ({
            runner_id: r.id,
            horse_name: r.horse_name,
            saddle_no: r.saddle_no,
            score: r.score,
            prob_win: r.prob_win,
            ev_win: r.ev_win
        })),
        skipReasons: status === 'skip' ? skipReasons.slice(0, 3) : []
    };
}

module.exports = {
    selectForRace,
    calculateScore,
    parseFormScore,
    scoresToProbabilities,
    calculateEV,
    meetsThresholds,
    WEIGHTS
};
