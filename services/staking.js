/**
 * Staking Calculator
 * Implements flat percentage and conservative Kelly criterion
 */

const { settings, transactions } = require('../db/database');

/**
 * Calculate flat percentage stake
 * @param {number} bankroll - Current bankroll
 * @param {number} stakePercent - Percentage of bankroll (e.g., 0.02 = 2%)
 * @returns {number} Stake amount
 */
function calculateFlatStake(bankroll, stakePercent) {
    return bankroll * stakePercent;
}

/**
 * Calculate Kelly Criterion stake
 * Kelly = (bp - q) / b
 * where:
 *   b = odds - 1 (decimal odds to 1)
 *   p = probability of winning
 *   q = 1 - p (probability of losing)
 * 
 * We use fractional Kelly (e.g., 0.25 Kelly) for conservative approach
 */
function calculateKellyStake(bankroll, probability, odds, kellyFraction = 0.25) {
    if (!probability || !odds || odds <= 1) return 0;
    
    const b = odds - 1;
    const p = probability;
    const q = 1 - p;
    
    // Full Kelly
    const fullKelly = (b * p - q) / b;
    
    // If Kelly is negative, don't bet
    if (fullKelly <= 0) return 0;
    
    // Apply fraction and bankroll
    return bankroll * fullKelly * kellyFraction;
}

/**
 * Main stake calculation function
 * Returns recommended stakes for win and place bets
 */
function calculateStakes(selection, bankroll = null) {
    const settings_ = settings.getAll();
    
    // Get current bankroll if not provided
    if (bankroll === null) {
        bankroll = transactions.getBankroll();
    }
    
    const stakingMode = settings_.staking_mode || 'flat';
    const stakePercent = parseFloat(settings_.stake_percent) || 0.02;
    const kellyFraction = parseFloat(settings_.kelly_fraction) || 0.25;
    const maxStake = parseFloat(settings_.max_stake_per_race) || 100;
    const minBankrollFloor = parseFloat(settings_.min_bankroll_floor) || 5;
    
    // Check if bankroll is below floor
    if (bankroll <= minBankrollFloor) {
        return {
            stake_win: 0,
            stake_place: 0,
            reason: 'Bankroll below minimum floor',
            bankroll
        };
    }
    
    // Calculate total stake for the race
    let totalStake;
    
    if (stakingMode === 'kelly') {
        // Use Kelly for win bet, derive place from it
        const winStake = calculateKellyStake(
            bankroll,
            selection.prob_win_est,
            selection.odds_win,
            kellyFraction
        );
        
        const placeStake = selection.odds_place ? 
            calculateKellyStake(
                bankroll,
                selection.prob_place_est,
                selection.odds_place,
                kellyFraction
            ) : 0;
        
        totalStake = winStake + placeStake;
    } else {
        // Flat percentage
        totalStake = calculateFlatStake(bankroll, stakePercent);
    }
    
    // Apply max stake cap
    totalStake = Math.min(totalStake, maxStake);
    
    // Split between win and place (60/40 default, or adjusted based on EV)
    let winRatio = 0.6;
    let placeRatio = 0.4;
    
    // Adjust ratio based on EV comparison
    if (selection.ev_win !== null && selection.ev_place !== null) {
        const evTotal = Math.max(0.01, Math.abs(selection.ev_win) + Math.abs(selection.ev_place));
        
        if (selection.ev_win > 0 && selection.ev_place > 0) {
            winRatio = Math.max(0.3, Math.min(0.8, selection.ev_win / evTotal));
            placeRatio = 1 - winRatio;
        } else if (selection.ev_win > 0 && selection.ev_place <= 0) {
            winRatio = 1;
            placeRatio = 0;
        } else if (selection.ev_win <= 0 && selection.ev_place > 0) {
            winRatio = 0;
            placeRatio = 1;
        }
    }
    
    // If no place odds, put everything on win
    if (!selection.odds_place) {
        winRatio = 1;
        placeRatio = 0;
    }
    
    const stake_win = Math.round(totalStake * winRatio * 100) / 100;
    const stake_place = Math.round(totalStake * placeRatio * 100) / 100;
    
    return {
        stake_win,
        stake_place,
        total_stake: stake_win + stake_place,
        bankroll,
        stakingMode,
        breakdown: {
            winRatio,
            placeRatio,
            maxStake,
            stakePercent: stakingMode === 'flat' ? stakePercent : null,
            kellyFraction: stakingMode === 'kelly' ? kellyFraction : null
        }
    };
}

/**
 * Check risk controls before placing bet
 */
function checkRiskControls(stakeAmount) {
    const settings_ = settings.getAll();
    const bankroll = transactions.getBankroll();
    const today = new Date().toISOString().split('T')[0];
    const dailyLoss = transactions.getDailyLoss(today);
    
    const maxStake = parseFloat(settings_.max_stake_per_race) || 100;
    const maxDailyLoss = parseFloat(settings_.max_daily_loss) || 200;
    const minBankrollFloor = parseFloat(settings_.min_bankroll_floor) || 5;
    
    const issues = [];
    
    // Check max stake
    if (stakeAmount > maxStake) {
        issues.push({
            type: 'max_stake',
            message: `Stake $${stakeAmount} exceeds max $${maxStake}`,
            severity: 'warning'
        });
    }
    
    // Check daily loss limit
    if (dailyLoss >= maxDailyLoss) {
        issues.push({
            type: 'daily_loss',
            message: `Daily loss limit reached ($${dailyLoss} / $${maxDailyLoss})`,
            severity: 'block'
        });
    } else if (dailyLoss + stakeAmount > maxDailyLoss) {
        issues.push({
            type: 'daily_loss',
            message: `Bet would exceed daily loss limit`,
            severity: 'warning'
        });
    }
    
    // Check bankroll floor
    if (bankroll <= minBankrollFloor) {
        issues.push({
            type: 'bankroll_floor',
            message: `Bankroll is $${bankroll.toFixed(2)} and your minimum floor is $${minBankrollFloor.toFixed(2)}. Any bet would take you below the floor.`,
            severity: 'block'
        });
    } else if (bankroll - stakeAmount < minBankrollFloor) {
        const projected = bankroll - stakeAmount;
        issues.push({
            type: 'bankroll_floor',
            message: `Bet would reduce bankroll to $${projected.toFixed(2)}, below your minimum floor of $${minBankrollFloor.toFixed(2)}.`,
            severity: 'block'
        });
    }
    
    const canBet = !issues.some(i => i.severity === 'block');
    
    return {
        canBet,
        issues,
        bankroll,
        dailyLoss,
        remainingDailyBudget: Math.max(0, maxDailyLoss - dailyLoss)
    };
}

/**
 * Calculate potential payouts
 */
function calculatePayouts(stakeWin, stakePlace, oddsWin, oddsPlace) {
    return {
        win_returns: stakeWin * (oddsWin || 0),
        place_returns: stakePlace * (oddsPlace || 0),
        total_if_win: stakeWin * (oddsWin || 0) + stakePlace * (oddsPlace || 0),
        total_if_place: stakePlace * (oddsPlace || 0),
        total_if_lose: 0,
        total_stake: stakeWin + stakePlace
    };
}

module.exports = {
    calculateStakes,
    calculateFlatStake,
    calculateKellyStake,
    checkRiskControls,
    calculatePayouts
};
