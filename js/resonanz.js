/**
 * ResonanzTest – Ermittlung des optimalen Atemrhythmus in 3 Schritten
 *
 *  Schritt 1 (Grob-Scan) : 6,5 / 6,0 / 5,5 / 5,0 / 4,5 Atemz/min  – 5 × 4 Min
 *  Schritt 2 (Fein-Scan) : Optimum ± 0,2 in 0,1er-Schritten           – 5 × 4 Min
 *  Schritt 3 (Pausen)    : 6 Halt-In / Halt-Out Kombinationen          – 6 × 4 Min
 *
 *  Jedes Muster: 2 Min Akklimatisierung (nicht gewertet) + 2 Min Messung.
 *  Metrik: Ø RMSSD der Messphase (alle 10 s gesampelt).
 *
 *  Rhythmen werden auf 100 ms gerundet → x,x Sekunden Anzeige.
 */

const ACCLIMATION_SEC = 120;   // 2 Min Einlaufzeit
const MEASUREMENT_SEC = 120;   // 2 Min Messung
const SAMPLE_SEC      = 10;    // RMSSD-Sample alle 10 s

// Hilfsfunktion: Atemfrequenz → Halb-Zyklus in ms (gerundet auf 100 ms)
function bpmToHalfCycleMs(bpm) {
    return Math.round(30000 / bpm / 100) * 100;
}

export class ResonanzTest {
    /**
     * @param {import('./hrv.js').HRVAnalyzer} hrv
     * @param {import('./database.js').Database} db
     */
    constructor(hrv, db) {
        this.hrv = hrv;
        this.db  = db;

        this._active     = false;
        this._step       = 0;
        this._patternIdx = 0;
        this._phase      = 'acclimation';   // 'acclimation' | 'measurement'
        this._startTime  = null;            // Start des aktuellen Musters
        this._phaseTimer = null;
        this._samTimer   = null;

        this._patterns         = [];
        this._measureSamples   = [];   // RMSSD-Werte der aktuellen Messphase
        this._results          = { 1: [], 2: [], 3: [] };
        this._step2BaseRhythm  = null; // Wird nach Schritt 2 gesetzt (für Schritt 3)

        // ── Callbacks (werden von app.js belegt) ────────────────────────────
        /** @type {function(step:number, idx:number, pattern:object, total:number): void} */
        this.onPatternStart = null;
        /** @type {function('acclimation'|'measurement'): void} */
        this.onPhaseChange  = null;
        /** @type {function(rmssd:number, avg:number|null): void} */
        this.onRmssdSample  = null;
        /** @type {function(step:number, results:object[], optimumIdx:number): void} */
        this.onStepDone     = null;
        /** @type {function(finalOptimum:object, fullResult:object): void} */
        this.onComplete     = null;
    }

    // ─── Getter ──────────────────────────────────────────────────────────────

    get active()         { return this._active; }
    get step()           { return this._step; }
    get patternIdx()     { return this._patternIdx; }
    get phase()          { return this._phase; }
    get patterns()       { return this._patterns; }
    get results()        { return this._results; }
    get currentPattern() { return this._patterns[this._patternIdx] ?? null; }

    /** Vergangene Sekunden im aktuellen Muster */
    getPatternElapsed() {
        return this._startTime ? Math.round((Date.now() - this._startTime) / 1000) : 0;
    }

    /** Verbleibende Sekunden in der aktuellen Phase */
    getPhaseRemaining() {
        const el = this.getPatternElapsed();
        if (this._phase === 'acclimation') {
            return Math.max(0, ACCLIMATION_SEC - el);
        }
        const measureElapsed = el - ACCLIMATION_SEC;
        return Math.max(0, MEASUREMENT_SEC - measureElapsed);
    }

    getCurrentRmssd() { return Math.round(this.hrv.rmssd()); }

    getAvgRmssd() {
        if (this._measureSamples.length === 0) return null;
        return Math.round(this._measureSamples.reduce((a, b) => a + b, 0) / this._measureSamples.length);
    }

    // ─── Steuerung ───────────────────────────────────────────────────────────

    start() {
        if (this._active) return;
        this._active     = true;
        this._step       = 1;
        this._results    = { 1: [], 2: [], 3: [] };
        this._patterns   = this._buildStep1Patterns();
        this._patternIdx = 0;
        this._runCurrentPattern();
    }

    stop() {
        this._active = false;
        clearTimeout(this._phaseTimer);
        clearInterval(this._samTimer);
        this._phaseTimer = null;
        this._samTimer   = null;
        if (this.resonanzPacer) this.resonanzPacer?.stop();
    }

    /** Wird aufgerufen wenn Nutzer "Weiter zu Schritt X" drückt */
    resumeNextStep() {
        if (this._active) return;
        this._active = true;
        this._runCurrentPattern();
    }

    // ─── Muster-Definitionen ─────────────────────────────────────────────────

    _buildStep1Patterns() {
        return [6.5, 6.0, 5.5, 5.0, 4.5].map(bpm => {
            const ms = bpmToHalfCycleMs(bpm);
            return {
                label:        `${bpm.toFixed(1)} Atemz/min  ·  ${(ms/1000).toFixed(1)} s / ${(ms/1000).toFixed(1)} s`,
                shortLabel:   `${bpm.toFixed(1)} Atemz/min`,
                bpm,
                breathRhythm: { inhale: ms, holdIn: 0, exhale: ms, holdOut: 0 },
            };
        });
    }

    _buildStep2Patterns(optimumBpm) {
        return [-0.2, -0.1, 0, 0.1, 0.2]
            .map(d => Math.round((optimumBpm + d) * 10) / 10)
            .filter(bpm => bpm >= 3.5 && bpm <= 9.0)
            .map(bpm => {
                const ms = bpmToHalfCycleMs(bpm);
                return {
                    label:        `${bpm.toFixed(1)} Atemz/min  ·  ${(ms/1000).toFixed(1)} s / ${(ms/1000).toFixed(1)} s`,
                    shortLabel:   `${bpm.toFixed(1)} Atemz/min`,
                    bpm,
                    breathRhythm: { inhale: ms, holdIn: 0, exhale: ms, holdOut: 0 },
                };
            });
    }

    _buildStep3Patterns(baseRhythm) {
        const { inhale, exhale } = baseRhythm;
        const inS  = (inhale  / 1000).toFixed(1);
        const exS  = (exhale  / 1000).toFixed(1);
        return [
            { holdIn: 0,    holdOut: 0,    suffix: 'kein Halt' },
            { holdIn: 1000, holdOut: 0,    suffix: 'Halt-In 1,0 s' },
            { holdIn: 2000, holdOut: 0,    suffix: 'Halt-In 2,0 s' },
            { holdIn: 0,    holdOut: 1000, suffix: 'Halt-Out 1,0 s' },
            { holdIn: 0,    holdOut: 2000, suffix: 'Halt-Out 2,0 s' },
            { holdIn: 1000, holdOut: 1000, suffix: 'In 1,0 s + Out 1,0 s' },
        ].map(p => ({
            label:        `${inS} s / ${exS} s  ·  ${p.suffix}`,
            shortLabel:   p.suffix,
            breathRhythm: { inhale, holdIn: p.holdIn, exhale, holdOut: p.holdOut },
        }));
    }

    // ─── Ablauf ───────────────────────────────────────────────────────────────

    _runCurrentPattern() {
        if (!this._active) return;

        this._startTime      = Date.now();
        this._phase          = 'acclimation';
        this._measureSamples = [];

        const pat = this._patterns[this._patternIdx];
        if (this.onPatternStart) {
            this.onPatternStart(this._step, this._patternIdx, pat, this._patterns.length);
        }
        if (this.onPhaseChange) this.onPhaseChange('acclimation');

        // Nach Akklimatisierung → Messphase starten
        this._phaseTimer = setTimeout(() => {
            if (!this._active) return;
            this._phase = 'measurement';
            if (this.onPhaseChange) this.onPhaseChange('measurement');

            // RMSSD alle 10 s sampeln
            this._samTimer = setInterval(() => {
                if (!this._active) { clearInterval(this._samTimer); return; }
                const rmssd = this.hrv.rmssd();
                if (rmssd > 0) this._measureSamples.push(rmssd);
                if (this.onRmssdSample) {
                    this.onRmssdSample(Math.round(rmssd), this.getAvgRmssd());
                }
            }, SAMPLE_SEC * 1000);

            // Nach Messphase → Muster abschließen
            this._phaseTimer = setTimeout(() => {
                if (!this._active) return;
                clearInterval(this._samTimer);
                this._samTimer = null;
                this._completePattern();
            }, MEASUREMENT_SEC * 1000);

        }, ACCLIMATION_SEC * 1000);
    }

    _completePattern() {
        const avgRmssd = this.getAvgRmssd() ?? 0;
        const pat      = this._patterns[this._patternIdx];
        this._results[this._step].push({ ...pat, avgRmssd });

        const nextIdx = this._patternIdx + 1;
        if (nextIdx < this._patterns.length) {
            this._patternIdx = nextIdx;
            this._runCurrentPattern();
        } else {
            this._finishStep();
        }
    }

    _finishStep() {
        const stepResults = this._results[this._step];

        // Bestes Muster finden (höchster Ø RMSSD)
        let optimumIdx = 0;
        stepResults.forEach((r, i) => {
            if (r.avgRmssd > stepResults[optimumIdx].avgRmssd) optimumIdx = i;
        });
        const optimum = stepResults[optimumIdx];

        // Test pausieren (Nutzer soll Ergebnis sehen)
        this._active = false;
        const doneStep = this._step;

        // Nächsten Schritt vorbereiten (aber noch nicht starten)
        if (doneStep < 3) {
            this._step++;
            this._patternIdx = 0;
            if (this._step === 2) {
                this._patterns = this._buildStep2Patterns(optimum.bpm);
            } else if (this._step === 3) {
                // Bestes Muster aus Schritt 2 als Basis für Pausen
                this._step2BaseRhythm = optimum.breathRhythm;
                this._patterns = this._buildStep3Patterns(this._step2BaseRhythm);
            }
        }

        if (this.onStepDone) this.onStepDone(doneStep, stepResults, optimumIdx);

        // Nach Schritt 3: Ergebnis speichern
        if (doneStep === 3) {
            this._saveAndFinish(optimum);
        }
    }

    async _saveAndFinish(finalOptimum) {
        const result = {
            date:        new Date().toISOString(),
            step1:       this._results[1],
            step2:       this._results[2],
            step3:       this._results[3],
            finalRhythm: finalOptimum.breathRhythm,
            finalRmssd:  finalOptimum.avgRmssd,
        };
        await this.db.saveResonanzResult(result).catch(() => {});
        if (this.onComplete) this.onComplete(finalOptimum, result);
    }

    // ─── Hilfsmethode: Rhythmus als lesbaren String ───────────────────────────

    static rhythmToString(r) {
        const s = ms => (ms / 1000).toFixed(1) + ' s';
        const parts = [s(r.inhale)];
        if (r.holdIn)  parts.push(`Halt ${s(r.holdIn)}`);
        parts.push(s(r.exhale));
        if (r.holdOut) parts.push(`Pause ${s(r.holdOut)}`);
        return parts.join(' · ');
    }
}
