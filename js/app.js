/**
 * HRV Kohärenz-Trainer – Haupt-App-Controller
 */

import { PolarBluetooth } from './bluetooth.js';
import { HRVAnalyzer }    from './hrv.js';
import { Database }       from './database.js';
import { RRVisualizer, SpectrumVisualizer, TachogramVisualizer, CoherenceWaveOverlay } from './visualizer.js';
import { CoachingEngine } from './coaching.js';
import { BreathPacer }    from './breathpacer.js';
import { HRSonification } from './audio.js';
import { Dashboard }      from './dashboard.js';
import { Zone2 }          from './zone2.js';
import { FrequencyTest, RhythmTest, DailyCheck, rhythmToString } from './resonanz.js';
import { NightRecording } from './nightRecording.js';
import { AdaptiveTraining } from './adaptiveTraining.js';
import { SpeechCoach } from './speech.js';

// ─── Phasenspezifische Dauer-Optionen ────────────────────────────────────────
const PHASE_DURATIONS = {
    1: { options: [300, 600, 900, 1200], default: 600,  labels: ['5 Min', '10 Min', '15 Min', '20 Min'] },
    2: { options: [300, 600, 900, 1200], default: 600,  labels: ['5 Min', '10 Min', '15 Min', '20 Min'] },
    3: {
        options: [480, 600, 720, 840, 960, 1080, 1200, 1320, 1440, 1560, 1680, 1800],
        default: 600,
        labels:  ['8 Min', '10 Min', '12 Min', '14 Min', '16 Min', '18 Min', '20 Min', '22 Min', '24 Min', '26 Min', '28 Min', '30 Min'],
    },
    4: { options: [60,  90,  120],       default: 90,   labels: ['60 Sek', '90 Sek', '2 Min'] },
};

// ─── Atemmuster-Bibliothek ───────────────────────────────────────────────────
// Alle Werte in Millisekunden; 'resonant' wird zur Laufzeit aus
// hrv.resonanceFreq berechnet (40 % Einatmen / 60 % Ausatmen).
const BREATH_PATTERNS = {
    coherent:  { name: 'Kohärent (5-5)',        desc: '5s ein · 5s aus → 6 Atemzüge/min · Standard',     rhythm: { inhale: 5000, holdIn: 0,    exhale: 5000, holdOut: 0 } },
    box:       { name: 'Box (4-4-4-4)',         desc: 'Gleichmäßig · Fokus & Stress-Reduktion · Navy SEAL', rhythm: { inhale: 4000, holdIn: 4000, exhale: 4000, holdOut: 4000 } },
    weil:      { name: '4-7-8 (Schlaf)',        desc: 'Tiefe Beruhigung · Andrew Weil',                  rhythm: { inhale: 4000, holdIn: 7000, exhale: 8000, holdOut: 0 } },
    resonant:  { name: 'Resonanz (individuell)', desc: 'Aus deinem Resonanztest gemessen',                rhythm: 'dynamic' },
};

function resonantRhythmFromFreq(freq) {
    // Unter 4.5/min (0.075 Hz): 2. Harmonische verwenden – sonst unpraktikabel
    const practical = freq < 0.075 ? freq * 2 : freq;
    const cycleMs = 1000 / Math.max(0.05, Math.min(0.2, practical));
    return {
        inhale:  Math.round(cycleMs * 0.4),
        holdIn:  0,
        exhale:  Math.round(cycleMs * 0.6),
        holdOut: 0,
    };
}

// ─── Voreingestellte emotionale Anker ────────────────────────────────────────
const DEFAULT_ANCHORS = [
    { id: 'dankbarkeit', name: 'Dankbarkeit',      prompt: 'Wofür bin ich gerade dankbar?',                builtin: true },
    { id: 'liebe',       name: 'Liebenswürdigkeit', prompt: 'Wen oder was liebe ich?',                     builtin: true },
    { id: 'zufrieden',   name: 'Zufriedenheit',     prompt: 'Was ist gerade gut in meinem Leben?',         builtin: true },
    { id: 'freude',      name: 'Freude',             prompt: 'Was bereitet mir echte Freude?',              builtin: true },
    { id: 'sicherheit',  name: 'Sicherheit',         prompt: 'Wo fühle ich mich vollkommen sicher?',       builtin: true },
];

class App {
    constructor() {
        this.db         = new Database();
        this.ble        = new PolarBluetooth();
        this.hrv        = new HRVAnalyzer();
        this.audio      = new HRSonification();
        this.zone2         = null;   // wird nach db.open() initialisiert
        this._calibTest     = null;  // laufendes FrequencyTest/RhythmTest/DailyCheck
        this._calibTicker   = null;
        this._calibFullChain = false;
        this.dashboard     = null;
        this.visualizer      = null;
        this.spectrum        = null;
        this.pacer           = null;
        this.tacho           = null;   // Tachogramm für Phase 3
        this.coherenceWave      = null;   // Kohärenz-Welle Overlay (Phase 3)
        this.coachEngine        = null;   // Coaching-Engine (Phase 3)
        this._bodyScanFFT       = null;   // FFT-Ergebnis aus Body-Scan (Vorkalibrierung)
        this.balloonInterval    = null;   // RSA-Update-Takt für Phase 3
        this.pulseRAF        = null;   // Resonanz-Anker-Animation
        this.pulseEnabled    = true;
        this.bodyScanTimer   = null;   // Body-Scan-Countdown
        this.bodyScanEnabled = true;
        this.bodyScanBaseline = null;  // RMSSD-Baseline aus Body-Scan

        // Nacht-Atemfrequenz-Messung
        this.night        = new NightRecording();
        this._nightTicker = null;
        this._wakeLock     = null;

        // Adaptives Training
        this.adaptiveTest    = null;
        this.adaptivePacer   = null;
        this._adaptiveTicker = null;
        this.speechCoach     = new SpeechCoach();

        // Volles Training (Phase 1 → 2 → 3 automatisch)
        this.fullTraining = {
            active:          false,
            phases:          [1, 2, 3],
            currentIdx:      0,
            durations:       { 1: 600, 2: 600, 3: 600 },
            phaseStats:      [],           // Stats jeder Phase
            transitionTimer: null,
        };

        // Phasenspezifisch gespeicherte Dauern (werden aus DB geladen)
        this.phaseDurations = {
            1: PHASE_DURATIONS[1].default,
            2: PHASE_DURATIONS[2].default,
            3: PHASE_DURATIONS[3].default,
            4: PHASE_DURATIONS[4].default,
        };

        // Session-Status
        this.session = {
            active:          false,
            phase:           1,
            startTime:       null,
            durationTarget:  PHASE_DURATIONS[1].default,
            coherenceLog:    [],
            rmssdLog:        [],
            lfhfLog:         [],
            anchorId:        null,
            anchorName:      null,
            breathRhythm:    { inhale: 5000, holdIn: 0, exhale: 5000, holdOut: 0 }, // ms
            firstCoherenceAt: null,
            currentStreak:    0,   // s in Kohärenz (>=70%) — Reset bei Abfall
            longestStreak:    0,   // s
            streakSince:      null,
            coherenceTimeline: [], // [{tSec, coh}] für Best-Minute & Spektrogramm
            spectrumTimeline:  [], // [{tSec, power}] für Heatmap
        };

        // FFT-Update-Intervall (alle 30s)
        this.fftInterval = null;

        // Aktuelle Ansicht
        this.currentView = 'home';
    }

    // ─── Init ────────────────────────────────────────────────────────────────

    async init() {
        await this.db.open();
        this.zone2 = new Zone2(this.db);
        await this._loadSettings();
        this._setupBluetooth();
        this._setupNavigation();
        this._setupBTButton();

        // Onboarding prüfen
        const onboardingDone = await this.db.getSetting('onboarding_done', false);
        if (!onboardingDone) {
            this._showOnboarding();
        } else {
            this._showApp();
        }
    }

    async _loadSettings() {
        const rhythm = await this.db.getSetting('breathRhythm', { inhale: 5000, holdIn: 0, exhale: 5000, holdOut: 0 });
        // Migration from old seconds format (values < 100 are seconds)
        if (rhythm.inhale < 100) {
            rhythm.inhale  = Math.round(rhythm.inhale  * 1000);
            rhythm.holdIn  = Math.round(rhythm.holdIn  * 1000);
            rhythm.exhale  = Math.round(rhythm.exhale  * 1000);
            rhythm.holdOut = Math.round(rhythm.holdOut * 1000);
            await this.db.setSetting('breathRhythm', rhythm);
        }
        this.session.breathRhythm = rhythm;

        this.hrv.resonanceFreq = await this.db.getSetting('resonanceFreq', 0.1);
        const saved = await this.db.getSetting('phaseDurations', null);
        if (saved) {
            this.phaseDurations = saved;
            // Sicherstellen, dass gespeicherte Phase-3-Dauer noch in den Optionen liegt
            if (!PHASE_DURATIONS[3].options.includes(this.phaseDurations[3])) {
                this.phaseDurations[3] = PHASE_DURATIONS[3].default;
            }
        }
    }

    // ─── Onboarding ──────────────────────────────────────────────────────────

    _showOnboarding() {
        document.getElementById('splash').classList.remove('active');
        document.getElementById('onboarding').classList.add('active');
        this._initOnboardingSteps();
    }

    _initOnboardingSteps() {
        let currentStep = 0;
        const steps = document.querySelectorAll('.onboard-step');
        const btnNext = document.getElementById('onboard-next');
        const btnSkip = document.getElementById('onboard-skip');

        const showStep = (n) => {
            steps.forEach((s, i) => s.classList.toggle('active', i === n));
            if (btnNext) btnNext.textContent = n === steps.length - 1 ? 'Loslegen!' : 'Weiter';
        };

        showStep(0);

        if (btnNext) {
            btnNext.addEventListener('click', async () => {
                if (currentStep < steps.length - 1) {
                    currentStep++;
                    showStep(currentStep);
                } else {
                    await this.db.setSetting('onboarding_done', true);
                    this._showApp();
                }
            });
        }

        if (btnSkip) {
            btnSkip.addEventListener('click', async () => {
                await this.db.setSetting('onboarding_done', true);
                this._showApp();
            });
        }
    }

    _showApp() {
        document.getElementById('onboarding')?.classList.remove('active');
        document.getElementById('splash')?.classList.remove('active');
        document.getElementById('app').classList.add('active');
        this._navigateTo('home');
    }

    // ─── Navigation ──────────────────────────────────────────────────────────

    _setupNavigation() {
        document.querySelectorAll('[data-nav]').forEach(btn => {
            btn.addEventListener('click', () => this._navigateTo(btn.dataset.nav));
        });
    }

    _navigateTo(view) {
        this.currentView = view;

        // Bottom-Nav aktiv
        document.querySelectorAll('[data-nav]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.nav === view);
        });

        // App-Views umschalten
        document.querySelectorAll('.app-view').forEach(el => {
            el.classList.toggle('active', el.id === `view-${view}`);
        });

        // View-spezifische Initialisierung
        if (view === 'home')      this._initHomeView();
        if (view === 'history')   this._initHistoryView();
        if (view === 'settings')  this._initSettingsView();
        if (view === 'training')  this._initTrainingView();
        if (view === 'zone2')     this._initZone2View();
        if (view === 'resonanz')  this._initResonanzView();
    }

    // ─── Home-View ───────────────────────────────────────────────────────────

    async _initHomeView() {
        const stats = await this.db.getStats();
        const el = document.getElementById('home-last-coherence');
        if (el && stats) {
            el.textContent = stats.avgCoherence ? `${stats.avgCoherence}%` : '—';
        }

        const el2 = document.getElementById('home-sessions');
        if (el2 && stats) el2.textContent = stats.totalSessions;

        const el3 = document.getElementById('home-peak');
        if (el3 && stats) el3.textContent = stats.peakCoherence ? `${stats.peakCoherence}%` : '—';

        // Phase-Karten aktivieren
        document.querySelectorAll('.phase-card').forEach(card => {
            card.addEventListener('click', () => {
                const phase = parseInt(card.dataset.phase);
                this._startSession(phase);
            });
        });
    }

    // ─── Bluetooth ───────────────────────────────────────────────────────────

    _setupBTButton() {
        document.querySelectorAll('.btn-connect').forEach(btn => {
            btn.addEventListener('click', () => this._connectBluetooth());
        });
        document.querySelectorAll('.btn-disconnect').forEach(btn => {
            btn.addEventListener('click', () => this._disconnectBluetooth());
        });
    }

    async _connectBluetooth() {
        const success = await this.ble.connect();
        return success;
    }

    _disconnectBluetooth() {
        this.ble.disconnect();
    }

    _setupBluetooth() {
        this.ble.onRRInterval = (rrMs) => {
            // Zone-2-Puffer immer befüllen (auch außerhalb der Session)
            if (this.zone2) this.zone2.addRR(rrMs);

            // Nacht-Aufnahme unabhängig vom Live-HRV-Puffer befüllen
            if (this.night.active) this.night.addRR(rrMs);

            const accepted = this.hrv.addRR(rrMs);
            if (accepted && this.session.active) {
                // Visualizer updaten
                if (this.visualizer)    this.visualizer.addRR(rrMs);
                if (this.tacho)         this.tacho.addRR(rrMs);
                if (this.coherenceWave) this.coherenceWave.addRR(rrMs);

                // RMSSD live updaten
                const rmssd = this.hrv.rmssd();
                this._updateLiveStats({ rmssd });

                // RR-Wert zur Session loggen
                if (this.session.active) {
                    this.session.rmssdLog.push(rmssd);
                }
            }

            if (accepted && this.adaptiveTest?.active) {
                this.adaptiveTest.logRmssd(this.hrv.rmssd());
            }
        };

        this.ble.onHeartRate = (bpm) => {
            document.querySelectorAll('.live-hr').forEach(el => el.textContent = bpm);
            // Sonifikation: Tonhöhe folgt HF
            if (this.session.active) this.audio.updateHeartRate(bpm);
            if (this.night.active) {
                const el = document.getElementById('night-hr');
                if (el) el.textContent = `${bpm} bpm`;
            }
        };

        this.ble.onEcgSample = (uv, tsMs) => {
            if (this.adaptiveTest?.active) this.adaptiveTest.addEcgSample(uv, tsMs);
        };

        this.ble.onConnect = () => {
            this._setConnectionStatus(true);
        };

        this.ble.onDisconnect = () => {
            this._setConnectionStatus(false);
        };

        this.ble.onStatusChange = (status) => {
            document.querySelectorAll('.ble-status-text').forEach(el => el.textContent = status);
        };

        this.ble.onError = (msg) => {
            this._showError(msg);
        };
    }

    _setConnectionStatus(connected) {
        document.querySelectorAll('.ble-dot').forEach(dot => {
            dot.classList.toggle('connected', connected);
        });
        document.querySelectorAll('.btn-connect').forEach(btn => {
            btn.style.display = connected ? 'none' : '';
        });
        document.querySelectorAll('.btn-disconnect').forEach(btn => {
            btn.style.display = connected ? '' : 'none';
        });
        document.querySelectorAll('.ble-status-text').forEach(el => {
            el.textContent = connected ? 'Verbunden' : 'Nicht verbunden';
        });
        // Bluetooth-Banner auf Home-View ausblenden wenn verbunden
        const banner = document.getElementById('bt-connect-banner');
        if (banner) banner.style.display = connected ? 'none' : '';
    }

    // ─── Training-Session ────────────────────────────────────────────────────

    _initTrainingView() {
        // Laufendes Adaptives Training bzw. laufende Kohärenz-Session direkt wiederherstellen
        if (this.adaptiveTest?.active) {
            this._trainingModeShow('adaptive');
            this._adaptiveShowSection('adaptive-active');
            return;
        }
        if (this.session.active) {
            this._trainingModeShow('coherence');
            document.getElementById('session-setup').style.display  = 'none';
            document.getElementById('session-active').style.display = '';
            return;
        }

        // Nichts aktiv → Modus-Auswahl zeigen
        this._trainingModeShow('select');

        const coherenceBtn = document.getElementById('mode-coherence-btn');
        if (coherenceBtn) {
            coherenceBtn.onclick = () => {
                this._trainingModeShow('coherence');
                this._initCoherenceTrainingSetup();
            };
        }
        const adaptiveBtn = document.getElementById('mode-adaptive-btn');
        if (adaptiveBtn) adaptiveBtn.onclick = () => this._adaptiveOpen();
    }

    /** Blendet genau einen der drei Trainings-Einstiegs-Bereiche ein */
    _trainingModeShow(mode) {
        const select = document.getElementById('training-mode-select');
        const setup  = document.getElementById('session-setup');
        if (select) select.style.display = mode === 'select' ? '' : 'none';
        if (setup)  setup.style.display  = mode === 'coherence' ? '' : 'none';
        if (mode !== 'adaptive') {
            const screen = document.getElementById('adaptive-screen');
            if (screen) screen.style.display = 'none';
        }
    }

    _initCoherenceTrainingSetup() {
        document.getElementById('session-setup').style.display  = '';
        document.getElementById('session-active').style.display = 'none';

        // Sonifikation-Toggle
        const audioToggle = document.getElementById('audio-toggle');
        if (audioToggle) {
            audioToggle.checked = this.audio.enabled;
            audioToggle.addEventListener('change', (e) => {
                this.audio.setEnabled(e.target.checked);
                this.audio.unlock();
            });
        }

        // Volume-Slider
        const volSlider = document.getElementById('volume-slider');
        if (volSlider) {
            volSlider.value = this.audio.volume;
            volSlider.addEventListener('input', (e) => {
                this.audio.setVolume(parseFloat(e.target.value));
            });
        }

        // Phase-Auswahl-Buttons
        document.querySelectorAll('.phase-select-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const phase = parseInt(btn.dataset.phase);
                this._setSessionPhase(phase);
            });
        });

        // Dauer-Auswahl
        this._updateDurationSelector(this.session.phase);

        // Atemrhythmus-Vorschau
        this._updateBreathPreview();

        // Volles Training Toggle
        const fullToggle = document.getElementById('full-training-toggle');
        if (fullToggle) {
            fullToggle.checked = false;
            fullToggle.addEventListener('change', (e) => this._toggleFullTraining(e.target.checked));
        }

        // Start-Button
        const startBtn = document.getElementById('session-start-btn');
        if (startBtn) startBtn.addEventListener('click', () => {
            this.audio.unlock();
            if (this.fullTraining.active) {
                this._startFullTraining();
            } else {
                this._startSession(this.session.phase);
            }
        });

        // Stop-Button (im Active-Bereich)
        const stopBtn = document.getElementById('session-stop-btn');
        if (stopBtn) stopBtn.addEventListener('click', () => this._stopSession());

        // Pacer-Toggle Phase 2/3
        const pacerPhase23Toggle = document.getElementById('pacer-phase23-toggle');
        if (pacerPhase23Toggle) {
            pacerPhase23Toggle.addEventListener('change', (e) => {
                const sec = document.getElementById('pacer-section');
                if (!sec) return;
                if (e.target.checked) {
                    sec.style.display = '';
                    // Pacer starten falls noch nicht aktiv
                    if (!this.pacer || !this.pacer.isRunning) {
                        const container  = document.getElementById('pacer-container');
                        const labelEl    = document.getElementById('breath-phase-label');
                        const countdownEl = document.getElementById('breath-countdown');
                        if (container) {
                            if (this.pacer) this.pacer.destroy();
                            this.pacer = new BreathPacer(
                                container, this.session.breathRhythm, labelEl, countdownEl, this.audio
                            );
                            this.pacer.start();
                        }
                    }
                } else {
                    sec.style.display = 'none';
                    if (this.pacer) { this.pacer.stop(); this.pacer = null; }
                }
            });
        }

        // Spektrum-Toggle
        const spectrumToggle = document.getElementById('spectrum-toggle');
        if (spectrumToggle) {
            spectrumToggle.addEventListener('change', (e) => {
                const spectrumContainer = document.getElementById('spectrum-container');
                if (spectrumContainer) {
                    spectrumContainer.style.display = e.target.checked ? '' : 'none';
                }
            });
        }

        // Anker-Auswahl vorladen
        this._loadAnchors();

        // Atemmuster-UI
        this._setupBreathPatternUI();
        this._restoreBreathPatternSelection();

        // Body-Scan Toggle
        const bsToggle = document.getElementById('body-scan-toggle');
        if (bsToggle) {
            this.db.getSetting('bodyScanEnabled', true).then(v => {
                this.bodyScanEnabled = !!v;
                bsToggle.checked = this.bodyScanEnabled;
            });
            bsToggle.addEventListener('change', async (e) => {
                this.bodyScanEnabled = e.target.checked;
                await this.db.setSetting('bodyScanEnabled', this.bodyScanEnabled);
            });
        }

        // Resonanz-Anker (Ballonpuls) Toggle
        const pulseToggle = document.getElementById('resonance-pulse-toggle');
        if (pulseToggle) {
            pulseToggle.addEventListener('change', (e) => {
                this.pulseEnabled = e.target.checked;
                if (e.target.checked && this.session.active && this.session.phase === 3) {
                    this._startResonancePulse();
                } else {
                    this._stopResonancePulse();
                    const wrapper = document.getElementById('balloon-wrapper');
                    if (wrapper) wrapper.style.setProperty('--pulse-scale', '1');
                }
            });
        }
    }

    // ─── Adaptives Training ─────────────────────────────────────────────────

    _adaptiveOpen() {
        const screen = document.getElementById('adaptive-screen');
        if (!screen) return;
        this._trainingModeShow('adaptive'); // blendet Modus-Auswahl/session-setup darunter aus
        screen.style.display = '';
        this._adaptiveShowSection('adaptive-setup');

        const startBtn = document.getElementById('adaptive-start-btn');
        if (startBtn) {
            startBtn.disabled = false; // Re-Entrancy-Sperre vom vorigen Lauf zurücksetzen
            startBtn.onclick = () => this._adaptiveStart();
        }

        const closeBtn = document.getElementById('adaptive-close-btn');
        if (closeBtn) closeBtn.onclick = () => { screen.style.display = 'none'; this._trainingModeShow('select'); };

        const stopBtn = document.getElementById('adaptive-stop-btn');
        if (stopBtn) stopBtn.onclick = () => this._adaptiveStop();

        const doneBtn = document.getElementById('adaptive-done-btn');
        if (doneBtn) doneBtn.onclick = () => { screen.style.display = 'none'; this._trainingModeShow('select'); };
    }

    _adaptiveShowSection(id) {
        ['adaptive-setup', 'adaptive-active', 'adaptive-result'].forEach(sid => {
            const el = document.getElementById(sid);
            if (el) el.style.display = sid === id ? '' : 'none';
        });
    }

    async _adaptiveStart() {
        if (!this.ble.isConnected) {
            alert('Polar H10 muss verbunden sein.');
            return;
        }

        // Re-Entrancy-Sperre: _runDailyCheck() kann bis zu 5 Min dauern — ohne Sperre
        // würde ein zweiter Klick eine zweite AdaptiveTraining-Instanz erzeugen, die
        // sich den BreathPacer streitig macht, während die erste für immer hängen bleibt.
        const startBtn = document.getElementById('adaptive-start-btn');
        if (startBtn) {
            if (startBtn.disabled) return;
            startBtn.disabled = true;
        }

        this.audio.unlock();

        // Tagesaktuelle Frequenz sicherstellen — derselbe DailyCheck wie im Kohärenz-Training.
        // #p1cal-screen liegt innerhalb von #view-training, #adaptive-screen als fixiertes
        // Overlay DARÜBER — kurz ausblenden, sonst wäre der DailyCheck unsichtbar dahinter.
        const screen = document.getElementById('adaptive-screen');
        if (screen) screen.style.display = 'none';
        await this._runDailyCheck();
        if (screen) screen.style.display = '';

        // EKG/PMD-Stream für die EDR-Atemtiefe aktivieren (best effort — läuft ohne weiter,
        // nur die Atemtiefe-Sprachhinweise entfallen dann, siehe AdaptiveTraining._checkEdrFeedback)
        const ecgOk = await this.ble.enableEcgStream();
        if (!ecgOk) {
            this._showToast('EKG-Stream nicht verfügbar – Atemtiefe-Hinweise entfallen, Live-Anpassung läuft trotzdem.');
        }

        const baseRhythm = { ...this.session.breathRhythm };
        const test = new AdaptiveTraining(this.hrv, this.db, baseRhythm);
        this.adaptiveTest = test;

        test.onRhythmChange = (rhythm) => {
            // Rhythmus nahtlos übernehmen: startTime neu setzen, damit die Modulo-Animation
            // nicht springt (die Anpassung erfolgt ohnehin an einer frischen Zyklusgrenze).
            if (this.adaptivePacer) {
                this.adaptivePacer.rhythm = rhythm;
                this.adaptivePacer.startTime = performance.now();
            }
        };
        test.onCalibrationDone = () => {
            const label = document.getElementById('adaptive-status-label');
            if (label) label.textContent = '';
        };
        test.onSpeechCue = (text) => this.speechCoach.speak(text);
        test.onComplete  = (summary) => this._adaptiveOnComplete(summary);

        this.speechCoach.onSpeechStart = () => this.audio.stop();
        this.speechCoach.onSpeechEnd   = () => this.audio.start();

        const container    = document.getElementById('adaptive-pacer-container');
        const labelEl       = document.getElementById('adaptive-breath-label');
        const countdownEl   = document.getElementById('adaptive-breath-countdown');
        if (this.adaptivePacer) this.adaptivePacer.destroy();
        if (container) {
            this.adaptivePacer = new BreathPacer(container, baseRhythm, labelEl, countdownEl, this.audio);
            this.adaptivePacer.onPhaseChange = (phase) => test.notifyPhaseChange(phase);
            this.adaptivePacer.start();
        }

        const statusLabel = document.getElementById('adaptive-status-label');
        if (statusLabel) statusLabel.textContent = 'Kalibrierung läuft…';

        this._adaptiveShowSection('adaptive-active');
        this._adaptiveStartTicker();
        this.audio.start();

        test.start().catch((err) => {
            console.error('Adaptives Training: unerwarteter Fehler', err);
            this._showError('Adaptives Training wurde wegen eines unerwarteten Fehlers beendet.');
            this._adaptiveHardStop();
        });
    }

    /**
     * Aufräumen nach einem echten (nicht regulären) Fehler in der Regelschleife —
     * anders als _adaptiveStop() wird hier NICHT versucht, eine Zusammenfassung zu
     * speichern/anzuzeigen, da der interne Zustand der Session inkonsistent sein kann.
     */
    _adaptiveHardStop() {
        clearInterval(this._adaptiveTicker);
        if (this.adaptivePacer) { this.adaptivePacer.stop(); this.adaptivePacer.destroy(); this.adaptivePacer = null; }
        this.speechCoach.stop();
        this.audio.stop();
        this.ble.disableEcgStream().catch(() => {});
        this.adaptiveTest = null;
        this._adaptiveShowSection('adaptive-setup');
        const startBtn = document.getElementById('adaptive-start-btn');
        if (startBtn) startBtn.disabled = false;
    }

    _adaptiveStartTicker() {
        clearInterval(this._adaptiveTicker);
        const startTs = performance.now();
        this._adaptiveTicker = setInterval(() => {
            const el = document.getElementById('adaptive-elapsed');
            if (!el) return;
            const s = Math.floor((performance.now() - startTs) / 1000);
            el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
        }, 1000);
    }

    async _adaptiveStop() {
        clearInterval(this._adaptiveTicker);
        if (this.adaptivePacer) { this.adaptivePacer.stop(); this.adaptivePacer.destroy(); this.adaptivePacer = null; }
        this.speechCoach.stop();
        this.audio.stop();
        await this.ble.disableEcgStream();
        if (this.adaptiveTest) await this.adaptiveTest.stop(); // löst onComplete aus → zeigt Zusammenfassung
    }

    _adaptiveOnComplete(summary) {
        this.adaptiveTest = null;
        this._adaptiveShowSection('adaptive-result');

        const el = document.getElementById('adaptive-summary');
        if (el) {
            const fmt = ms => (ms / 1000).toFixed(1) + 's';
            const r = summary.rhythm;
            const rhythmStr = [
                `${fmt(r.inhale)} ein`,
                r.holdIn  ? `${fmt(r.holdIn)} halten`  : null,
                `${fmt(r.exhale)} aus`,
                r.holdOut ? `${fmt(r.holdOut)} halten` : null,
            ].filter(Boolean).join(' / ');

            const phaseLabel = { inhale: 'Einatmen', holdIn: 'Halt-Ein', exhale: 'Ausatmen', holdOut: 'Halt-Aus' };
            const rows = [
                ['Ergebnis-Rhythmus', rhythmStr],
                ['Ø RMSSD', `${summary.avgRMSSD} ms (Spitze ${summary.peakRMSSD} ms)`],
                ['Ø Zyklus-Amplitude', `${summary.avgAmplitude} bpm (Spitze ${summary.peakAmplitude} bpm)`],
            ];
            for (const phase of ['inhale', 'holdIn', 'exhale', 'holdOut']) {
                const a = summary.adjustments[phase];
                if (!a || (a.lengthen === 0 && a.shorten === 0 && a.revert === 0)) continue; // ungenutzte Phase ausblenden
                rows.push([phaseLabel[phase], `${a.lengthen}× verlängert · ${a.shorten}× verkürzt · ${a.revert}× zurückgenommen`]);
            }
            rows.push(['Sprach-Hinweise', `${summary.speechCues}×`]);
            rows.push(['Beobachtete Zyklen', `${summary.cyclesObserved}`]);

            el.innerHTML = rows.map(([label, val]) => `
                <div class="settings-row"><div class="settings-label">${label}</div><span style="font-size:0.85rem;text-align:right">${val}</span></div>
            `).join('');
        }
    }

    async _restoreBreathPatternSelection() {
        const select = document.getElementById('breath-pattern-select');
        if (!select) return;
        const saved = await this.db.getSetting('breathPattern', 'coherent');
        if (BREATH_PATTERNS[saved]) {
            select.value = saved;
            const descEl = document.getElementById('breath-pattern-desc');
            if (descEl) descEl.textContent = BREATH_PATTERNS[saved].desc;
        }
    }

    _updateBreathPreview() {
        const el = document.getElementById('breath-preview-text');
        if (!el) return;
        const r = this.session.breathRhythm;
        const parts = [`${r.inhale} ms Einatmen`, `${r.exhale} ms Ausatmen`];
        if (r.holdIn)  parts.splice(1, 0, `${r.holdIn} ms Halten`);
        if (r.holdOut) parts.push(`${r.holdOut} ms Pause`);
        el.textContent = parts.join(' · ');
    }

    /**
     * Atemmuster anwenden (aus BREATH_PATTERNS).
     */
    async _applyBreathPattern(key) {
        const pattern = BREATH_PATTERNS[key];
        if (!pattern) return;
        const rhythm = pattern.rhythm === 'dynamic'
            ? resonantRhythmFromFreq(this.hrv.resonanceFreq)
            : { ...pattern.rhythm };
        this.session.breathRhythm = rhythm;
        await this.db.setSetting('breathRhythm', rhythm);
        await this.db.setSetting('breathPattern', key);
        this._updateBreathPreview();
        const descEl = document.getElementById('breath-pattern-desc');
        if (descEl) descEl.textContent = pattern.desc;
    }

    _setupBreathPatternUI() {
        const select = document.getElementById('breath-pattern-select');
        if (!select) return;
        select.addEventListener('change', (e) => this._applyBreathPattern(e.target.value));
    }

    _setSessionPhase(phase) {
        this.session.phase = phase;
        document.querySelectorAll('.phase-select-btn').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.phase) === phase);
        });

        // Live-Phase-Indikator (in session-active)
        const phaseNames = { 1: 'Atemtraining', 2: 'Biofeedback', 3: 'Selbsterzeugung', 4: 'Transfer' };
        const liveLabelEl = document.getElementById('live-phase-label');
        if (liveLabelEl) liveLabelEl.textContent = `Phase ${phase} · ${phaseNames[phase]}`;

        // UI-Anpassungen je Phase
        const pacerSection   = document.getElementById('pacer-section');
        const anchorSection  = document.getElementById('anchor-section');
        const pacerToggleRow = document.getElementById('pacer-toggle-row');
        const balloonSection = document.getElementById('balloon-section');

        if (phase === 1) {
            if (pacerSection)    pacerSection.style.display   = '';
            if (pacerToggleRow)  pacerToggleRow.style.display = 'none';
        } else if (phase === 3) {
            // Selbsterzeugung: Atemführung vollständig ausgeblendet
            if (pacerSection)    pacerSection.style.display   = 'none';
            if (pacerToggleRow)  pacerToggleRow.style.display = 'none';
        } else {
            // Phase 2/4: Pacer optional via Toggle
            const tog = document.getElementById('pacer-phase23-toggle');
            const showPacer = tog?.checked ?? false;
            if (pacerSection)    pacerSection.style.display   = showPacer ? '' : 'none';
            if (pacerToggleRow)  pacerToggleRow.style.display = '';
        }

        // Ballon-Section: nur Phase 3
        if (balloonSection) balloonSection.style.display = (phase === 3) ? '' : 'none';

        // Atemmuster-Auswahl: nur Phase 1 (in 2 optional, in 3/4 ausgeblendet)
        const patternRow  = document.getElementById('breath-pattern-row');
        const patternDesc = document.getElementById('breath-pattern-desc');
        const previewRow  = document.querySelector('.breath-preview-row');
        const showPattern = (phase === 1);
        if (patternRow)  patternRow.style.display  = showPattern ? '' : 'none';
        if (patternDesc) patternDesc.style.display = showPattern ? '' : 'none';
        if (previewRow)  previewRow.style.display  = showPattern ? '' : 'none';

        if (anchorSection)  anchorSection.style.display = (phase === 2 || phase === 3) ? '' : 'none';

        // Dauer-Selektor phasenspezifisch aktualisieren
        this._updateDurationSelector(phase);
        this.session.durationTarget = this.phaseDurations[phase];

        // Phase-Beschreibung (im Setup)
        const phaseDescriptions = {
            1: 'Geführtes Atemtraining — Folge dem Atempacer und beobachte deine Kohärenz.',
            2: 'Biofeedback-Training — Aktiviere deinen emotionalen Anker und steuere die Kohärenz.',
            3: 'Selbsterzeugung — Erzeuge Kohärenz aus innerer Haltung ohne externe Führung.',
            4: 'Transfer-Training — Erreiche Kohärenz in 60 Sekunden.',
        };
        const descEl = document.getElementById('phase-description');
        if (descEl) descEl.textContent = phaseDescriptions[phase] || '';
    }

    /**
     * Dauer-Selektor phasenspezifisch rendern und Event-Listener setzen
     */
    _updateDurationSelector(phase) {
        const container = document.getElementById('duration-selector');
        if (!container) return;

        const config  = PHASE_DURATIONS[phase];
        const current = this.phaseDurations[phase];

        if (phase === 3) {
            // Phase 3: Dropdown (mehr Optionen, kompakter)
            container.innerHTML = `
                <div class="duration-dropdown-wrap">
                    <label class="duration-dropdown-label" for="duration-dropdown-p3">Sessiondauer</label>
                    <select class="duration-dropdown" id="duration-dropdown-p3">
                        ${config.options.map((secs, i) => `
                            <option value="${secs}" ${secs === current ? 'selected' : ''}>${config.labels[i]}</option>
                        `).join('')}
                    </select>
                </div>
            `;
            const select = container.querySelector('#duration-dropdown-p3');
            select.addEventListener('change', async (e) => {
                const secs = parseInt(e.target.value);
                this.session.durationTarget = secs;
                this.phaseDurations[phase]  = secs;
                await this.db.setSetting('phaseDurations', this.phaseDurations);
            });
            return;
        }

        // Phasen 1, 2, 4: Buttons
        container.innerHTML = config.options.map((secs, i) => `
            <button class="duration-btn ${secs === current ? 'active' : ''}"
                    data-seconds="${secs}">
                ${config.labels[i]}
            </button>
        `).join('');

        container.querySelectorAll('.duration-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                container.querySelectorAll('.duration-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const secs = parseInt(btn.dataset.seconds);
                this.session.durationTarget   = secs;
                this.phaseDurations[phase]    = secs;
                await this.db.setSetting('phaseDurations', this.phaseDurations);
            });
        });
    }

    /**
     * Beste Minute der Session aus coherenceTimeline berechnen.
     * @returns {{start:number, end:number, avg:number}|null}
     */
    _bestMinute(timeline) {
        if (!timeline || timeline.length < 2) return null;
        let best = null;
        // Schiebefenster 60s
        for (let i = 0; i < timeline.length; i++) {
            const startT = timeline[i].t;
            const endT   = startT + 60;
            const window = timeline.filter(p => p.t >= startT && p.t < endT);
            if (window.length < 6) continue;       // Mindestens 6 FFT-Samples (~30s)
            const avg = window.reduce((s, p) => s + p.coh, 0) / window.length;
            if (!best || avg > best.avg) best = { start: startT, end: endT, avg };
        }
        return best;
    }

    /**
     * Post-Session Insight-Screen mit Best-Minute, Vergleich,
     * Spektrogramm-Heatmap und Empfehlung.
     */
    async _showSessionInsight(savedSession, baseline) {
        const screen = document.getElementById('post-session-screen');
        if (!screen) return;

        const setup = document.getElementById('session-setup');
        const active = document.getElementById('session-active');
        if (setup)  setup.style.display  = 'none';
        if (active) active.style.display = 'none';
        screen.style.display = '';

        // Best-Minute
        const best = this._bestMinute(this.session.coherenceTimeline);
        const bestEl = document.getElementById('insight-best-minute');
        if (bestEl) {
            if (best) {
                const m1 = Math.floor(best.start / 60);
                const s1 = best.start % 60;
                const m2 = Math.floor(best.end / 60);
                const s2 = best.end % 60;
                bestEl.innerHTML = `Beste Minute: <strong>${m1}:${s1.toString().padStart(2,'0')}–${m2}:${s2.toString().padStart(2,'0')}</strong> mit <strong>${Math.round(best.avg)}%</strong> Ø Kohärenz`;
            } else {
                bestEl.textContent = 'Beste Minute: zu wenig Daten';
            }
        }

        // Tile-Werte
        document.getElementById('insight-avg-coh').textContent      = `${savedSession.avgCoherence}%`;
        document.getElementById('insight-longest-streak').textContent = `${this.session.longestStreak}s`;
        document.getElementById('insight-avg-rmssd').textContent    = `${savedSession.avgRMSSD} ms`;

        // Baseline-Delta
        const bdEl = document.getElementById('insight-baseline-delta');
        if (bdEl) {
            if (baseline && savedSession.avgRMSSD > 0) {
                const delta = savedSession.avgRMSSD - baseline;
                const sign = delta >= 0 ? '+' : '';
                bdEl.textContent = `${sign}${delta} ms`;
                bdEl.style.color = delta >= 0 ? 'var(--accent-teal)' : 'var(--coh-mid-low)';
            } else {
                bdEl.textContent = '—';
            }
        }

        // Vergleich zur letzten Session derselben Phase
        const prevSessions = await this.db.getSessionsByPhase(savedSession.phase);
        const prev = prevSessions.filter(s => s.timestamp !== savedSession.timestamp).pop();
        const cohDeltaEl   = document.getElementById('insight-coh-delta');
        const rmssdDeltaEl = document.getElementById('insight-rmssd-delta');
        if (prev) {
            const cd = savedSession.avgCoherence - prev.avgCoherence;
            const rd = savedSession.avgRMSSD     - prev.avgRMSSD;
            if (cohDeltaEl)   { cohDeltaEl.textContent   = `${cd >= 0 ? '+' : ''}${cd}% vs letzte`; cohDeltaEl.style.color = cd >= 0 ? 'var(--accent-teal)' : 'var(--coh-mid-low)'; }
            if (rmssdDeltaEl) { rmssdDeltaEl.textContent = `${rd >= 0 ? '+' : ''}${rd} ms vs letzte`; rmssdDeltaEl.style.color = rd >= 0 ? 'var(--accent-teal)' : 'var(--coh-mid-low)'; }
        }

        // Spektrogramm-Heatmap rendern
        this._renderSpectrogram(this.session.spectrumTimeline);

        // Empfehlung
        const recEl = document.getElementById('insight-recommendation');
        if (recEl) recEl.textContent = this._coachingRecommendation(savedSession, this.session.longestStreak, best);

        // Fertig-Button
        const doneBtn = document.getElementById('insight-done-btn');
        if (doneBtn) {
            doneBtn.onclick = () => {
                screen.style.display = 'none';
                if (setup) setup.style.display = '';
            };
        }
    }

    /**
     * Spektrogramm rendern: 2D-Heatmap, X = Zeit (Sessionverlauf),
     * Y = Frequenz (0–0.4 Hz), Farbe = relative Spektral-Power.
     * Resonanzfrequenz als horizontale Cyan-Linie eingezeichnet.
     */
    _renderSpectrogram(timeline) {
        const canvas = document.getElementById('insight-spectrogram');
        if (!canvas || !timeline || timeline.length === 0) return;

        const W = canvas.width  = canvas.clientWidth  || 600;
        const H = canvas.height = 160;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = 'rgba(8,17,31,0.6)';
        ctx.fillRect(0, 0, W, H);

        const F_MAX = 0.4;   // bis 0.4 Hz (LF + HF)
        const colCount = timeline.length;
        const colW = W / colCount;

        // Globale Max-Power für Normalisierung
        let maxPow = 0;
        timeline.forEach(s => {
            for (let i = 0; i < s.freqs.length; i++) {
                if (s.freqs[i] <= F_MAX && s.power[i] > maxPow) maxPow = s.power[i];
            }
        });
        if (maxPow === 0) return;

        // Spalten zeichnen
        timeline.forEach((s, idx) => {
            const x = idx * colW;
            for (let i = 0; i < s.freqs.length - 1; i++) {
                const f = s.freqs[i];
                if (f > F_MAX) break;
                const y1 = H - (f       / F_MAX) * H;
                const y2 = H - (s.freqs[i + 1] / F_MAX) * H;
                const rel = Math.min(1, s.power[i] / maxPow);
                // Farbe: dunkelblau → cyan → gelb → magenta (heatmap)
                const hue = 240 - rel * 240;        // 240=blau, 0=rot
                const light = 15 + rel * 50;
                ctx.fillStyle = `hsla(${hue}, 80%, ${light}%, ${0.5 + rel * 0.5})`;
                ctx.fillRect(x, y2, Math.max(colW, 1), y1 - y2);
            }
        });

        // Resonanzfrequenz-Linie
        const resFreq = this.hrv.resonanceFreq;
        const yRes = H - (resFreq / F_MAX) * H;
        ctx.strokeStyle = 'rgba(0,212,255,0.9)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, yRes);
        ctx.lineTo(W, yRes);
        ctx.stroke();
        ctx.setLineDash([]);

        // Beschriftung
        ctx.fillStyle = 'rgba(0,212,255,0.9)';
        ctx.font = '10px system-ui';
        ctx.fillText(`Resonanz ${resFreq.toFixed(3)} Hz (${(resFreq*60).toFixed(1)}/min)`, 6, yRes - 4);

        // Achsen-Beschriftung
        ctx.fillStyle = 'rgba(122,155,192,0.7)';
        ctx.font = '9px system-ui';
        ctx.fillText('0.4 Hz', 4, 12);
        ctx.fillText('0 Hz',   4, H - 4);
    }

    _coachingRecommendation(s, longestStreak, best) {
        if (s.avgCoherence >= 75 && longestStreak >= 60) {
            return '✨ Exzellent. Probier nächstes Mal Phase 3 mit längerer Dauer (+2 Min).';
        }
        if (s.avgCoherence >= 55) {
            return '👍 Solide Session. Halte den Atemrhythmus konstant — die Kohärenz baut sich kumulativ auf.';
        }
        if (longestStreak < 15) {
            return '💡 Tipp: Versuch das Box-Muster (4-4-4-4) oder die individuelle Resonanzfrequenz für gleichmäßigere Wellen.';
        }
        return '🌱 Üben hilft — schon kurze Kohärenzphasen trainieren den Vagusnerv. Bleib dran.';
    }

    /**
     * Protokoll 3 — 5-Minuten-Check vor der Session: prüft, ob die gespeicherte
     * Resonanzfrequenz heute abweicht (5 Kandidaten ±1,0 bpm, zyklus-ausgerichtete
     * HRmax−HRmin-Messung), und blendet eine Abweichung gedämpft ein. Läuft nur
     * einmal pro Tag (außer this._forceDailyCheck ist gesetzt). Resolvet wenn
     * fertig oder übersprungen.
     */
    async _runDailyCheck() {
        const screen = document.getElementById('p1cal-screen');
        if (!screen) return;

        const forceRun = this._forceDailyCheck === true;
        this._forceDailyCheck = false;

        if (!forceRun) {
            const already = await this.db.getTodaysDailyCheck();
            if (already) return; // heute schon gelaufen — sofort weiter zur Session
        }

        // ── Setup ────────────────────────────────────────────────────────────
        this.hrv.reset();
        document.getElementById('session-setup').style.display = 'none';
        screen.style.display = '';

        const ring       = document.getElementById('p1cal-ring');
        const countEl    = document.getElementById('p1cal-countdown');
        const titleEl     = document.getElementById('p1cal-title');
        const subtitleEl  = document.getElementById('p1cal-subtitle');
        const freqEl      = document.getElementById('p1cal-freq');
        const pacerWrap   = document.getElementById('p1cal-pacer-wrap');
        const skipBtn     = document.getElementById('p1cal-skip-btn');
        const circ        = 2 * Math.PI * 54;

        this._p1calSetStep(0);
        if (titleEl)    titleEl.textContent    = '5-Minuten-Check';
        if (subtitleEl) subtitleEl.textContent = 'Prüft, ob deine Frequenz heute abweicht';
        if (pacerWrap)  pacerWrap.style.display = 'none';
        if (freqEl)     freqEl.style.display    = 'none';
        if (countEl)    countEl.textContent     = '';
        if (ring)       { ring.style.strokeDasharray = circ; ring.style.strokeDashoffset = circ; }

        let skipped = false;
        let resolveSkip;
        const skipPromise = new Promise(r => { resolveSkip = r; });
        if (skipBtn) skipBtn.onclick = () => { skipped = true; resolveSkip(); };

        const storedRhythm = this.session.breathRhythm
            ?? await this.db.getSetting('breathRhythm', { inhale: 5000, holdIn: 0, exhale: 5000, holdOut: 0 });

        await Promise.race([new Promise(r => setTimeout(r, 1000)), skipPromise]);
        if (skipped) { screen.style.display = 'none'; document.getElementById('session-setup').style.display = ''; return; }

        this._p1calSetStep(1);
        if (pacerWrap) pacerWrap.style.display = '';

        const check = new DailyCheck(this.hrv, this.db, storedRhythm);

        check.onRhythmChange = (rhythm) => this._calibSetPacer('p1cal-pacer-container', 'p1cal-breath-label', rhythm, check);
        check.onCandidateStart = (idx, total, bpm) => {
            if (titleEl)    titleEl.textContent    = `Kandidat ${idx + 1} / ${total}`;
            if (subtitleEl) subtitleEl.textContent = 'Folge dem Atempunkt';
            if (freqEl)     { freqEl.textContent = `${bpm.toFixed(2)} Atemz/min`; freqEl.style.display = ''; }
            if (countEl)    countEl.textContent = `${idx + 1}/${total}`;
            if (ring)       ring.style.strokeDashoffset = circ * (1 - idx / total);
        };

        const finished = new Promise(resolve => {
            check.onComplete   = (winner) => resolve(winner);
            check.onCancelled  = () => resolve(null);
        });

        check.start();
        const winner = await Promise.race([finished, skipPromise.then(() => { check.stop(); return null; })]);
        this._calibStopPacer();

        if (!winner) { screen.style.display = 'none'; document.getElementById('session-setup').style.display = ''; return; }

        this._p1calSetStep(2);
        if (pacerWrap) pacerWrap.style.display = 'none';
        if (freqEl)    freqEl.style.display    = 'none';

        this.session.breathRhythm = winner.rhythm;

        if (titleEl)    titleEl.textContent    = `Angepasst: ${winner.bpm.toFixed(2)} Atemz/min`;
        if (subtitleEl) subtitleEl.textContent =
            `${(winner.rhythm.inhale / 1000).toFixed(1)}s ein  ·  ${(winner.rhythm.exhale / 1000).toFixed(1)}s aus`;
        if (countEl) countEl.textContent = '✓';
        if (ring)    ring.style.strokeDashoffset = '0';

        await new Promise(r => setTimeout(r, 1800));
        screen.style.display = 'none';
    }

    /**
     * Gemeinsamer BreathPacer-Helfer für die Kalibrierungs-Protokolle:
     * startet einen neuen Pacer mit gegebenem Rhythmus und leitet dessen
     * Phasenwechsel an den laufenden Test (CalibrationTestBase) weiter.
     */
    _calibSetPacer(containerId, labelId, rhythm, test, countdownId) {
        this._calibStopPacer();
        const cont     = document.getElementById(containerId);
        const label    = document.getElementById(labelId);
        const countdown = countdownId ? document.getElementById(countdownId) : null;
        if (!cont) return;
        this.pacer = new BreathPacer(cont, rhythm, label, countdown, this.audio);
        this.pacer.onPhaseChange = (phase) => test.notifyPhaseChange(phase);
        this.pacer.start();
    }

    _calibStopPacer() {
        if (this.pacer) { this.pacer.stop(); this.pacer.destroy(); this.pacer = null; }
    }

    /** Schritt-Dots der Kalibrierungs-Screens aktualisieren (0=Start, 1=Scan, 2=Ergebnis) */
    _p1calSetStep(step) {
        for (let i = 0; i <= 2; i++) {
            const dot = document.getElementById(`p1cal-dot-${i}`);
            if (!dot) continue;
            dot.classList.toggle('p1cal-active', i === step);
            dot.classList.toggle('p1cal-done',   i < step);
        }
    }

    /**
     * @param {Promise} resolve
     */
    _runBodyScan() {
        return new Promise((resolve) => {
            const screen      = document.getElementById('body-scan-screen');
            const setup       = document.getElementById('session-setup');
            const stepEl      = document.getElementById('body-scan-step');
            const countdownEl = document.getElementById('body-scan-countdown');
            const ring        = document.getElementById('body-scan-ring');
            const baselineEl  = document.getElementById('body-scan-baseline');
            const skipBtn     = document.getElementById('body-scan-skip-btn');

            if (!screen) { resolve(); return; }

            // HRV-Puffer für Baseline starten (frischer Buffer)
            this.hrv.reset();
            this._bodyScanFFT = null;

            setup.style.display   = 'none';
            screen.style.display  = '';

            const TOTAL = 60;
            let remaining = TOTAL;
            const circ = 2 * Math.PI * 54;
            if (ring) { ring.style.strokeDasharray = circ; ring.style.strokeDashoffset = circ; }

            const STEPS = [
                { from: 60, to: 45, text: 'Sitze aufrecht — entspanne die Schultern' },
                { from: 45, to: 30, text: 'Lenke die Aufmerksamkeit auf dein Herz' },
                { from: 30, to: 15, text: 'Atme natürlich — beobachte den Atem' },
                { from: 15, to: 0,  text: 'Baseline wird gemessen — bleib weich…' },
            ];

            const finish = () => {
                clearInterval(this.bodyScanTimer);
                this.bodyScanTimer = null;
                // Baseline-RMSSD (aus den letzten 30s)
                if (this.hrv.dataSpanSeconds >= 10) {
                    this.bodyScanBaseline = Math.round(this.hrv.rmssd());
                } else {
                    this.bodyScanBaseline = null;
                }
                // FFT mit Body-Scan-Daten → Vorkalibrierung der Kohärenz-Welle
                if (this.hrv.dataSpanSeconds >= 30) {
                    const fft = this.hrv.frequencyAnalysis();
                    if (fft) {
                        this.hrv.updateResonanceFrequency();
                        this._bodyScanFFT = fft;
                    }
                }
                screen.style.display = 'none';
                resolve();
            };

            this.bodyScanTimer = setInterval(() => {
                remaining--;
                const elapsed = TOTAL - remaining;
                const progress = elapsed / TOTAL;
                if (countdownEl) countdownEl.textContent = remaining;
                if (ring) ring.style.strokeDashoffset = circ * (1 - progress);

                const step = STEPS.find(s => remaining <= s.from && remaining > s.to) || STEPS[STEPS.length - 1];
                if (stepEl) stepEl.textContent = step.text;

                // Baseline-Vorschau (ab Sekunde 30)
                if (elapsed >= 30 && baselineEl && this.hrv.dataSpanSeconds >= 10) {
                    const rmssd = Math.round(this.hrv.rmssd());
                    baselineEl.textContent = `Baseline-RMSSD: ${rmssd} ms`;
                }

                if (remaining <= 0) finish();
            }, 1000);

            if (skipBtn) skipBtn.onclick = finish;
        });
    }

    async _startSession(phase) {
        if (!this.ble.isConnected) {
            const shouldConnect = confirm('Polar H10 ist nicht verbunden. Jetzt verbinden?');
            if (shouldConnect) {
                const ok = await this._connectBluetooth();
                if (!ok) return;
            } else return;
        }

        // Navigation zur Training-View
        if (this.currentView !== 'training') {
            this._navigateTo('training');
        }

        this._setSessionPhase(phase);

        if (phase === 1) {
            // Phase 1: Protokoll-3-Check (5 Min, einmal pro Tag) → optimale Frequenz bestätigen/anpassen
            await this._runDailyCheck();
        } else {
            // Andere Phasen: optionaler Body-Scan
            if (this.bodyScanEnabled) await this._runBodyScan();
            else this.hrv.reset();
        }

        this.session.active          = true;
        this.session.startTime       = Date.now();
        this.session.coherenceLog    = [];
        this.session.rmssdLog        = [];
        this.session.lfhfLog         = [];
        this.session.firstCoherenceAt = null;
        this.session.currentStreak    = 0;
        this.session.longestStreak    = 0;
        this.session.streakSince      = null;
        this.session.coherenceTimeline = [];
        this.session.spectrumTimeline  = [];

        // Setup ausblenden, Active-Bereich einblenden
        document.getElementById('session-setup').style.display  = 'none';
        document.getElementById('session-active').style.display = '';

        // Canvas-Visualizer initialisieren
        const rrCanvas = document.getElementById('rr-canvas');
        if (rrCanvas) {
            if (this.visualizer) this.visualizer.destroy();
            this.visualizer = new RRVisualizer(rrCanvas);
            this.visualizer.start();
        }

        const specCanvas = document.getElementById('spectrum-canvas');
        if (specCanvas) {
            if (this.spectrum) this.spectrum.destroy();
            this.spectrum = new SpectrumVisualizer(specCanvas);
        }

        // Atempacer (nur Phase 1) — mit Audio + externe Label-Elemente
        if (phase === 1) {
            const pacerContainer = document.getElementById('pacer-container');
            const labelEl        = document.getElementById('breath-phase-label');
            const countdownEl    = document.getElementById('breath-countdown');
            if (pacerContainer) {
                if (this.pacer) this.pacer.destroy();
                this.pacer = new BreathPacer(
                    pacerContainer,
                    this.session.breathRhythm, // in Millisekunden
                    labelEl,
                    countdownEl,
                    this.audio
                );
                this.pacer.onPhaseChange = (p) => this._onBreathPhase(p);
                this.pacer.start();
            }
        } else {
            if (this.pacer) this.pacer.stop();
        }

        // Feldtest im Hintergrund starten, wenn aktiv
        if (this.zone2 && document.getElementById('z2-feld-toggle')?.checked) {
            this.zone2.startFeldTestSession();
            this._updateFeldPanel();
        }

        // Tachogramm für Phase 3
        if (this.tacho) { this.tacho.destroy(); this.tacho = null; }
        if (phase === 3) {
            const tachoCanvas = document.getElementById('tacho-canvas');
            if (tachoCanvas) this.tacho = new TachogramVisualizer(tachoCanvas);
        }

        // Kohärenz-Welle Overlay + Coaching-Engine (Phase 3)
        if (this.coherenceWave) { this.coherenceWave.destroy(); this.coherenceWave = null; }
        if (this.coachEngine)   { this.coachEngine.reset();     this.coachEngine   = null; }
        if (phase === 3) {
            const waveCanvas = document.getElementById('coherence-wave-canvas');
            if (waveCanvas) {
                this.coherenceWave = new CoherenceWaveOverlay(waveCanvas);
                this._preseedCoherenceWave();   // Body-Scan-Daten sofort einladen
                this.coherenceWave.start();
            }
            this.coachEngine = new CoachingEngine();
            // Coaching-Zustand aus Body-Scan-Daten vorinitialisieren
            if (this._bodyScanFFT) {
                this.coachEngine.update(
                    this._bodyScanFFT.coherenceScore,
                    this.hrv.dataSpanSeconds
                );
            }
        }

        // Ballon-RSA-Update alle 2s (Phase 3)
        clearInterval(this.balloonInterval);
        if (phase === 3) {
            this.balloonInterval = setInterval(() => {
                if (!this.session.active) return;
                const rsa = this.hrv.rsaAmplitude();
                const coh = this.hrv.coherenceScore / 100;
                this._updateBalloon(coh, rsa);
            }, 2000);
            // Resonanz-Anker-Puls starten (sofern Toggle an)
            if (this.pulseEnabled) this._startResonancePulse();
        }

        // FFT-Analyse alle 5 Sekunden
        this.fftInterval = setInterval(() => this._runFFT(), 5000);

        // Sonifikation starten (Closed-Loop Audio-Biofeedback)
        this.audio.unlock();
        this.audio.start();

        // Session-Timer
        this._sessionTimer();

        // Status
        const statusEl = document.getElementById('session-status');
        if (statusEl) statusEl.textContent = 'Aufzeichnung läuft...';

        this._updateQualityIndicator();
    }

    _onBreathPhase(_phase) {
        // Audio is handled directly by BreathPacer via the audio instance
    }

    async _stopSession() {
        if (!this.session.active) return;

        this.session.active = false;
        clearInterval(this.fftInterval);
        clearInterval(this.balloonInterval);
        if (this.pacer)     this.pacer.stop();
        if (this.visualizer) this.visualizer.stop();
        if (this.tacho)         { this.tacho.destroy(); this.tacho = null; }
        if (this.coherenceWave) { this.coherenceWave.destroy(); this.coherenceWave = null; }
        if (this.coachEngine)   { this.coachEngine = null; }
        const coachEl = document.getElementById('coach-text');
        if (coachEl) { coachEl.className = 'coach-text'; coachEl.textContent = ''; }
        if (this.zone2)     this.zone2.stopFeldTestSession();
        if (this.audio)     this.audio.stop();
        this._stopResonancePulse();

        // Session speichern
        const duration = Math.round((Date.now() - this.session.startTime) / 1000);
        const avgCoherence = this.session.coherenceLog.length
            ? Math.round(this.session.coherenceLog.reduce((a, b) => a + b, 0) / this.session.coherenceLog.length)
            : 0;
        const peakCoherence = this.session.coherenceLog.length
            ? Math.round(Math.max(...this.session.coherenceLog))
            : 0;
        const avgRMSSD = this.session.rmssdLog.length
            ? Math.round(this.session.rmssdLog.reduce((a, b) => a + b, 0) / this.session.rmssdLog.length)
            : 0;
        const peakRMSSD = this.session.rmssdLog.length
            ? Math.round(Math.max(...this.session.rmssdLog))
            : 0;

        const savedSession = {
            phase:           this.session.phase,
            durationSeconds: duration,
            avgCoherence,
            peakCoherence,
            avgRMSSD,
            peakRMSSD,
            lfhfRatio:   this.hrv.lastFFTResult?.lfHfRatio ?? 0,
            breathRhythm: this.session.breathRhythm,
            anchorId:    this.session.anchorId,
            anchorName:  this.session.anchorName,
            timeToCoherence: this.session.firstCoherenceAt,
            coherenceData: this.session.coherenceLog,
            longestStreak: this.session.longestStreak,
            bodyScanBaseline: this.bodyScanBaseline,
        };
        await this.db.saveSession(savedSession);

        // Resonanzfrequenz verfeinern und speichern
        const newFreq = this.hrv.updateResonanceFrequency();
        if (newFreq) await this.db.setSetting('resonanceFreq', newFreq);
        await this.db.setSetting('breathRhythm', this.session.breathRhythm);

        // Active ausblenden
        document.getElementById('session-active').style.display = 'none';
        this._updateBreathPreview();

        const statusEl = document.getElementById('session-status');
        if (statusEl) statusEl.textContent = '';

        // Post-Session Insight nur bei Einzel-Session (nicht zwischen Volltraining-Phasen)
        if (!this.fullTraining.active) {
            await this._showSessionInsight(savedSession, this.bodyScanBaseline);
        } else {
            document.getElementById('session-setup').style.display = '';
        }

        // Volles Training: weiter zur nächsten Phase oder Gesamtzusammenfassung
        if (this.fullTraining.active) {
            this.fullTraining.phaseStats.push({ phase: this.session.phase, avgCoherence, peakCoherence, avgRMSSD, duration });
            const nextIdx = this.fullTraining.currentIdx + 1;
            if (nextIdx < this.fullTraining.phases.length) {
                this._showPhaseTransition(nextIdx, avgCoherence, avgRMSSD);
            } else {
                this._showFullTrainingSummary();
            }
        } else {
            this._showSessionSummary(avgCoherence, peakCoherence, avgRMSSD, duration);
        }
    }

    _showSessionSummary(avgCoherence, peakCoherence, avgRMSSD, duration) {
        const modal = document.getElementById('session-summary-modal');
        if (!modal) return;

        document.getElementById('summary-avg-coh').textContent   = avgCoherence + '%';
        document.getElementById('summary-peak-coh').textContent  = peakCoherence + '%';
        document.getElementById('summary-rmssd').textContent     = avgRMSSD + ' ms';
        document.getElementById('summary-duration').textContent  = Math.round(duration / 60) + ' min';

        // Resonanz-Empfehlung
        const recEl = document.getElementById('summary-recommendation');
        if (recEl) {
            const optRate = this.hrv.breathRateFromResonance;
            recEl.textContent = `Optimale Atemfrequenz: ca. ${optRate} Atemzüge/Min.`;
        }

        modal.classList.add('active');

        modal.querySelector('.modal-close')?.addEventListener('click', () => {
            modal.classList.remove('active');
        });
    }

    // ─── Volles Training ─────────────────────────────────────────────────────

    _toggleFullTraining(enabled) {
        this.fullTraining.active = enabled;

        const config        = document.getElementById('full-training-config');
        const regularDur    = document.getElementById('duration-selector');
        const phase4Btn     = document.querySelector('[data-phase="4"]');
        const startBtn      = document.getElementById('session-start-btn');
        const phaseSelector = document.querySelector('.phase-selector');

        if (enabled) {
            config.style.display     = '';
            regularDur.style.display = 'none';
            if (phase4Btn)     phase4Btn.disabled    = true;
            if (phaseSelector) phaseSelector.style.opacity = '0.4';
            if (startBtn)      startBtn.textContent  = 'Volles Training starten';
            this._updateFullTrainingDurationSelectors();
            // Phase auf 1 setzen (Startphase)
            this.session.phase = 1;
            document.querySelectorAll('.phase-select-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.phase === '1');
            });
        } else {
            config.style.display     = 'none';
            regularDur.style.display = '';
            if (phase4Btn)     phase4Btn.disabled    = false;
            if (phaseSelector) phaseSelector.style.opacity = '1';
            if (startBtn)      startBtn.textContent  = 'Session starten';
            this._updateDurationSelector(this.session.phase);
        }
    }

    _updateFullTrainingDurationSelectors() {
        [1, 2, 3].forEach(phase => {
            const container = document.getElementById(`full-duration-p${phase}`);
            if (!container) return;
            const config  = PHASE_DURATIONS[phase];
            const current = this.fullTraining.durations[phase];

            if (phase === 3) {
                container.innerHTML = `
                    <select class="duration-dropdown" id="full-duration-dropdown-p3">
                        ${config.options.map((secs, i) => `
                            <option value="${secs}" ${secs === current ? 'selected' : ''}>${config.labels[i]}</option>
                        `).join('')}
                    </select>
                `;
                const select = container.querySelector('#full-duration-dropdown-p3');
                select.addEventListener('change', (e) => {
                    this.fullTraining.durations[phase] = parseInt(e.target.value);
                });
                return;
            }

            container.innerHTML = config.options.map((secs, i) => `
                <button class="duration-btn ${secs === current ? 'active' : ''}" data-seconds="${secs}">
                    ${config.labels[i]}
                </button>
            `).join('');

            container.querySelectorAll('.duration-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    container.querySelectorAll('.duration-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    this.fullTraining.durations[phase] = parseInt(btn.dataset.seconds);
                });
            });
        });
    }

    async _startFullTraining() {
        this.fullTraining.currentIdx = 0;
        this.fullTraining.phaseStats = [];
        const firstPhase = this.fullTraining.phases[0];
        this.phaseDurations[firstPhase] = this.fullTraining.durations[firstPhase];
        this._updateFullTrainingProgress(0);
        await this._startSession(firstPhase);
    }

    _updateFullTrainingProgress(currentIdx) {
        const progressEl = document.getElementById('full-training-progress');
        if (!progressEl) return;
        progressEl.style.display = this.fullTraining.active ? '' : 'none';

        progressEl.querySelectorAll('.full-progress-dot').forEach((dot, i) => {
            dot.classList.remove('active', 'done');
            if (i < currentIdx)      dot.classList.add('done');
            else if (i === currentIdx) dot.classList.add('active');
        });
        progressEl.querySelectorAll('.full-progress-line').forEach((line, i) => {
            line.classList.toggle('done', i < currentIdx);
        });
    }

    _showPhaseTransition(nextIdx, lastAvgCoherence, lastAvgRMSSD) {
        const nextPhase = this.fullTraining.phases[nextIdx];
        const phaseNames = { 1: 'Atemtraining', 2: 'Biofeedback-Training', 3: 'Selbsterzeugung' };

        const overlay = document.getElementById('phase-transition-overlay');
        if (!overlay) return;

        document.getElementById('transition-done-phase').textContent  = this.session.phase;
        document.getElementById('transition-next-name').textContent   = `Phase ${nextPhase} · ${phaseNames[nextPhase]}`;
        document.getElementById('transition-stats').innerHTML = `
            <div class="transition-stat">
                <div class="transition-stat-value" style="color:${this._coherenceColor(lastAvgCoherence)}">${lastAvgCoherence}%</div>
                <div class="transition-stat-label">Ø Kohärenz</div>
            </div>
            <div class="transition-stat">
                <div class="transition-stat-value">${lastAvgRMSSD} ms</div>
                <div class="transition-stat-label">Ø RMSSD</div>
            </div>
        `;

        overlay.classList.add('active');

        // Countdown
        let count = 10;
        document.getElementById('transition-countdown').textContent = count;
        clearInterval(this.fullTraining.transitionTimer);
        this.fullTraining.transitionTimer = setInterval(() => {
            count--;
            const el = document.getElementById('transition-countdown');
            if (el) el.textContent = count;
            if (count <= 0) {
                clearInterval(this.fullTraining.transitionTimer);
                this._advanceToNextPhase(nextIdx);
            }
        }, 1000);

        // Jetzt starten
        document.getElementById('transition-now-btn').onclick = () => {
            clearInterval(this.fullTraining.transitionTimer);
            this._advanceToNextPhase(nextIdx);
        };

        // Training beenden
        document.getElementById('transition-stop-btn').onclick = () => {
            clearInterval(this.fullTraining.transitionTimer);
            overlay.classList.remove('active');
            this.fullTraining.active = false;
            document.getElementById('full-training-toggle').checked = false;
            this._toggleFullTraining(false);
            this._showFullTrainingSummary();
        };
    }

    async _advanceToNextPhase(nextIdx) {
        const overlay = document.getElementById('phase-transition-overlay');
        if (overlay) overlay.classList.remove('active');

        this.fullTraining.currentIdx = nextIdx;
        const nextPhase = this.fullTraining.phases[nextIdx];
        this.phaseDurations[nextPhase] = this.fullTraining.durations[nextPhase];
        this._updateFullTrainingProgress(nextIdx);
        await this._startSession(nextPhase);
    }

    _showFullTrainingSummary() {
        const stats = this.fullTraining.phaseStats;
        if (stats.length === 0) return;

        const avgCoherence  = Math.round(stats.reduce((a, s) => a + s.avgCoherence, 0)  / stats.length);
        const peakCoherence = Math.max(...stats.map(s => s.peakCoherence));
        const avgRMSSD      = Math.round(stats.reduce((a, s) => a + s.avgRMSSD, 0)      / stats.length);
        const totalDuration = stats.reduce((a, s) => a + s.duration, 0);

        // Fortschrittsanzeige verstecken
        const progressEl = document.getElementById('full-training-progress');
        if (progressEl) progressEl.style.display = 'none';

        this._showSessionSummary(avgCoherence, peakCoherence, avgRMSSD, totalDuration);
    }

    _sessionTimer() {
        if (!this.session.active) return;

        const elapsed = Math.round((Date.now() - this.session.startTime) / 1000);
        const remaining = Math.max(0, this.session.durationTarget - elapsed);

        const timerEl = document.getElementById('session-timer');
        if (timerEl) {
            const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
            const secs = (elapsed % 60).toString().padStart(2, '0');
            timerEl.textContent = `${mins}:${secs}`;
        }

        const remainEl = document.getElementById('session-remaining');
        if (remainEl) {
            const m = Math.floor(remaining / 60);
            const s = remaining % 60;
            remainEl.textContent = `${m}:${s.toString().padStart(2, '0')} verbleibend`;
        }

        // Automatisch beenden wenn Zeit abgelaufen
        if (remaining === 0) {
            this._stopSession();
            return;
        }

        // Qualitäts-Indikator
        if (elapsed % 5 === 0) this._updateQualityIndicator();

        setTimeout(() => this._sessionTimer(), 1000);
    }

    _runFFT() {
        const result = this.hrv.frequencyAnalysis();
        if (!result) return;

        const score   = result.coherenceScore;
        const elapsed = Date.now() - this.session.startTime;
        const tSec    = Math.round(elapsed / 1000);

        // ── Echtzeit-UI: bei jedem Aufruf (alle 5s) ──────────────────────────
        if (this.visualizer) this.visualizer.setCoherence(score);
        if (this.spectrum)   this.spectrum.update(result.frequencies, result.power, result.resonanceFreq);

        // Kohärenz-Welle + Coaching (Phase 3)
        if (this.coherenceWave) {
            this.coherenceWave.setFFTResult(result, this.hrv.practicalBreathFreq);
            this.coherenceWave.setCoherence(score);
        }
        if (this.coachEngine) {
            const instr = this.coachEngine.update(score, this.hrv.dataSpanSeconds);
            this._updateCoachText(instr);
        }

        // Streak-Tracking (Kohärenz ≥ 70%)
        this._updateCoherenceStreak(score, tSec);

        // Zeitleiste für Best-Minute & Spektrogramm
        this.session.coherenceTimeline.push({ t: tSec, coh: score });
        this.session.spectrumTimeline.push({
            t: tSec,
            freqs: Array.from(result.frequencies),
            power: Array.from(result.power),
        });

        // Phase-3-Ballon: Kohärenz-Farbe und Tachogramm-Farbe aktualisieren
        if (this.session.phase === 3) {
            if (this.tacho) this.tacho.setCoherence(score);
            const rsa = this.hrv.rsaAmplitude();
            this._updateBalloon(score / 100, rsa);
        }

        this._updateLiveStats({
            coherence: score,
            lfhf:      result.lfHfRatio,
            resonance: result.resonanceFreq,
        });

        // Erste Kohärenz-Phase (>50%) markieren
        if (!this.session.firstCoherenceAt && score > 50) {
            this.session.firstCoherenceAt = Math.round(elapsed / 1000);
        }

        // ── Statistik-Logging: nur alle 30s (nach mind. 60s Laufzeit) ────────
        // Verhindert, dass frühe instabile Werte den Session-Durchschnitt verzerren
        if (elapsed >= 60000 && Math.round(elapsed / 1000) % 30 === 0) {
            this.session.coherenceLog.push(score);
            this.session.lfhfLog.push(result.lfHfRatio);
        }
    }

    /**
     * Resonanz-Anker: sanfte Skalenpulsation am Ballon auf
     * individueller Resonanzfrequenz (Standard 0.1 Hz = 6/min).
     * Visueller Anker ohne Pacer-Zwang — Nutzer kann mitatmen.
     */
    _startResonancePulse() {
        this._stopResonancePulse();
        const wrapper = document.getElementById('balloon-wrapper');
        if (!wrapper) return;
        const startTime = performance.now();
        const tick = (now) => {
            if (!this.pulseEnabled || !this.session.active || this.session.phase !== 3) {
                this._stopResonancePulse();
                wrapper.style.setProperty('--pulse-scale', '1');
                return;
            }
            const freq = this.hrv.resonanceFreq || 0.1;           // Hz
            const periodMs = 1000 / freq;
            const t = ((now - startTime) % periodMs) / periodMs;  // 0..1
            // Sinus → 0.97..1.03 (3 % Skalierung, sehr subtil)
            const scale = 1 + 0.03 * Math.sin(t * 2 * Math.PI);
            wrapper.style.setProperty('--pulse-scale', scale.toFixed(4));
            this.pulseRAF = requestAnimationFrame(tick);
        };
        this.pulseRAF = requestAnimationFrame(tick);
        // Label aktualisieren
        const bpmLabel = document.getElementById('resonance-bpm-label');
        if (bpmLabel) bpmLabel.textContent = (this.hrv.practicalBreathFreq * 60).toFixed(1);
    }

    _stopResonancePulse() {
        if (this.pulseRAF) cancelAnimationFrame(this.pulseRAF);
        this.pulseRAF = null;
    }

    /**
     * Kohärenz-Streak aktualisieren (Schwelle 70%).
     * Streak zählt durchgängige Sekunden mit Kohärenz ≥ 70%.
     */
    _updateCoherenceStreak(score, tSec) {
        const THRESHOLD = 70;
        if (score >= THRESHOLD) {
            if (this.session.streakSince === null) this.session.streakSince = tSec;
            this.session.currentStreak = tSec - this.session.streakSince;
            if (this.session.currentStreak > this.session.longestStreak) {
                this.session.longestStreak = this.session.currentStreak;
            }
        } else {
            this.session.currentStreak = 0;
            this.session.streakSince   = null;
        }
        // Live-Anzeige
        const streakEl = document.getElementById('balloon-streak-value');
        if (streakEl) {
            const s = this.session.currentStreak;
            streakEl.textContent = s > 0 ? `${s}s` : '—';
            streakEl.style.color = s > 0 ? 'var(--accent-teal)' : '';
        }
    }

    /**
     * Kohärenz-Welle mit den RR-Daten aus dem Body-Scan vorbelegen.
     * Rekonstruiert absolute Zeitstempel aus dem kumulativen HRV-Puffer.
     * Setzt Resonanzfrequenz, Phase-Anker und Amplitude aus dem Body-Scan-FFT.
     */
    _preseedCoherenceWave() {
        if (!this.coherenceWave) return;
        const rr = this.hrv.rrBuffer;
        const ts = this.hrv.rrTimestamps;
        if (rr.length < 4 || ts.length < 4) return;

        // Letzter Schlag = jetzt; zurückrechnen auf absolute Timestamps
        const now       = Date.now();
        const lastCumTs = ts[ts.length - 1];
        const windowMs  = this.coherenceWave.windowSec * 1000;

        for (let i = 0; i < rr.length; i++) {
            const absTs = now - (lastCumTs - ts[i]);
            if (now - absTs > windowMs) continue;   // außerhalb Fenster
            this.coherenceWave.hrData.push({ ts: absTs, hr: 60000 / rr[i] });
        }

        if (this.coherenceWave.hrData.length === 0) return;

        // Phase-Anker auf erstes Datenpunkt setzen
        this.coherenceWave._refOrigin = this.coherenceWave.hrData[0].ts;

        // Initiale Amplitude aus den vorgeladenen Daten
        const hrs = this.coherenceWave.hrData.map(d => d.hr);
        const amp = (Math.max(...hrs) - Math.min(...hrs)) / 2;
        if (amp > 0) this.coherenceWave._smoothAmp = amp;

        // Resonanzfrequenz aus Body-Scan-FFT
        const fft = this._bodyScanFFT;
        if (fft) {
            // Praktische Frequenz: 2. Harmonische wenn Grundfrequenz < 4.5/min
            this.coherenceWave.resonanceFreq = this.hrv.practicalBreathFreq;
            this.coherenceWave.setCoherence(fft.coherenceScore ?? 0);
        } else {
            this.coherenceWave.resonanceFreq = this.hrv.practicalBreathFreq;
        }
    }

    /** Coach-Text-Element mit aktuellem Coaching-Zustand aktualisieren */
    _updateCoachText(instr) {
        const el = document.getElementById('coach-text');
        if (!el || !instr) return;
        el.className  = `coach-text state-${instr.state}`;
        el.textContent = instr.message ?? '';
    }

    /**
     * Heißluftballon-Feedback für Phase 3 aktualisieren.
     * @param {number} coherenceRatio - 0..1 (coherenceScore / 100)
     * @param {number} rsaAmplitude   - bpm (Herzfrequenz-Spanne im 10s-Fenster)
     */
    _updateBalloon(coherenceRatio, rsaAmplitude) {
        const wrapper = document.getElementById('balloon-wrapper');
        const body    = document.getElementById('balloon-body');
        if (!wrapper || !body) return;

        // Höhe: 5 % (Boden) bis 85 % (Decke) → 0–30 bpm Amplitude
        const heightPct = 5 + Math.min(rsaAmplitude / 30, 1) * 80;
        wrapper.style.bottom = `${heightPct.toFixed(1)}%`;

        // Farbe per Kohärenz-Ratio → HSL-Gradient laut Spec
        let hue;
        const c = coherenceRatio;
        if      (c < 0.2) hue = 0;
        else if (c < 0.5) hue = 20  + ((c - 0.2) / 0.3) * 40;   // 20–60°
        else if (c < 0.8) hue = 90  + ((c - 0.5) / 0.3) * 30;   // 90–120°
        else              hue = 140 + ((c - 0.8) / 0.2) * 30;    // 140–170°
        body.setAttribute('fill', `hsl(${Math.round(hue)},80%,55%)`);

        // Animation: Schwanken (niedrige Kohärenz) oder Aufsteigen (hohe Kohärenz)
        wrapper.classList.remove('sway', 'rise');
        if      (c < 0.4) wrapper.classList.add('sway');
        else if (c > 0.7) wrapper.classList.add('rise');

        // Meilenstein-Highlights
        const star    = document.getElementById('milestone-star');
        const cloud20 = document.getElementById('milestone-cloud-20');
        const cloud15 = document.getElementById('milestone-cloud-15');
        if (star)    star.style.opacity    = rsaAmplitude >= 25 ? '1' : '0.35';
        if (cloud20) cloud20.style.opacity = rsaAmplitude >= 20 ? '1' : '0.35';
        if (cloud15) cloud15.style.opacity = rsaAmplitude >= 15 ? '1' : '0.35';

        // Kurzstatistiken
        const rsaEl = document.getElementById('balloon-rsa-value');
        const cohEl = document.getElementById('balloon-coherence-value');
        if (rsaEl) rsaEl.textContent = rsaAmplitude.toFixed(1);
        if (cohEl) cohEl.textContent = coherenceRatio.toFixed(2);
    }

    _updateLiveStats({ rmssd, coherence, lfhf, resonance } = {}) {
        if (rmssd !== undefined) {
            const rounded = Math.round(rmssd);
            document.querySelectorAll('.live-rmssd').forEach(el => el.textContent = rounded + ' ms');
            // SDNN und pNN50 live berechnen (nutzen denselben RR-Puffer)
            const sdnn  = Math.round(this.hrv.sdnn());
            const pnn50 = this.hrv.pnn50();
            document.querySelectorAll('.live-sdnn').forEach(el => el.textContent = sdnn + ' ms');
            document.querySelectorAll('.live-pnn50').forEach(el => el.textContent = pnn50 + '%');
        }
        if (coherence !== undefined) {
            document.querySelectorAll('.live-coherence').forEach(el => el.textContent = coherence + '%');
            const color = this._coherenceColor(coherence);
            document.querySelectorAll('.coherence-display').forEach(el => {
                el.style.color = color;
                el.style.textShadow = `0 0 30px ${color}`;
            });
            // Kohärenz-Label
            const labelEl = document.getElementById('coherence-label-text');
            if (labelEl) {
                labelEl.textContent = this._coherenceLabel(coherence);
                labelEl.style.color = color;
            }
            // Kohärenz-Ring
            const ring = document.getElementById('coherence-ring');
            if (ring) {
                const circumference = 2 * Math.PI * 54;
                const offset = circumference * (1 - coherence / 100);
                ring.style.strokeDashoffset = offset;
                ring.style.stroke = color;
            }
            // Sonifikation: Volumen folgt Kohärenz
            this.audio.updateCoherence(coherence);
        }
        if (lfhf !== undefined) {
            document.querySelectorAll('.live-lfhf').forEach(el => el.textContent = lfhf.toFixed(2));
        }
        if (resonance !== undefined) {
            const bpm = Math.round(resonance * 60 * 10) / 10;
            document.querySelectorAll('.live-resonance').forEach(el => el.textContent = `${bpm}/min`);
        }
    }

    _coherenceLabel(score) {
        if (score >= 85) return 'Exzellent';
        if (score >= 70) return 'Sehr gut';
        if (score >= 50) return 'Gut';
        if (score >= 30) return 'Mittel';
        return 'Niedrig';
    }

    _coherenceColor(score) {
        if (score >= 85) return '#00d4ff';
        if (score >= 70) return '#44dd88';
        if (score >= 50) return '#ffdd00';
        if (score >= 30) return '#ff8800';
        return '#ff4444';
    }

    _updateQualityIndicator() {
        const quality = this.hrv.dataQuality;
        const el = document.getElementById('data-quality');
        if (el) {
            el.textContent = `Datenqualität: ${quality}%`;
            el.className = quality >= 70 ? 'quality-good' : quality >= 40 ? 'quality-mid' : 'quality-low';
        }
    }

    // ─── Anker ───────────────────────────────────────────────────────────────

    async _loadAnchors() {
        const saved = await this.db.getAnchors();
        const allAnchors = [...DEFAULT_ANCHORS, ...saved.filter(a => !a.builtin)];
        const container = document.getElementById('anchor-list');
        if (!container) return;

        container.innerHTML = allAnchors.map(a => `
            <button class="anchor-btn" data-id="${a.id}" data-name="${a.name}" data-prompt="${a.prompt}">
                <span class="anchor-name">${a.name}</span>
                <span class="anchor-prompt">${a.prompt}</span>
            </button>
        `).join('');

        container.querySelectorAll('.anchor-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                container.querySelectorAll('.anchor-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.session.anchorId   = btn.dataset.id;
                this.session.anchorName = btn.dataset.name;

                const promptEl = document.getElementById('anchor-prompt-display');
                if (promptEl) promptEl.textContent = btn.dataset.prompt;
            });
        });

        // Eigenen Anker hinzufügen
        const addBtn = document.getElementById('add-anchor-btn');
        if (addBtn) {
            addBtn.addEventListener('click', () => this._showAddAnchorDialog());
        }
    }

    async _showAddAnchorDialog() {
        const name   = prompt('Name für deinen Anker:');
        if (!name) return;
        const prompt_ = prompt('Deine Frage oder Formulierung:');
        if (!prompt_) return;

        const anchor = { name: name.trim(), prompt: prompt_.trim(), builtin: false };
        await this.db.saveAnchor(anchor);
        this._loadAnchors();
    }

    // ─── Resonanztest-View: Protokoll 1 (Frequenz) + Protokoll 2 (Verhältnis/Pausen) ─

    async _initResonanzView() {
        this._rezShowSection('rez-home');
        await this._rezLoadStepCards();
        await this._rezLoadLastResult();

        const btn1 = document.getElementById('rez-start-1');
        if (btn1) btn1.onclick = () => this._rezStartProtocol1(false);

        const btn2 = document.getElementById('rez-start-2');
        if (btn2) btn2.onclick = () => this._rezStartProtocol2Entry();

        const fullBtn = document.getElementById('rez-start-full');
        if (fullBtn) fullBtn.onclick = () => this._rezStartProtocol1(true);

        const stopBtn = document.getElementById('rez-stop-btn');
        if (stopBtn) {
            stopBtn.onclick = () => {
                this._calibTest?.stop();
                this._calibStopPacer();
                clearInterval(this._calibTicker);
                this._rezShowSection('rez-home');
                this._rezLoadStepCards();
            };
        }

        if (this._calibTest?.active) this._rezShowSection('rez-running');
    }

    _rezSetStepDots(active) {
        [1, 2].forEach(n => {
            const dot = document.getElementById(`rez-dot-${n}`);
            if (dot) {
                dot.className = 'rez-step-dot' + (n < active ? ' done' : n === active ? ' active' : '');
                dot.textContent = n < active ? '✓' : String(n);
            }
        });
        const line = document.getElementById('rez-line-1');
        if (line) line.className = 'rez-step-line' + (active > 1 ? ' done' : '');
    }

    _rezSetPatternDots(total, idx) {
        const wrap = document.getElementById('rez-pattern-dots');
        if (wrap) {
            wrap.innerHTML = Array.from({ length: total }, (_, i) =>
                `<div class="rez-pdot${i < idx ? ' done' : i === idx ? ' active' : ''}"></div>`
            ).join('');
        }
    }

    _rezStartElapsedTicker() {
        clearInterval(this._calibTicker);
        const startTs = performance.now();
        this._calibTicker = setInterval(() => {
            const el = document.getElementById('rez-phase-countdown');
            if (el) {
                const s = Math.floor((performance.now() - startTs) / 1000);
                el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
            }
        }, 1000);
    }

    _rezSetMetricLabels(liveLabel, avgLabel) {
        const l = document.getElementById('rez-live-metric-label');
        const a = document.getElementById('rez-avg-metric-label');
        if (l) l.textContent = liveLabel;
        if (a) a.textContent = avgLabel;
        const liveEl = document.getElementById('rez-live-metric');
        const avgEl  = document.getElementById('rez-avg-metric');
        if (liveEl) liveEl.textContent = '—';
        if (avgEl)  avgEl.textContent  = '—';
    }

    /**
     * Kompakte Muster-Beschriftung für Protokoll-2-Kandidaten.
     * @param {'A'|'B'} stage
     * @param {object} info - bei 'A': {ratioIn, rhythm}; bei 'B': {rhythm} ODER
     *   ein bereits geflachtes Ergebnisobjekt {holdIn, holdOut, ...}
     */
    _rezStageLabel(stage, info) {
        const s = ms => (ms / 1000).toFixed(1) + 's';
        if (stage === 'A') {
            const rhythm = info.rhythm ?? info;
            return `${info.ratioIn}:${100 - info.ratioIn}  (${s(rhythm.inhale)}/${s(rhythm.exhale)})`;
        }
        const { holdIn, holdOut } = info.rhythm ?? info;
        if (!holdIn && !holdOut) return 'kein Halt';
        const parts = [];
        if (holdIn)  parts.push(`H-In ${s(holdIn)}`);
        if (holdOut) parts.push(`H-Out ${s(holdOut)}`);
        return parts.join(' + ');
    }

    // ── Protokoll 1: Frequenz-Scan ──────────────────────────────────────────

    _rezStartProtocol1(chainToProtocol2) {
        if (!this.ble.isConnected) { alert('Polar H10 muss verbunden sein.'); return; }
        this._calibFullChain = chainToProtocol2;

        const test = new FrequencyTest(this.hrv, this.db);
        this._calibTest = test;
        this.audio.unlock();
        this._rezShowSection('rez-running');
        this._rezSetStepDots(1);
        document.getElementById('rez-step-title').textContent = 'Protokoll 1 · Grobsieb';

        test.onRhythmChange = (rhythm) => this._calibSetPacer('rez-pacer-container', 'rez-breath-label', rhythm, test, 'rez-breath-countdown');

        test.onCandidateStart = (idx, total, bpm) => {
            document.getElementById('rez-step-title').textContent = 'Protokoll 1 · Grobsieb';
            document.getElementById('rez-pattern-name').textContent = `Kandidat ${idx + 1}/${total} · ${bpm.toFixed(2)} Atemz/min`;
            document.getElementById('rez-phase-badge').textContent = 'Grobsieb';
            this._rezSetMetricLabels('Amplitude live', 'Ø Kandidat');
            this._rezSetPatternDots(total, idx);
            this._rezStartElapsedTicker();
        };
        test.onCycleSample = (c, total, amp) => {
            const el = document.getElementById('rez-live-metric');
            if (el) el.textContent = amp !== null ? amp.toFixed(1) + ' bpm' : '—';
            document.getElementById('rez-phase-badge').textContent = `Zyklus ${c}/${total}`;
        };
        test.onPhase1Done = (raw, smoothed, finalists) => {
            const names = finalists.map(f => f.bpm.toFixed(2)).join(', ');
            this._showToast(`Grobsieb fertig — Top 5: ${names} Atemz/min`);
        };

        test.onFinalistStart = (idx, total, bpm, subPhase) => {
            document.getElementById('rez-step-title').textContent = 'Protokoll 1 · Feinvalidierung';
            document.getElementById('rez-pattern-name').textContent = `Finalist ${idx + 1}/${total} · ${bpm.toFixed(2)} Atemz/min`;
            document.getElementById('rez-phase-badge').textContent = subPhase === 'acclimation' ? 'Einschwingung' : 'Messung';
            this._rezSetMetricLabels('RMSSD live', 'Ø Messung');
            this._rezSetPatternDots(total, idx);
            this._rezStartElapsedTicker();
        };
        test.onRmssdSample = (rmssd) => {
            const el = document.getElementById('rez-live-metric');
            if (el) el.textContent = rmssd > 0 ? rmssd + ' ms' : '—';
        };
        test.onFinalistDone = (idx, results) => {
            const last = results[results.length - 1];
            const el = document.getElementById('rez-avg-metric');
            if (el) el.textContent = `${last.avgRmssd} ms`;
        };

        test.onComplete = (winner, result) => this._rezOnProtocol1Complete(winner, result);
        test.onCancelled = () => { this._rezShowSection('rez-home'); this._rezLoadStepCards(); };

        test.start();
    }

    _rezOnProtocol1Complete(winner, result) {
        clearInterval(this._calibTicker);
        this._calibStopPacer();
        this._lastFrequencyResult = result;

        if (this._calibFullChain) {
            // Komplett-Test: Zwischenstopp mit "Weiter zu Protokoll 2"
            this._rezShowSection('rez-step-done');
            document.getElementById('rez-done-title').textContent = 'Protokoll 1 abgeschlossen';
            document.getElementById('rez-done-sub').textContent =
                `Optimum: ${winner.bpm.toFixed(2)} Atemz/min · ${winner.avgRmssd} ms RMSSD`;

            const tbody = document.querySelector('#rez-step-table tbody');
            if (tbody) {
                const bestBpm = winner.bpm;
                tbody.innerHTML = result.finalists.map(r => `
                    <tr class="${r.bpm === bestBpm ? 'rez-best-row' : ''}">
                        <td>${r.bpm.toFixed(2)} /min</td>
                        <td class="${r.bpm === bestBpm ? 'rez-best-val' : ''}">${r.avgRmssd} ms</td>
                        <td>${r.bpm === bestBpm ? '★' : ''}</td>
                    </tr>
                `).join('');
            }

            const nextBtn = document.getElementById('rez-next-btn');
            const cancelBtn = document.getElementById('rez-cancel-btn');
            if (nextBtn) {
                nextBtn.textContent = 'Weiter zu Protokoll 2';
                nextBtn.style.display = '';
                nextBtn.onclick = () => this._rezStartProtocol2(winner.bpm, true);
            }
            if (cancelBtn) {
                cancelBtn.style.display = '';
                cancelBtn.textContent = 'Hier beenden';
                cancelBtn.onclick = () => this._rezShowFinal(winner.rhythm, `${winner.avgRmssd} ms RMSSD`, null);
            }
        } else {
            this._rezShowFinal(winner.rhythm, `${winner.avgRmssd} ms RMSSD`, null);
        }
    }

    // ── Protokoll 2: Verhältnis & Pausen ────────────────────────────────────

    async _rezStartProtocol2Entry() {
        if (!this.ble.isConnected) { alert('Polar H10 muss verbunden sein.'); return; }
        const [lastFreq] = await this.db.getFrequencyTests(1);
        let baseBpm = lastFreq?.winner?.bpm;
        if (!baseBpm) {
            baseBpm = await this._rezGetManualBpm();
            if (!baseBpm) return;
        }
        this._rezStartProtocol2(baseBpm, false);
    }

    /** Zeigt Modal für manuellen Frequenz-Startwert (falls Protokoll 1 noch nie lief) */
    _rezGetManualBpm() {
        return new Promise(resolve => {
            const overlay   = document.getElementById('rez-manual-overlay');
            const descEl    = document.getElementById('rez-manual-desc');
            const bpmInput  = document.getElementById('rez-manual-bpm');
            const okBtn     = document.getElementById('rez-manual-ok');
            const cancelBtn = document.getElementById('rez-manual-cancel');

            descEl.textContent = 'Kein gespeichertes Protokoll-1-Ergebnis gefunden. Gib die Frequenz manuell ein:';
            bpmInput.value = '';
            bpmInput.style.borderColor = '';
            overlay.style.display = 'flex';
            setTimeout(() => bpmInput.focus(), 50);

            const onKey = (e) => {
                if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); }
                if (e.key === 'Escape') close(null);
            };
            overlay.addEventListener('keydown', onKey);

            const close = (result) => {
                overlay.style.display = 'none';
                okBtn.onclick = null;
                cancelBtn.onclick = null;
                overlay.removeEventListener('keydown', onKey);
                resolve(result);
            };

            okBtn.onclick = () => {
                const bpm = parseFloat(bpmInput.value.trim().replace(',', '.'));
                if (isNaN(bpm) || bpm < 4.5 || bpm > 8.0) {
                    bpmInput.style.borderColor = '#ff4444';
                    bpmInput.focus();
                    return;
                }
                close(bpm);
            };
            cancelBtn.onclick = () => close(null);
        });
    }

    _rezStartProtocol2(baseBpm, chained) {
        this._calibFullChain = chained;

        const test = new RhythmTest(this.hrv, this.db, baseBpm);
        this._calibTest = test;
        this.audio.unlock();
        this._rezShowSection('rez-running');
        this._rezSetStepDots(2);

        const stageTitles = { 'A': 'Stufe A · Verhältnis', 'B-grob': 'Stufe B · Pausen (Grob)', 'B-fein': 'Stufe B · Pausen (Fein)' };

        test.onRhythmChange = (rhythm) => this._calibSetPacer('rez-pacer-container', 'rez-breath-label', rhythm, test, 'rez-breath-countdown');

        test.onStageStart = (stage, idx, total, info) => {
            document.getElementById('rez-step-title').textContent = `Protokoll 2 · ${stageTitles[stage] ?? stage}`;
            document.getElementById('rez-pattern-name').textContent =
                `Kandidat ${idx + 1}/${total} · ${this._rezStageLabel(stage.startsWith('B') ? 'B' : 'A', info)}`;
            document.getElementById('rez-phase-badge').textContent = 'Messung';
            this._rezSetMetricLabels('RMSSD live', 'Ø Messung');
            this._rezSetPatternDots(total, idx);
            this._rezStartElapsedTicker();
        };
        test.onRmssdSample = (rmssd) => {
            const el = document.getElementById('rez-live-metric');
            if (el) el.textContent = rmssd > 0 ? rmssd + ' ms' : '—';
        };
        test.onStageResult = (stage, idx, results) => {
            const last = results[results.length - 1];
            const el = document.getElementById('rez-avg-metric');
            if (el) el.textContent = last.avgRmssd != null ? `${last.avgRmssd} ms` : '(wiederverwendet)';
        };
        test.onStageDone = (stage) => {
            if (stage === 'A') this._showToast('Stufe A fertig — Pausen-Grobscan startet…');
            if (stage === 'B-grob') this._showToast('Grobscan fertig — Feinabstimmung startet…');
        };

        test.onComplete = (winner, result) => this._rezOnProtocol2Complete(winner, result);
        test.onCancelled = () => { this._rezShowSection('rez-home'); this._rezLoadStepCards(); };

        test.start();
    }

    _rezOnProtocol2Complete(winner, result) {
        clearInterval(this._calibTicker);
        this._calibStopPacer();

        const tableRows = result.stageBFein.map(r => `
            <tr class="${r === winner ? 'rez-best-row' : ''}">
                <td>${this._rezStageLabel('B', r)}</td>
                <td class="${r === winner ? 'rez-best-val' : ''}">${r.avgRmssd} ms</td>
                <td>${r === winner ? '★' : ''}</td>
            </tr>
        `).join('');

        this._rezShowFinal(
            { inhale: winner.inhale, holdIn: winner.holdIn, exhale: winner.exhale, holdOut: winner.holdOut },
            `${winner.avgRmssd} ms RMSSD`,
            { title: 'Stufe B · Pausen (Fein) — alle Muster', rows: tableRows }
        );
    }

    // ── Gemeinsame Ergebnis-/Übersichts-Anzeige ─────────────────────────────

    _rezShowFinal(rhythm, metricLabel, table) {
        this._rezShowSection('rez-final');

        const s   = ms => (ms / 1000).toFixed(1) + ' s';
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

        set('rez-final-rmssd-val', metricLabel.split(' ')[0]);
        set('rez-final-unit', metricLabel.split(' ').slice(1).join(' '));
        set('rez-fin-inhale',  s(rhythm.inhale));
        set('rez-fin-exhale',  s(rhythm.exhale));
        set('rez-fin-holdin',  rhythm.holdIn  ? s(rhythm.holdIn)  : '0,0 s');
        set('rez-fin-holdout', rhythm.holdOut ? s(rhythm.holdOut) : '0,0 s');

        const wrap  = document.getElementById('rez-final-table-wrap');
        const title = document.getElementById('rez-final-table-title');
        const tbody = document.querySelector('#rez-final-table tbody');
        if (table && tbody) {
            wrap.style.display = '';
            if (title) title.textContent = table.title;
            tbody.innerHTML = table.rows;
        } else if (wrap) {
            wrap.style.display = 'none';
        }

        const applyBtn = document.getElementById('rez-apply-btn');
        if (applyBtn) {
            applyBtn.onclick = async () => {
                this.session.breathRhythm = rhythm;
                await this.db.setSetting('breathRhythm', rhythm);
                this._updateBreathPreview();
                this._showToast('Atemrhythmus übernommen!');
                this._navigateTo('training');
            };
        }

        const backBtn = document.getElementById('rez-final-back-btn');
        if (backBtn) {
            backBtn.onclick = async () => {
                this._calibTest = null;
                this._rezShowSection('rez-home');
                await this._rezLoadStepCards();
                await this._rezLoadLastResult();
            };
        }
    }

    _rezShowSection(id) {
        ['rez-home', 'rez-running', 'rez-step-done', 'rez-final'].forEach(sid => {
            const el = document.getElementById(sid);
            if (el) el.style.display = sid === id ? '' : 'none';
        });
    }

    async _rezLoadLastResult() {
        const container = document.getElementById('rez-last-result');
        const content   = document.getElementById('rez-last-content');
        if (!container || !content) return;

        const [lastRhythm] = await this.db.getRhythmTests(1);
        const [lastFreq]   = await this.db.getFrequencyTests(1);
        const latest = [lastRhythm, lastFreq].filter(Boolean).sort((a, b) => new Date(b.date) - new Date(a.date))[0];
        if (!latest) { container.style.display = 'none'; return; }

        const date = new Date(latest.date).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' });
        const w    = latest.winner;
        const rh   = w.inhale !== undefined
            ? { inhale: w.inhale, holdIn: w.holdIn, exhale: w.exhale, holdOut: w.holdOut }
            : w.rhythm;

        content.innerHTML = `
            <span style="color:var(--text-secondary)">${date}</span>
            <span>${rhythmToString(rh)}</span>
            <span style="color:var(--accent-teal);font-weight:700">${w.avgRmssd} ms</span>
        `;
        container.style.display = '';
    }

    async _rezLoadStepCards() {
        const [lastFreq]   = await this.db.getFrequencyTests(1);
        const [lastRhythm] = await this.db.getRhythmTests(1);
        const data = { 1: lastFreq, 2: lastRhythm };

        for (let n = 1; n <= 2; n++) {
            const entry    = data[n];
            const card     = document.getElementById(`rez-card-${n}`);
            const resultEl = document.getElementById(`rez-result-${n}`);
            const valEl    = document.getElementById(`rez-result-val-${n}`);
            const badge    = document.getElementById(`rez-badge-${n}`);

            if (entry) {
                const w = entry.winner;
                if (resultEl) resultEl.style.display = '';
                if (valEl) {
                    valEl.textContent = n === 1
                        ? `${w.bpm.toFixed(2)} Atemz/min  ·  ${w.avgRmssd} ms`
                        : `${rhythmToString({ inhale: w.inhale, holdIn: w.holdIn, exhale: w.exhale, holdOut: w.holdOut })}  ·  ${w.avgRmssd} ms`;
                }
                if (card)  card.classList.add('done');
                if (badge) badge.textContent = '✓';
            } else {
                if (resultEl) resultEl.style.display = 'none';
                if (card)  card.classList.remove('done');
                if (badge) badge.textContent = String(n);
            }
        }
    }

    // ─── Zone-2-View ─────────────────────────────────────────────────────────

    async _initZone2View() {
        const z2 = this.zone2;
        if (!z2) return;

        this._z2ShowSection('z2-home');
        this._z2LoadLastResult();

        // ── Feldtest-Toggle ──────────────────────────────────────────────────
        const feldToggle = document.getElementById('z2-feld-toggle');
        if (feldToggle) {
            feldToggle.checked = z2.feldActive;
            feldToggle.addEventListener('change', (e) => {
                if (e.target.checked) {
                    if (!this.ble.isConnected) {
                        alert('Polar H10 nicht verbunden. Bitte zuerst verbinden.');
                        e.target.checked = false;
                        return;
                    }
                    z2.startFeldTestSession();
                    z2.onFeldUpdate = (samples, thresh) => this._z2OnFeldUpdate(samples, thresh);
                } else {
                    z2.stopFeldTestSession();
                }
                this._z2UpdateFeldStatus();
            });
        }

        // ── Stufentest starten ───────────────────────────────────────────────
        const stufenStartBtn = document.getElementById('z2-stufen-start-btn');
        if (stufenStartBtn) {
            stufenStartBtn.addEventListener('click', () => {
                if (!this.ble.isConnected) {
                    alert('Polar H10 nicht verbunden. Bitte zuerst verbinden.');
                    return;
                }
                this._z2StartStufenTest();
            });
        }

        // ── Rückkehr vom Ergebnis ────────────────────────────────────────────
        const backBtn = document.getElementById('z2-result-back-btn');
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                this._z2ShowSection('z2-home');
                this._z2LoadLastResult();
            });
        }

        // ── Status aktualisieren ─────────────────────────────────────────────
        this._z2UpdateFeldStatus();
        if (z2.feldActive) this._updateFeldPanel();
        if (z2.stufenActive) this._z2ShowSection('z2-stufen-live');
    }

    _z2ShowSection(id) {
        ['z2-home', 'z2-stufen-live', 'z2-result-view'].forEach(sid => {
            const el = document.getElementById(sid);
            if (el) el.style.display = sid === id ? '' : 'none';
        });
    }

    async _z2LoadLastResult() {
        const results = await this.zone2.getLastResults(1);
        const container = document.getElementById('z2-last-result');
        const content   = document.getElementById('z2-last-result-content');
        if (!container || !content) return;
        if (!results.length) { container.style.display = 'none'; return; }

        const r    = results[0];
        const date = new Date(r.date).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' });
        const type = r.type === 'stufentest' ? 'Stufentest' : 'Feldtest';
        content.innerHTML = `
            <span style="color:var(--text-secondary)">${date} · ${type}</span>
            <span style="font-size:1.3rem;font-weight:700;color:var(--accent-teal)">${r.threshHR ? r.threshHR + ' bpm' : '—'}</span>
            <span style="font-size:0.75rem;color:var(--text-muted)">Zone-2-Grenze</span>
        `;
        container.style.display = '';
    }

    _z2UpdateFeldStatus() {
        const z2 = this.zone2;
        const badge = document.getElementById('z2-feld-status-text');
        if (!badge) return;
        if (!z2.feldActive) {
            badge.textContent = 'Inaktiv';
            badge.className = 'z2-status-badge z2-status-off';
        } else if (z2.feldWarmupActive) {
            badge.textContent = 'Einlaufen…';
            badge.className = 'z2-status-badge z2-status-warm';
        } else {
            badge.textContent = 'Aktiv';
            badge.className = 'z2-status-badge z2-status-on';
        }
    }

    _updateFeldPanel() {
        const z2      = this.zone2;
        const panel   = document.getElementById('z2-feld-live-panel');
        const elapsed = document.getElementById('z2-feld-elapsed-text');
        const count   = document.getElementById('z2-feld-sample-count');
        const wrap    = document.getElementById('z2-feld-table-wrap');
        if (!panel) return;

        if (!z2.feldActive) { panel.style.display = 'none'; return; }
        panel.style.display = '';

        const elSec = z2.feldElapsedSec;
        if (z2.feldWarmupActive) {
            const rem = z2.feldWarmupSec - elSec;
            const m   = Math.floor(rem / 60), s = rem % 60;
            if (elapsed) elapsed.textContent = `Einlaufzeit: noch ${m}:${String(s).padStart(2,'0')}`;
        } else {
            if (elapsed) elapsed.textContent = `Feldtest läuft (${Math.floor(elSec / 60)} min)`;
        }
        if (count) count.textContent = `${z2.feldSamples.length} Samples`;

        if (z2.feldSamples.length > 0) {
            if (wrap) wrap.style.display = '';
            this._z2FillTable('z2-feld-table', z2.feldSamples, 'feld');
        }
    }

    _z2OnFeldUpdate(samples, thresh) {
        this._updateFeldPanel();
        this._z2UpdateFeldStatus();
    }

    _z2StartStufenTest() {
        const z2 = this.zone2;
        z2.startStufenTest();

        // UI aufbauen
        this._z2ShowSection('z2-stufen-live');
        this._z2BuildProgressDots();

        // Stop-Button
        const stopBtn = document.getElementById('z2-stufen-stop-btn');
        if (stopBtn) {
            stopBtn.onclick = () => {
                z2.stopStufenTest();
                this._z2ShowSection('z2-home');
                this._z2LoadLastResult();
            };
        }

        // Callbacks
        z2.onStufenUpdate = (stageIdx, samples, alpha1, avgHR) => {
            this._z2UpdateStufenLive(stageIdx, samples, alpha1, avgHR);
        };
        z2.onStufenEnd = (samples, threshHR) => {
            this._z2ShowResult('stufentest', samples, threshHR);
        };

        // Countdown-Ticker
        this._z2StufenTicker = setInterval(() => {
            if (!z2.stufenActive) { clearInterval(this._z2StufenTicker); return; }
            const rem  = Math.ceil(z2.stufenStageRemainingMs / 1000);
            const el   = document.getElementById('z2-stage-countdown');
            if (el) {
                const m = Math.floor(rem / 60), s = rem % 60;
                el.textContent = `${m}:${String(s).padStart(2,'0')}`;
            }
        }, 500);
    }

    _z2BuildProgressDots() {
        const z2    = this.zone2;
        const wrap  = document.getElementById('z2-stufen-progress');
        if (!wrap) return;
        const stages = z2.stufenStages;
        let stageNum = 0;
        wrap.innerHTML = stages.map((st, i) => {
            let label;
            if (st.isWarmup)   label = 'W';
            else if (st.isCooldown) label = 'C';
            else               label = ++stageNum;
            return `
            <div class="z2-prog-dot" id="z2-dot-${i}">${label}</div>
            ${i < stages.length - 1 ? `<div class="z2-prog-line" id="z2-line-${i}"></div>` : ''}
        `;
        }).join('');
    }

    _z2UpdateStufenLive(stageIdx, samples, alpha1, avgHR) {
        const z2 = this.zone2;

        // Stage-Name
        const nameEl = document.getElementById('z2-stage-name');
        if (nameEl) nameEl.textContent = z2.stufenStages[stageIdx]?.name ?? '—';

        // Progress-Dots
        z2.stufenStages.forEach((_, i) => {
            const dot  = document.getElementById(`z2-dot-${i}`);
            const line = document.getElementById(`z2-line-${i}`);
            if (dot) {
                dot.classList.toggle('active', i === stageIdx);
                dot.classList.toggle('done',   i < stageIdx);
            }
            if (line) line.classList.toggle('done', i < stageIdx);
        });

        // Live-Werte
        const a1El = document.getElementById('z2-live-alpha1');
        const hrEl = document.getElementById('z2-live-hr');
        if (a1El) a1El.textContent = alpha1 !== null ? alpha1.toFixed(3) : '—';
        if (hrEl) hrEl.textContent = avgHR  !== null ? avgHR + ' bpm'   : '—';

        // alpha1-Fortschrittsbalken (Skala 0–1.5, Schwelle bei 0.75 = 50%)
        const bar = document.getElementById('z2-alpha-bar');
        if (bar && alpha1 !== null) {
            const pct = Math.min(100, (alpha1 / 1.5) * 100);
            bar.style.width = pct + '%';
            bar.style.background = alpha1 >= 0.75 ? 'var(--accent-teal)' : alpha1 >= 0.5 ? '#ffdd00' : '#ff4444';
        }

        // Tabelle
        this._z2FillTable('z2-stufen-table', samples, 'stufen');
    }

    _z2FillTable(tableId, samples, mode) {
        const tbl  = document.getElementById(tableId);
        if (!tbl) return;
        const tbody = tbl.querySelector('tbody');
        if (!tbody) return;

        tbody.innerHTML = [...samples].reverse().slice(0, 20).map(s => {
            const zone     = s.alpha1 >= 0.75 ? '<span class="z2-zone-in">Zone 2</span>'
                           : s.alpha1 >= 0.50 ? '<span class="z2-zone-out">Über Zone 2</span>'
                           : '<span class="z2-zone-vt2">VT2+</span>';
            const label    = mode === 'stufen' ? (s.stageName ?? `Stufe ${s.stage + 1}`)
                                               : this._z2FormatTime(s.time);
            return `<tr>
                <td>${label}</td>
                <td>${s.avgHR} bpm</td>
                <td>${s.alpha1.toFixed(3)}</td>
                <td>${zone}</td>
            </tr>`;
        }).join('');
    }

    _z2FormatTime(sec) {
        const m = Math.floor(sec / 60), s = sec % 60;
        return `${m}:${String(s).padStart(2,'0')}`;
    }

    _z2ShowResult(type, samples, threshHR) {
        clearInterval(this._z2StufenTicker);
        this._z2ShowSection('z2-result-view');

        const titleEl = document.getElementById('z2-result-title');
        const hrEl    = document.getElementById('z2-result-hr');
        const subEl   = document.getElementById('z2-result-sub');
        if (titleEl) titleEl.textContent = type === 'stufentest' ? 'Stufentest – Ergebnis' : 'Feldtest – Ergebnis';
        if (hrEl)    hrEl.textContent    = threshHR ? `${threshHR} bpm` : '—';
        if (subEl)   subEl.textContent   = threshHR
            ? `Zone-2-Obergrenze (DFA-alpha1 = 0.75)\nEmpfehlung: unter ${threshHR} bpm trainieren.`
            : 'Kein Schwellenwert gefunden — alpha1 war durchgehend ≥ 0.75 (noch in Zone 2).';

        this._z2FillTable('z2-result-table', samples, type === 'stufentest' ? 'stufen' : 'feld');
    }

    // ─── History-View ────────────────────────────────────────────────────────

    async _initHistoryView() {
        const container = document.getElementById('dashboard-content');
        if (!container) return;

        if (!this.dashboard) this.dashboard = new Dashboard(this.db);
        await this.dashboard.render(container);
    }

    // ─── Settings-View ───────────────────────────────────────────────────────

    async _initSettingsView() {
        // Atemrhythmus in Millisekunden
        const { inhale, holdIn, exhale, holdOut } = this.session.breathRhythm;
        this._setInput('setting-inhale',  inhale);
        this._setInput('setting-holdin',  holdIn);
        this._setInput('setting-exhale',  exhale);
        this._setInput('setting-holdout', holdOut);

        // Speichern-Button
        const saveBtn = document.getElementById('settings-save-btn');
        if (saveBtn) {
            saveBtn.addEventListener('click', async () => {
                this.session.breathRhythm = {
                    inhale:  parseInt(this._getInput('setting-inhale',  5000)),
                    holdIn:  parseInt(this._getInput('setting-holdin',  0)),
                    exhale:  parseInt(this._getInput('setting-exhale',  5000)),
                    holdOut: parseInt(this._getInput('setting-holdout', 0)),
                };
                await this.db.setSetting('breathRhythm', this.session.breathRhythm);
                this._updateBreathPreview();
                this._showToast('Einstellungen gespeichert!');
            });
        }

        // Nacht-Atemfrequenz-Messung öffnen
        const nightOpenBtn = document.getElementById('night-open-btn');
        if (nightOpenBtn) nightOpenBtn.addEventListener('click', () => this._nightOpen());

        // Daten löschen
        const clearBtn = document.getElementById('clear-data-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', async () => {
                if (confirm('Alle Daten löschen? Dies kann nicht rückgängig gemacht werden.')) {
                    await this.db.setSetting('onboarding_done', false);
                    window.location.reload();
                }
            });
        }
    }

    // ─── Nacht-Atemfrequenz-Messung ─────────────────────────────────────────

    _nightOpen() {
        const screen = document.getElementById('night-screen');
        if (!screen) return;
        screen.style.display = '';
        this._nightShowSection(this.night.active ? 'night-recording' : 'night-setup');
        if (this.night.active) this._nightStartTicker();

        const closeBtn = document.getElementById('night-close-btn');
        if (closeBtn) closeBtn.onclick = () => { screen.style.display = 'none'; };

        const startBtn = document.getElementById('night-start-btn');
        if (startBtn) startBtn.onclick = () => this._nightStart();

        const stopBtn = document.getElementById('night-stop-btn');
        if (stopBtn) stopBtn.onclick = () => this._nightStop();

        const backBtn = document.getElementById('night-back-btn');
        if (backBtn) backBtn.onclick = () => { screen.style.display = 'none'; };
    }

    _nightShowSection(id) {
        ['night-setup', 'night-recording', 'night-result'].forEach(sid => {
            const el = document.getElementById(sid);
            if (el) el.style.display = sid === id ? '' : 'none';
        });
    }

    async _nightStart() {
        if (!this.ble.isConnected) {
            alert('Polar H10 muss verbunden sein.');
            return;
        }
        this.ble.persistentReconnect = true;
        await this._nightRequestWakeLock();

        this._boundVisibilityHandler = () => this._nightOnVisibilityChange();
        document.addEventListener('visibilitychange', this._boundVisibilityHandler);

        this.night.onMaxDurationReached = () => this._nightStop();
        this.night.start();

        this._nightShowSection('night-recording');
        this._nightStartTicker();
    }

    _nightStartTicker() {
        clearInterval(this._nightTicker);
        this._nightTicker = setInterval(() => {
            const el = document.getElementById('night-elapsed');
            if (!el) return;
            const s   = Math.floor(this.night.durationMs / 1000);
            const h   = Math.floor(s / 3600);
            const m   = Math.floor((s % 3600) / 60);
            const sec = s % 60;
            el.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        }, 1000);
    }

    _nightOnVisibilityChange() {
        // Wake Lock kann vom System aufgehoben werden (z.B. kurzes Aufwachen) —
        // beim Sichtbarwerden erneut anfordern, damit die Aufnahme nicht ausfällt.
        if (document.visibilityState === 'visible' && this.night.active && !this._wakeLock) {
            this._nightRequestWakeLock();
        }
    }

    async _nightStop() {
        clearInterval(this._nightTicker);
        this.night.stop();
        this.ble.persistentReconnect = false;

        if (this._boundVisibilityHandler) {
            document.removeEventListener('visibilitychange', this._boundVisibilityHandler);
            this._boundVisibilityHandler = null;
        }
        await this._nightReleaseWakeLock();

        const result = this.night.analyze();
        await this.db.saveSleepMeasurement(result).catch(() => {});
        this._nightShowResult(result);
    }

    _nightShowResult(result) {
        this._nightShowSection('night-result');

        const avgEl = document.getElementById('night-avg-rate');
        if (avgEl) {
            avgEl.innerHTML = result.avgBreathingRate !== null
                ? `${result.avgBreathingRate.toFixed(1)} <span class="night-unit">Atemz/min</span>`
                : `— <span class="night-unit">keine Daten</span>`;
        }

        const metaEl = document.getElementById('night-meta');
        if (metaEl) {
            const h = Math.floor(result.durationSec / 3600);
            const m = Math.floor((result.durationSec % 3600) / 60);
            metaEl.textContent = `${h}h ${m}min Aufnahme · ${result.validWindowCount} gültige 5-Min-Fenster · ${result.totalRRCount} Herzschläge`;
        }

        this._nightRenderChart(result.windows);
    }

    _nightRenderChart(windows) {
        const canvas = document.getElementById('night-chart');
        if (!canvas || typeof Chart === 'undefined') return;
        if (this._nightChart) this._nightChart.destroy();

        const labels = windows.map(w => {
            const h = Math.floor(w.startOffsetSec / 3600);
            const m = Math.floor((w.startOffsetSec % 3600) / 60);
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        });

        this._nightChart = new Chart(canvas, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    data: windows.map(w => w.breathingRate),
                    borderColor: '#7a9bc0',
                    backgroundColor: 'rgba(122,155,192,0.08)',
                    pointRadius: 2,
                    tension: 0.3,
                    fill: true,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#555', font: { size: 9 }, maxTicksLimit: 8 } },
                    y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#555', font: { size: 10 } } },
                },
            },
        });
    }

    async _nightRequestWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                this._wakeLock = await navigator.wakeLock.request('screen');
                this._wakeLock.addEventListener('release', () => { this._wakeLock = null; });
            }
        } catch (err) {
            console.warn('Wake Lock fehlgeschlagen:', err);
        }
    }

    async _nightReleaseWakeLock() {
        if (this._wakeLock) {
            try { await this._wakeLock.release(); } catch {}
            this._wakeLock = null;
        }
    }

    _setInput(id, value) {
        const el = document.getElementById(id);
        if (el) el.value = value;
    }

    _getInput(id, fallback) {
        const el = document.getElementById(id);
        return el ? (parseFloat(el.value) || fallback) : fallback;
    }

    // ─── Utilities ───────────────────────────────────────────────────────────

    _showError(msg) {
        const toast = document.getElementById('error-toast');
        if (toast) {
            toast.textContent = msg;
            toast.classList.add('active');
            setTimeout(() => toast.classList.remove('active'), 5000);
        } else {
            console.error(msg);
        }
    }

    _showToast(msg) {
        const toast = document.getElementById('success-toast');
        if (toast) {
            toast.textContent = msg;
            toast.classList.add('active');
            setTimeout(() => toast.classList.remove('active'), 2500);
        }
    }
}

// ─── App starten ─────────────────────────────────────────────────────────────

const app = new App();
document.addEventListener('DOMContentLoaded', () => app.init());
