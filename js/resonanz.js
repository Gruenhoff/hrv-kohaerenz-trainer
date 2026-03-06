/**
 * ResonanzTest – Optimaler Atemrhythmus in 4 Schritten
 *
 *  1  Grob-Scan     : 6,5 / 6,0 / 5,5 / 5,0 / 4,5 Atemz/min    – 5 × 4 Min = 20 Min
 *  2  Fein-Scan     : Optimum ± 0,2 in 0,1er-Schritten            – 5 × 4 Min = 20 Min
 *  3  Verhältnis    : Ein:Aus 35:65 / 40:60 / 45:55 / 50:50 / 55:45 – 5 × 4 Min = 20 Min
 *  4  Pausen        : Grob (0/1/2 s) + Fein (± 0,1 s) automatisch  – 11 × 4 Min = 44 Min
 *
 *  Jedes Muster: 2 Min Akklimatisierung + 2 Min Messung · Metrik: Ø RMSSD alle 10 s.
 *  Rhythmen auf 100 ms gerundet → x,x Sekunden Anzeige.
 *  Schritte können einzeln oder als Komplett-Test (alle 4) gestartet werden.
 *  Jedes Schritt-Ergebnis wird in der DB als Setting gespeichert.
 */

const ACCLIMATION_SEC = 120;
const MEASUREMENT_SEC = 120;
const SAMPLE_SEC      = 10;

/** BPM → halber Zyklus in ms, gerundet auf 100 ms */
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
        this._reset();

        // ── Callbacks (von app.js gesetzt) ──────────────────────────────────
        /** @type {function(step, idx, pattern, total, step4Phase)} */
        this.onPatternStart  = null;
        /** @type {function('acclimation'|'measurement')} */
        this.onPhaseChange   = null;
        /** @type {function(rmssd, avg)} */
        this.onRmssdSample   = null;
        /** Feuert zwischen Schritt-4A und 4B (automatischer Übergang, kein Stop) */
        /** @type {function(step4AResults, optimumIdx)} */
        this.onStep4Progress = null;
        /** @type {function(step, results, optimumIdx)} */
        this.onStepDone      = null;
        /** @type {function(finalOptimum, fullResult)} */
        this.onComplete      = null;
    }

    _reset() {
        this._active     = false;
        this._step       = 0;
        this._stepOnly   = false;  // true = nur aktuellen Schritt ausführen
        this._patternIdx = 0;
        this._phase      = 'acclimation';
        this._startTime  = null;
        this._phaseTimer = null;
        this._samTimer   = null;

        this._patterns       = [];
        this._measureSamples = [];
        this._results        = { 1: [], 2: [], 3: [], '4A': [], '4B': [] };
        this._step4Phase     = null;   // 'A' | 'B'
        this._step4AOptimum  = null;
    }

    // ─── Getter ──────────────────────────────────────────────────────────────

    get active()         { return this._active; }
    get step()           { return this._step; }
    get stepOnly()       { return this._stepOnly; }
    get patternIdx()     { return this._patternIdx; }
    get phase()          { return this._phase; }
    get patterns()       { return this._patterns; }
    get currentPattern() { return this._patterns[this._patternIdx] ?? null; }
    get step4Phase()     { return this._step4Phase; }

    /** Alle Ergebnisse für einen Schritt (Schritt 4 = 4A+4B kombiniert) */
    getResults(step) {
        if (step === 4) return [...(this._results['4A'] ?? []), ...(this._results['4B'] ?? [])];
        return this._results[step] ?? [];
    }

    getPatternElapsed() {
        return this._startTime ? Math.round((Date.now() - this._startTime) / 1000) : 0;
    }

    getPhaseRemaining() {
        const el = this.getPatternElapsed();
        if (this._phase === 'acclimation') return Math.max(0, ACCLIMATION_SEC - el);
        return Math.max(0, MEASUREMENT_SEC - (el - ACCLIMATION_SEC));
    }

    getCurrentRmssd() { return Math.round(this.hrv.rmssd()); }

    getAvgRmssd() {
        if (!this._measureSamples.length) return null;
        return Math.round(this._measureSamples.reduce((a, b) => a + b, 0) / this._measureSamples.length);
    }

    // ─── Starten ─────────────────────────────────────────────────────────────

    /** Einzelnen Schritt starten (Ergebnis des Vorgänger-Schritts als Eingabe) */
    startStep(stepNum, prevOptimum = null) {
        this._reset();
        this._step     = stepNum;
        this._stepOnly = true;
        this._active   = true;

        switch (stepNum) {
            case 1:
                this._patterns = this._buildStep1Patterns();
                break;
            case 2:
                if (!prevOptimum?.bpm) throw new Error('Schritt 2 braucht Schritt-1-Ergebnis (bpm)');
                this._patterns = this._buildStep2Patterns(prevOptimum.bpm);
                break;
            case 3:
                if (!prevOptimum?.breathRhythm) throw new Error('Schritt 3 braucht Schritt-2-Ergebnis');
                this._patterns = this._buildStep3Patterns(prevOptimum.breathRhythm);
                break;
            case 4:
                if (!prevOptimum?.breathRhythm) throw new Error('Schritt 4 braucht Schritt-3-Ergebnis');
                this._step4Phase = 'A';
                this._patterns = this._buildStep4APatterns(prevOptimum.breathRhythm);
                break;
            default:
                throw new Error(`Unbekannter Schritt: ${stepNum}`);
        }

        this._runCurrentPattern();
    }

    /** Alle 4 Schritte hintereinander starten */
    startFullTest() {
        this._reset();
        this._step     = 1;
        this._stepOnly = false;
        this._active   = true;
        this._patterns = this._buildStep1Patterns();
        this._runCurrentPattern();
    }

    stop() {
        this._active = false;
        clearTimeout(this._phaseTimer);
        clearInterval(this._samTimer);
        this._phaseTimer = null;
        this._samTimer   = null;
    }

    /** Nächsten Schritt starten (nach Nutzer-Bestätigung zwischen Schritten) */
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

    /** Schritt 3: Verhältnis Ein:Aus variieren, Zyklusdauer bleibt fix */
    _buildStep3Patterns(step2Rhythm) {
        const { inhale, exhale } = step2Rhythm;
        const cycleDurationMs    = inhale + exhale;
        return [35, 40, 45, 50, 55].map(ratioIn => {
            const inhaleMs = Math.round(cycleDurationMs * ratioIn / 10000) * 100;
            const exhaleMs = cycleDurationMs - inhaleMs;
            const inS = (inhaleMs / 1000).toFixed(1);
            const exS = (exhaleMs / 1000).toFixed(1);
            return {
                label:        `${ratioIn}:${100 - ratioIn}  ·  ${inS} s Ein / ${exS} s Aus`,
                shortLabel:   `${ratioIn}:${100 - ratioIn}  (${inS} s / ${exS} s)`,
                breathRhythm: { inhale: inhaleMs, holdIn: 0, exhale: exhaleMs, holdOut: 0 },
            };
        });
    }

    /** Schritt 4A: Pausen grob (0 / 1,0 / 2,0 s) beim optimalen Verhältnis */
    _buildStep4APatterns(step3Rhythm) {
        const { inhale, exhale } = step3Rhythm;
        const inS = (inhale / 1000).toFixed(1);
        const exS = (exhale / 1000).toFixed(1);
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

    /**
     * Schritt 4B: Pausen fein (± 0,2 s in 0,1-Schritten).
     * Findet den dominanten Halt-Typ aus 4A und variiert diesen.
     */
    _buildStep4BPatterns(step4AOptimumRhythm) {
        const { inhale, exhale, holdIn, holdOut } = step4AOptimumRhythm;
        const inS = (inhale / 1000).toFixed(1);
        const exS = (exhale / 1000).toFixed(1);

        // Dominanter Halt-Typ (bei 0/0 default: Halt-In)
        const isHoldInDominant = holdIn >= holdOut;
        const dominantMs       = isHoldInDominant ? holdIn : holdOut;

        return [-200, -100, 0, 100, 200].map(delta => {
            const newVal    = Math.max(0, dominantMs + delta);
            const newHoldIn  = isHoldInDominant ? newVal  : holdIn;
            const newHoldOut = !isHoldInDominant ? newVal : holdOut;
            const hiS = (newHoldIn  / 1000).toFixed(1);
            const hoS = (newHoldOut / 1000).toFixed(1);
            return {
                label:        `${inS} s / ${exS} s  ·  H-In ${hiS} s / H-Out ${hoS} s`,
                shortLabel:   `H-In ${hiS} s / H-Out ${hoS} s`,
                breathRhythm: { inhale, holdIn: newHoldIn, exhale, holdOut: newHoldOut },
            };
        });
    }

    // ─── Ablauf ───────────────────────────────────────────────────────────────

    _runCurrentPattern() {
        if (!this._active) return;
        this._startTime      = Date.now();
        this._phase          = 'acclimation';
        this._measureSamples = [];

        const pat = this._patterns[this._patternIdx];
        if (this.onPatternStart) {
            this.onPatternStart(this._step, this._patternIdx, pat, this._patterns.length, this._step4Phase);
        }
        if (this.onPhaseChange) this.onPhaseChange('acclimation');

        this._phaseTimer = setTimeout(() => {
            if (!this._active) return;
            this._phase = 'measurement';
            if (this.onPhaseChange) this.onPhaseChange('measurement');

            this._samTimer = setInterval(() => {
                if (!this._active) { clearInterval(this._samTimer); return; }
                const rmssd = this.hrv.rmssd();
                if (rmssd > 0) this._measureSamples.push(rmssd);
                if (this.onRmssdSample) this.onRmssdSample(Math.round(rmssd), this.getAvgRmssd());
            }, SAMPLE_SEC * 1000);

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

        // Ergebnis in den richtigen Bucket schreiben
        const bucket = (this._step === 4 && this._step4Phase) ? `4${this._step4Phase}` : this._step;
        if (!this._results[bucket]) this._results[bucket] = [];
        this._results[bucket].push({ ...pat, avgRmssd });

        const nextIdx = this._patternIdx + 1;
        if (nextIdx < this._patterns.length) {
            this._patternIdx = nextIdx;
            this._runCurrentPattern();
        } else {
            this._finishStep();
        }
    }

    _finishStep() {
        const bucket      = (this._step === 4 && this._step4Phase) ? `4${this._step4Phase}` : this._step;
        const stepResults = this._results[bucket] ?? [];

        let optimumIdx = 0;
        stepResults.forEach((r, i) => {
            if (r.avgRmssd > stepResults[optimumIdx].avgRmssd) optimumIdx = i;
        });
        const optimum = stepResults[optimumIdx];

        // ── Schritt 4 Phase A → Phase B (automatisch, kein Stop) ─────────────
        if (this._step === 4 && this._step4Phase === 'A') {
            this._step4AOptimum = optimum;
            this._step4Phase    = 'B';
            this._patternIdx    = 0;
            this._patterns      = this._buildStep4BPatterns(optimum.breathRhythm);

            if (this.onStep4Progress) this.onStep4Progress(stepResults, optimumIdx);

            this._runCurrentPattern();  // direkt weiter, kein Pause
            return;
        }

        // ── Schritt abgeschlossen → pausieren ─────────────────────────────────
        this._active = false;
        const doneStep = this._step;

        // Schritt-Ergebnis in DB speichern (als Setting, sofort abrufbar)
        this.db.setSetting(`resonanzStep${doneStep}Optimum`, {
            bpm:          optimum.bpm,
            breathRhythm: optimum.breathRhythm,
            avgRmssd:     optimum.avgRmssd,
            label:        optimum.shortLabel ?? optimum.label,
            date:         new Date().toISOString(),
        }).catch(() => {});

        // Im Komplett-Test: nächsten Schritt vorbereiten
        if (!this._stepOnly && doneStep < 4) {
            this._step++;
            this._patternIdx = 0;
            if (this._step === 2) {
                this._patterns = this._buildStep2Patterns(optimum.bpm);
            } else if (this._step === 3) {
                this._patterns = this._buildStep3Patterns(optimum.breathRhythm);
            } else if (this._step === 4) {
                this._step4Phase = 'A';
                this._patterns = this._buildStep4APatterns(optimum.breathRhythm);
            }
        }

        if (this.onStepDone) this.onStepDone(doneStep, stepResults, optimumIdx);

        if (doneStep === 4) this._saveAndFinish(optimum);
    }

    async _saveAndFinish(finalOptimum) {
        const result = {
            date:        new Date().toISOString(),
            step1:       this._results[1],
            step2:       this._results[2],
            step3:       this._results[3],
            step4A:      this._results['4A'],
            step4B:      this._results['4B'],
            finalRhythm: finalOptimum.breathRhythm,
            finalRmssd:  finalOptimum.avgRmssd,
        };
        await this.db.saveResonanzResult(result).catch(() => {});
        if (this.onComplete) this.onComplete(finalOptimum, result);
    }

    static rhythmToString(r) {
        if (!r) return '—';
        const s = ms => (ms / 1000).toFixed(1) + ' s';
        const parts = [s(r.inhale)];
        if (r.holdIn)  parts.push(`H-In ${s(r.holdIn)}`);
        parts.push(s(r.exhale));
        if (r.holdOut) parts.push(`H-Out ${s(r.holdOut)}`);
        return parts.join(' / ');
    }
}
