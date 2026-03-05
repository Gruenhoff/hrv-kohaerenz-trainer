/**
 * HRV Kohärenz-Trainer – Haupt-App-Controller
 */

import { PolarBluetooth } from './bluetooth.js';
import { HRVAnalyzer }    from './hrv.js';
import { Database }       from './database.js';
import { RRVisualizer, SpectrumVisualizer } from './visualizer.js';
import { BreathPacer }    from './breathpacer.js';
import { BreathAudio }    from './audio.js';
import { Dashboard }      from './dashboard.js';
import { Zone2 }          from './zone2.js';

// ─── Phasenspezifische Dauer-Optionen ────────────────────────────────────────
const PHASE_DURATIONS = {
    1: { options: [300, 600, 900, 1200], default: 600,  labels: ['5 Min', '10 Min', '15 Min', '20 Min'] },
    2: { options: [300, 600, 900, 1200], default: 600,  labels: ['5 Min', '10 Min', '15 Min', '20 Min'] },
    3: { options: [300, 600, 900, 1200], default: 600,  labels: ['5 Min', '10 Min', '15 Min', '20 Min'] },
    4: { options: [60,  90,  120],       default: 90,   labels: ['60 Sek', '90 Sek', '2 Min'] },
};

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
        this.audio      = new BreathAudio();
        this.zone2      = null;   // wird nach db.open() initialisiert
        this.dashboard  = null;
        this.visualizer = null;
        this.spectrum   = null;
        this.pacer      = null;

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
        if (saved) this.phaseDurations = saved;
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

            const accepted = this.hrv.addRR(rrMs);
            if (accepted && this.session.active) {
                // Visualizer updaten
                if (this.visualizer) this.visualizer.addRR(rrMs);

                // RMSSD live updaten
                const rmssd = this.hrv.rmssd();
                this._updateLiveStats({ rmssd });

                // RR-Wert zur Session loggen
                if (this.session.active) {
                    this.session.rmssdLog.push(rmssd);
                }
            }
        };

        this.ble.onHeartRate = (bpm) => {
            document.querySelectorAll('.live-hr').forEach(el => el.textContent = bpm);
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
        // Wenn Session aktiv → direkt Active-View zeigen
        if (this.session.active) {
            document.getElementById('session-setup').style.display  = 'none';
            document.getElementById('session-active').style.display = '';
            return;
        }
        document.getElementById('session-setup').style.display  = '';
        document.getElementById('session-active').style.display = 'none';

        // Audio-Toggle
        const audioToggle = document.getElementById('audio-toggle');
        if (audioToggle) {
            audioToggle.checked = this.audio.enabled;
            audioToggle.addEventListener('change', (e) => {
                this.audio.enabled = e.target.checked;
                this.audio.unlock();
            });
        }

        // Volume-Slider
        const volSlider = document.getElementById('volume-slider');
        if (volSlider) {
            volSlider.value = this.audio.volume;
            volSlider.addEventListener('input', (e) => {
                this.audio.volume = parseFloat(e.target.value);
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
        const pacerSection  = document.getElementById('pacer-section');
        const anchorSection = document.getElementById('anchor-section');

        if (pacerSection)   pacerSection.style.display  = phase === 1 ? '' : 'none';
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
        this.hrv.reset();

        this.session.active          = true;
        this.session.startTime       = Date.now();
        this.session.coherenceLog    = [];
        this.session.rmssdLog        = [];
        this.session.lfhfLog         = [];
        this.session.firstCoherenceAt = null;

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

        // FFT-Analyse alle 5 Sekunden
        this.fftInterval = setInterval(() => this._runFFT(), 5000);

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
        if (this.pacer) this.pacer.stop();
        if (this.visualizer) this.visualizer.stop();
        if (this.zone2) this.zone2.stopFeldTestSession();

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

        await this.db.saveSession({
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
        });

        // Resonanzfrequenz verfeinern und speichern
        const newFreq = this.hrv.updateResonanceFrequency();
        if (newFreq) await this.db.setSetting('resonanceFreq', newFreq);
        await this.db.setSetting('breathRhythm', this.session.breathRhythm);

        // Active ausblenden, Setup wieder anzeigen
        document.getElementById('session-active').style.display = 'none';
        document.getElementById('session-setup').style.display  = '';
        this._updateBreathPreview();

        const statusEl = document.getElementById('session-status');
        if (statusEl) statusEl.textContent = '';

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

        // ── Echtzeit-UI: bei jedem Aufruf (alle 5s) ──────────────────────────
        if (this.visualizer) this.visualizer.setCoherence(score);
        if (this.spectrum)   this.spectrum.update(result.frequencies, result.power, result.resonanceFreq);

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
            // Hohe Kohärenz: Audio-Chime
            if (coherence >= 70) this.audio.onCoherenceAchieved();
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
                    if (!this.session.active) {
                        alert('Bitte starte zuerst eine Training-Session.\nDer Feldtest läuft im Hintergrund mit.');
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
        wrap.innerHTML = stages.map((st, i) => `
            <div class="z2-prog-dot" id="z2-dot-${i}">${i + 1}</div>
            ${i < stages.length - 1 ? `<div class="z2-prog-line" id="z2-line-${i}"></div>` : ''}
        `).join('');
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
