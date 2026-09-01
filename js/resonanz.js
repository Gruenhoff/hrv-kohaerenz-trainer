/**
 * Kalibrierung des optimalen Atemrhythmus – 3 Protokolle
 *
 *  1  FrequencyTest – Frequenz-Scan (ersetzt alten Grob-/Fein-Scan)
 *     Phase 1 (Grobsieb): 15 Kandidaten 4,5–8,0 Atemz/min (0,25-Schritte),
 *       je 6 Atemzyklen zyklus-ausgerichtete HRmax−HRmin-Messung (2 verworfen
 *       zur Einschwingung, getrimmter Mittelwert der mittleren 2 von 4).
 *       Parabel-Glättung über alle 15 Rohwerte, Top 5 nach geglättetem Wert.
 *     Phase 2 (Feinvalidierung): 5 Finalisten × (1 Min Einschwingung + 2 Min
 *       RMSSD-Messung). Entscheidung: RMSSD primär, Kohärenz-Score als
 *       Tiebreaker bei < 5 % RMSSD-Differenz.
 *     ⏱ ca. 31 Minuten.
 *
 *  2  RhythmTest – Verhältnis & Pausen bei der Protokoll-1-Optimalfrequenz
 *     Zyklusdauer bleibt fix (Pausen werden kompensiert, kein Frequenz-Drift).
 *     Stufe A: Ein:Aus-Verhältnis (5 Kandidaten, 35:65…55:45).
 *     Stufe B: Pausen – Grobscan (6 Muster: kein Halt/Halt-Ein/Halt-Aus/beide)
 *       → Feinabstimmung 3×3-Gitter (Halt-Ein × Halt-Aus unabhängig, ±0,3s).
 *     Je Kandidat 8 Atemzyklen (2 verworfen, getrimmter Mittelwert der
 *     RMSSD-Stichproben), Kohärenz-Score als zweite Stimme.
 *     ⏱ ca. 27 Minuten.
 *
 *  3  DailyCheck – 5-Minuten-Check vor der Trainingssession
 *     5 Kandidaten: gespeicherte Frequenz ±1,0 Atemz/min (0,5-Schritte),
 *     gleiches 6-Zyklen-Fenster wie Protokoll 1, keine Glättung.
 *     Ergebnis wird gedämpft übernommen (0,8·alt + 0,2·neu). Nur die Frequenz
 *     wird angepasst – Verhältnis/Pausen aus Protokoll 2 bleiben strukturell
 *     erhalten (proportionale Skalierung des gespeicherten Rhythmus).
 *     ⏱ ca. 5 Minuten, einmal pro Tag (manuelle Override-Option).
 */

// ─── Konstanten ──────────────────────────────────────────────────────────────

const GRID_START = 4.5, GRID_END = 8.0, GRID_STEP = 0.25;
const PHASE1_CYCLES = 6, PHASE1_DISCARD = 2;
const TOP_N = 5;
const PHASE2_ACCLIM_SEC = 60, PHASE2_MEASURE_SEC = 120;
const STAGE_CYCLES = 8, STAGE_DISCARD = 2;
const DAILY_OFFSETS = [-1.0, -0.5, 0, 0.5, 1.0];
const RMSSD_SAMPLE_MS = 10000;
const TIEBREAK_MARGIN = 0.95; // RMSSD ≥ 95% des Maximums gilt als "knapp"

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

export class CancelledError extends Error {}

function bpmToCycleMs(bpm) {
    return Math.round(60000 / bpm);
}

function buildFrequencyGrid() {
    const n = Math.round((GRID_END - GRID_START) / GRID_STEP);
    return Array.from({ length: n + 1 }, (_, i) => Math.round((GRID_START + i * GRID_STEP) * 100) / 100);
}

function symmetricRhythm(bpm) {
    const cycleMs = bpmToCycleMs(bpm);
    const half = Math.round(cycleMs / 2);
    return { inhale: half, holdIn: 0, exhale: cycleMs - half, holdOut: 0 };
}

/** Getrimmter Mittelwert: höchsten und niedrigsten Wert verwerfen, Rest mitteln. */
function trimmedMean(values) {
    if (!values.length) return 0;
    if (values.length <= 2) return values.reduce((a, b) => a + b, 0) / values.length;
    const sorted = [...values].sort((a, b) => a - b);
    const trimmed = sorted.slice(1, -1);
    return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

/** Kleinste-Quadrate-Parabel y = a·x² + b·x + c durch die Punkte (xs, ys). */
function quadraticFit(xs, ys) {
    const n = xs.length;
    let sx = 0, sx2 = 0, sx3 = 0, sx4 = 0, sy = 0, sxy = 0, sx2y = 0;
    for (let i = 0; i < n; i++) {
        const x = xs[i], y = ys[i], x2 = x * x;
        sx += x; sx2 += x2; sx3 += x2 * x; sx4 += x2 * x2;
        sy += y; sxy += x * y; sx2y += x2 * y;
    }
    const A = [[n, sx, sx2], [sx, sx2, sx3], [sx2, sx3, sx4]];
    const B = [sy, sxy, sx2y];
    const det = m =>
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
        m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
        m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(A);
    if (Math.abs(D) < 1e-9) return { a: 0, b: 0, c: n ? sy / n : 0 };
    const withCol = (col, vec) => A.map((row, i) => row.map((v, j) => j === col ? vec[i] : v));
    return { c: det(withCol(0, B)) / D, b: det(withCol(1, B)) / D, a: det(withCol(2, B)) / D };
}

/** Sieger nach RMSSD (primär), Kohärenz-Score als Tiebreaker bei < 5% Differenz. */
function pickWinner(results) {
    const maxRmssd = Math.max(...results.map(r => r.avgRmssd));
    const close = results.filter(r => r.avgRmssd >= maxRmssd * TIEBREAK_MARGIN);
    if (close.length > 1) {
        return close.reduce((best, r) => r.coherenceScore > best.coherenceScore ? r : best);
    }
    return results.find(r => r.avgRmssd === maxRmssd);
}

/** Pausen-Muster kompensiert bauen: Gesamtzyklus bleibt fix, Ein:Aus-Anteil bleibt erhalten. */
function buildPausePattern(baseInhale, baseExhale, cycleMs, holdIn, holdOut) {
    const ratio = baseInhale / (baseInhale + baseExhale);
    const available = Math.max(1000, cycleMs - holdIn - holdOut);
    const inhale = Math.round(available * ratio / 100) * 100;
    const exhale = available - inhale;
    return { inhale, holdIn, exhale, holdOut };
}

export function rhythmToString(r) {
    if (!r) return '—';
    const s = ms => (ms / 1000).toFixed(1) + ' s';
    const parts = [s(r.inhale)];
    if (r.holdIn) parts.push(`H-In ${s(r.holdIn)}`);
    parts.push(s(r.exhale));
    if (r.holdOut) parts.push(`H-Out ${s(r.holdOut)}`);
    return parts.join(' / ');
}

// ─── Basisklasse: Phasenwechsel-Warteschlange + Mess-Engines ────────────────

class CalibrationTestBase {
    /**
     * @param {import('./hrv.js').HRVAnalyzer} hrv
     * @param {import('./database.js').Database} db
     */
    constructor(hrv, db) {
        this.hrv = hrv;
        this.db = db;
        this._active = false;
        this._phaseWaiters = [];
        this._waitTimer = null;

        // Callbacks (von app.js gesetzt)
        this.onRhythmChange = null;   // (rhythm) => void – app.js startet neuen BreathPacer
        this.onCancelled    = null;   // () => void
    }

    get active() { return this._active; }

    stop() {
        this._active = false;
        clearTimeout(this._waitTimer);
        if (this._waitReject) {
            const reject = this._waitReject;
            this._waitReject = null;
            reject(new CancelledError());
        }
        const waiters = this._phaseWaiters;
        this._phaseWaiters = [];
        waiters.forEach(w => w.reject(new CancelledError()));
    }

    /** Von app.js bei jedem BreathPacer.onPhaseChange aufzurufen. */
    notifyPhaseChange(phase) {
        if (!this._phaseWaiters.length) return;
        const evt = { phase, ts: performance.now() };
        const waiters = this._phaseWaiters;
        this._phaseWaiters = [];
        waiters.forEach(w => w.resolve(evt));
    }

    _nextPhaseEvent() {
        if (!this._active) return Promise.reject(new CancelledError());
        return new Promise((resolve, reject) => {
            this._phaseWaiters.push({ resolve, reject });
        });
    }

    async _waitUntilPhase(target) {
        for (;;) {
            const evt = await this._nextPhaseEvent();
            if (evt.phase === target) return evt;
        }
    }

    _wait(ms) {
        if (!this._active) return Promise.reject(new CancelledError());
        return new Promise((resolve, reject) => {
            this._waitReject = reject;
            this._waitTimer = setTimeout(() => {
                this._waitReject = null;
                resolve();
            }, ms);
        });
    }

    /**
     * Zyklus-ausgerichtete HRmax−HRmin-Messung über mehrere Atemzyklen.
     * @param {number} cyclesTotal
     * @param {number} discardCycles - erste N Zyklen zur Einschwingung verwerfen
     * @param {function} [onSample] - (cycleIdx, cyclesTotal, amplitude|null) => void
     */
    async _measureCycleAmplitude(cyclesTotal, discardCycles, onSample) {
        const amplitudes = [];
        let evt = await this._waitUntilPhase('inhale');
        let cycleStart = evt.ts;
        for (let c = 0; c < cyclesTotal; c++) {
            const exhaleEvt = await this._waitUntilPhase('exhale');
            const nextInhaleEvt = await this._waitUntilPhase('inhale');
            const amp = this.hrv.cycleAmplitude(cycleStart, exhaleEvt.ts, nextInhaleEvt.ts);
            if (c >= discardCycles && amp !== null) amplitudes.push(amp);
            onSample?.(c + 1, cyclesTotal, amp);
            cycleStart = nextInhaleEvt.ts;
        }
        return trimmedMean(amplitudes);
    }

    /**
     * RMSSD/Kohärenz-Messung über ein festes Zeitfenster (in Atemzyklen).
     * Isoliert das Fenster per hrv.reset(), damit keine Daten des vorigen
     * Kandidaten hineinbluten.
     * @param {number} cyclesTotal
     * @param {number} discardCycles - Einschwingzeit vor der eigentlichen Messung
     * @param {number} cycleMs
     * @param {function} [onSample] - (rmssd, sampleCount) => void
     */
    async _measureRmssdWindow(cyclesTotal, discardCycles, cycleMs, onSample) {
        const discardMs = discardCycles * cycleMs;
        const measureMs = (cyclesTotal - discardCycles) * cycleMs;
        if (discardMs > 0) await this._wait(discardMs);

        this.hrv.reset();
        const samples = [];
        const startTs = performance.now();
        while (performance.now() - startTs < measureMs) {
            await this._wait(Math.min(RMSSD_SAMPLE_MS, measureMs));
            const r = this.hrv.rmssd();
            if (r > 0) samples.push(r);
            onSample?.(r, samples.length);
        }

        const avgRmssd = trimmedMean(samples);
        let coherenceScore = 0;
        if (this.hrv.dataSpanSeconds >= 30) {
            const fft = this.hrv.frequencyAnalysis();
            if (fft) coherenceScore = fft.coherenceScore;
        }
        return { avgRmssd: Math.round(avgRmssd), coherenceScore };
    }
}

// ─── Protokoll 1: Frequenz-Scan ──────────────────────────────────────────────

export class FrequencyTest extends CalibrationTestBase {
    constructor(hrv, db) {
        super(hrv, db);
        this.onCandidateStart = null; // (idx, total, bpm) => void  [Phase 1]
        this.onCycleSample    = null; // (cycleIdx, total, amplitude|null) => void
        this.onPhase1Done     = null; // (rawResults, smoothed, finalists) => void
        this.onFinalistStart  = null; // (idx, total, bpm, subPhase) => void  [Phase 2]
        this.onRmssdSample    = null; // (rmssd, sampleCount) => void
        this.onFinalistDone   = null; // (idx, finalistResults) => void
        this.onComplete       = null; // (winner, fullResult) => void
    }

    async start() {
        this._active = true;
        try {
            const grid = buildFrequencyGrid();
            const rawResults = [];

            for (let i = 0; i < grid.length; i++) {
                const bpm = grid[i];
                this.onCandidateStart?.(i, grid.length, bpm);
                this.onRhythmChange?.(symmetricRhythm(bpm));
                const amplitude = await this._measureCycleAmplitude(
                    PHASE1_CYCLES, PHASE1_DISCARD,
                    (c, total, amp) => this.onCycleSample?.(c, total, amp)
                );
                rawResults.push({ bpm, amplitude });
            }

            const xs = rawResults.map(r => r.bpm);
            const ys = rawResults.map(r => r.amplitude);
            const { a, b, c } = quadraticFit(xs, ys);
            const smoothed = rawResults.map(r => ({ ...r, smoothed: a * r.bpm * r.bpm + b * r.bpm + c }));
            const finalists = [...smoothed]
                .sort((x, y) => y.smoothed - x.smoothed)
                .slice(0, TOP_N)
                .sort((x, y) => x.bpm - y.bpm);

            this.onPhase1Done?.(rawResults, smoothed, finalists);

            const finalistResults = [];
            for (let i = 0; i < finalists.length; i++) {
                const bpm = finalists[i].bpm;
                const cycleMs = bpmToCycleMs(bpm);
                const rhythm = symmetricRhythm(bpm);

                this.onFinalistStart?.(i, finalists.length, bpm, 'acclimation');
                this.onRhythmChange?.(rhythm);
                await this._wait(PHASE2_ACCLIM_SEC * 1000);

                this.onFinalistStart?.(i, finalists.length, bpm, 'measurement');
                // Zielfenster für den Kohärenz-Score auf diesen Kandidaten ausrichten
                // (sonst misst frequencyAnalysis() Konzentration um eine veraltete Frequenz)
                this.hrv.resonanceFreq = bpm / 60;
                const cyclesInMeasure = Math.max(1, Math.round((PHASE2_MEASURE_SEC * 1000) / cycleMs));
                const { avgRmssd, coherenceScore } = await this._measureRmssdWindow(
                    cyclesInMeasure, 0, cycleMs,
                    (r, n) => this.onRmssdSample?.(r, n)
                );

                finalistResults.push({ bpm, rhythm, avgRmssd, coherenceScore });
                this.onFinalistDone?.(i, finalistResults);
            }

            const winner = pickWinner(finalistResults);
            const result = { grid: rawResults, smoothed, finalists: finalistResults, winner };

            await this.db.saveFrequencyTest(result).catch(() => {});
            this.hrv.resonanceFreq = winner.bpm / 60;
            await Promise.all([
                this.db.setSetting('resonanceFreq', this.hrv.resonanceFreq),
                this.db.setSetting('breathRhythm', winner.rhythm),
            ]).catch(() => {});

            this._active = false;
            this.onComplete?.(winner, result);
        } catch (err) {
            this._active = false;
            if (err instanceof CancelledError) { this.onCancelled?.(); return; }
            throw err;
        }
    }
}

// ─── Protokoll 2: Verhältnis & Pausen ────────────────────────────────────────

export class RhythmTest extends CalibrationTestBase {
    /** @param {number} baseBpm - Ergebnis aus Protokoll 1 */
    constructor(hrv, db, baseBpm) {
        super(hrv, db);
        this.baseBpm = baseBpm;
        this.cycleMs = bpmToCycleMs(baseBpm);

        this.onStageStart  = null; // (stage, idx, total, info) => void
        this.onRmssdSample = null; // (rmssd, sampleCount) => void
        this.onStageResult = null; // (stage, idx, resultsSoFar) => void
        this.onStageDone   = null; // (stage, results, winner) => void
        this.onComplete    = null; // (winner, fullResult) => void
    }

    async _measureCandidate(rhythm) {
        return this._measureRmssdWindow(
            STAGE_CYCLES, STAGE_DISCARD, this.cycleMs,
            (r, n) => this.onRmssdSample?.(r, n)
        );
    }

    async start() {
        this._active = true;
        // Zielfenster für den Kohärenz-Score auf die feste Basisfrequenz ausrichten
        // (bleibt über das ganze Protokoll 2 gleich, da nur Verhältnis/Pausen variieren)
        this.hrv.resonanceFreq = this.baseBpm / 60;
        try {
            // ── Stufe A: Ein:Aus-Verhältnis ─────────────────────────────────
            const ratios = [35, 40, 45, 50, 55];
            const stageAResults = [];
            for (let i = 0; i < ratios.length; i++) {
                const ratioIn = ratios[i];
                const inhale = Math.round(this.cycleMs * ratioIn / 100 / 100) * 100;
                const rhythm = { inhale, holdIn: 0, exhale: this.cycleMs - inhale, holdOut: 0 };

                this.onStageStart?.('A', i, ratios.length, { ratioIn, rhythm });
                this.onRhythmChange?.(rhythm);
                const { avgRmssd, coherenceScore } = await this._measureCandidate(rhythm);

                stageAResults.push({ ratioIn, ...rhythm, avgRmssd, coherenceScore });
                this.onStageResult?.('A', i, stageAResults);
            }
            const ratioWinner = pickWinner(stageAResults);
            this.onStageDone?.('A', stageAResults, ratioWinner);

            // ── Stufe B Grob: Pausen (kein Halt / Halt-Ein / Halt-Aus / beide) ─
            const grobDefs = [
                { holdIn: 0,    holdOut: 0    },
                { holdIn: 1000, holdOut: 0    },
                { holdIn: 2000, holdOut: 0    },
                { holdIn: 0,    holdOut: 1000 },
                { holdIn: 0,    holdOut: 2000 },
                { holdIn: 1000, holdOut: 1000 },
            ];
            const stageBGrobResults = [];
            for (let i = 0; i < grobDefs.length; i++) {
                const { holdIn, holdOut } = grobDefs[i];
                const rhythm = buildPausePattern(ratioWinner.inhale, ratioWinner.exhale, this.cycleMs, holdIn, holdOut);

                this.onStageStart?.('B-grob', i, grobDefs.length, { rhythm });
                this.onRhythmChange?.(rhythm);
                const { avgRmssd, coherenceScore } = await this._measureCandidate(rhythm);

                stageBGrobResults.push({ ...rhythm, avgRmssd, coherenceScore });
                this.onStageResult?.('B-grob', i, stageBGrobResults);
            }
            const grobWinner = pickWinner(stageBGrobResults);
            this.onStageDone?.('B-grob', stageBGrobResults, grobWinner);

            // ── Stufe B Fein: 3×3-Gitter Halt-Ein × Halt-Aus (Zentrum wiederverwendet) ─
            const deltas = [-300, 0, 300];
            const stageBFeinResults = [];
            let idx = 0;
            const feinTotal = deltas.length * deltas.length;
            for (const dIn of deltas) {
                for (const dOut of deltas) {
                    if (dIn === 0 && dOut === 0) {
                        stageBFeinResults.push({ ...grobWinner, reused: true });
                        this.onStageResult?.('B-fein', idx, stageBFeinResults);
                        idx++;
                        continue;
                    }
                    const holdIn  = Math.max(0, grobWinner.holdIn  + dIn);
                    const holdOut = Math.max(0, grobWinner.holdOut + dOut);
                    const rhythm = buildPausePattern(ratioWinner.inhale, ratioWinner.exhale, this.cycleMs, holdIn, holdOut);

                    this.onStageStart?.('B-fein', idx, feinTotal, { rhythm });
                    this.onRhythmChange?.(rhythm);
                    const { avgRmssd, coherenceScore } = await this._measureCandidate(rhythm);

                    stageBFeinResults.push({ ...rhythm, avgRmssd, coherenceScore });
                    this.onStageResult?.('B-fein', idx, stageBFeinResults);
                    idx++;
                }
            }
            const winner = pickWinner(stageBFeinResults);
            this.onStageDone?.('B-fein', stageBFeinResults, winner);

            const result = {
                baseBpm: this.baseBpm,
                stageA: stageAResults, ratioWinner,
                stageBGrob: stageBGrobResults, grobWinner,
                stageBFein: stageBFeinResults,
                winner,
            };

            await this.db.saveRhythmTest(result).catch(() => {});
            const finalRhythm = { inhale: winner.inhale, holdIn: winner.holdIn, exhale: winner.exhale, holdOut: winner.holdOut };
            await this.db.setSetting('breathRhythm', finalRhythm).catch(() => {});

            this._active = false;
            this.onComplete?.(winner, result);
        } catch (err) {
            this._active = false;
            if (err instanceof CancelledError) { this.onCancelled?.(); return; }
            throw err;
        }
    }
}

// ─── Protokoll 3: 5-Minuten-Check ────────────────────────────────────────────

export class DailyCheck extends CalibrationTestBase {
    /** @param {{inhale:number,holdIn:number,exhale:number,holdOut:number}} storedRhythm */
    constructor(hrv, db, storedRhythm) {
        super(hrv, db);
        this.storedRhythm = storedRhythm;
        const cycleMs = storedRhythm.inhale + storedRhythm.holdIn + storedRhythm.exhale + storedRhythm.holdOut;
        this.storedBpm = 60000 / cycleMs;

        this.onCandidateStart = null; // (idx, total, bpm) => void
        this.onCycleSample    = null; // (cycleIdx, total, amplitude|null) => void
        this.onCandidateDone  = null; // (idx, resultsSoFar) => void
        this.onComplete       = null; // ({bpm, rhythm}, fullResult) => void
    }

    async start() {
        this._active = true;
        try {
            const candidates = DAILY_OFFSETS
                .map(o => Math.round(Math.min(GRID_END, Math.max(GRID_START, this.storedBpm + o)) * 100) / 100)
                .filter((v, i, arr) => arr.indexOf(v) === i);

            const results = [];
            for (let i = 0; i < candidates.length; i++) {
                const bpm = candidates[i];
                this.onCandidateStart?.(i, candidates.length, bpm);
                this.onRhythmChange?.(symmetricRhythm(bpm));
                const amplitude = await this._measureCycleAmplitude(
                    PHASE1_CYCLES, PHASE1_DISCARD,
                    (c, total, amp) => this.onCycleSample?.(c, total, amp)
                );
                results.push({ bpm, amplitude });
                this.onCandidateDone?.(i, results);
            }

            const rawWinner = results.reduce((best, r) => r.amplitude > best.amplitude ? r : best);

            // Gedämpfte Übernahme (exponentielle Glättung, wie hrv.updateResonanceFrequency)
            const smoothedFreqHz = 0.8 * (this.storedBpm / 60) + 0.2 * (rawWinner.bpm / 60);
            const appliedBpm = Math.round(smoothedFreqHz * 60 * 100) / 100;

            // Nur die Frequenz ändert sich – Verhältnis/Pausen aus Protokoll 2
            // bleiben strukturell erhalten (proportionale Skalierung).
            const oldCycleMs = this.storedRhythm.inhale + this.storedRhythm.holdIn + this.storedRhythm.exhale + this.storedRhythm.holdOut;
            const newCycleMs = bpmToCycleMs(appliedBpm);
            const scale = newCycleMs / oldCycleMs;
            const rhythm = {
                inhale:  Math.round(this.storedRhythm.inhale  * scale),
                holdIn:  Math.round(this.storedRhythm.holdIn  * scale),
                exhale:  Math.round(this.storedRhythm.exhale  * scale),
                holdOut: Math.round(this.storedRhythm.holdOut * scale),
            };

            const result = { candidates: results, rawWinnerBpm: rawWinner.bpm, appliedBpm, rhythm };
            await this.db.saveDailyCheck(result).catch(() => {});

            this.hrv.resonanceFreq = smoothedFreqHz;
            await Promise.all([
                this.db.setSetting('resonanceFreq', smoothedFreqHz),
                this.db.setSetting('breathRhythm', rhythm),
            ]).catch(() => {});

            this._active = false;
            this.onComplete?.({ bpm: appliedBpm, rhythm }, result);
        } catch (err) {
            this._active = false;
            if (err instanceof CancelledError) { this.onCancelled?.(); return; }
            throw err;
        }
    }
}
