/**
 * Datenbank-Modul (IndexedDB)
 * Speichert Sessions, Einstellungen, Fortschrittsdaten
 */

const DB_NAME = 'hrv-trainer';
const DB_VERSION = 5;

const STORES = {
    SESSIONS:  'sessions',
    SETTINGS:  'settings',
    ANCHORS:   'anchors',
    BASELINE:  'baseline',
};

export class Database {
    constructor() {
        this.db = null;
    }

    async open() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Sessions-Store: alle Trainingseinheiten
                if (!db.objectStoreNames.contains(STORES.SESSIONS)) {
                    const sessions = db.createObjectStore(STORES.SESSIONS, {
                        keyPath: 'id',
                        autoIncrement: true,
                    });
                    sessions.createIndex('date', 'date', { unique: false });
                    sessions.createIndex('phase', 'phase', { unique: false });
                }

                // Einstellungen (Key-Value)
                if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
                    db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
                }

                // Emotionale Anker
                if (!db.objectStoreNames.contains(STORES.ANCHORS)) {
                    db.createObjectStore(STORES.ANCHORS, {
                        keyPath: 'id',
                        autoIncrement: true,
                    });
                }

                // Baseline-Messung
                if (!db.objectStoreNames.contains(STORES.BASELINE)) {
                    db.createObjectStore(STORES.BASELINE, { keyPath: 'key' });
                }

                // Altes Resonanztest-Format (4-Schritt-RMSSD-Protokoll) entfernen —
                // ersetzt durch frequencyTests/rhythmTests/dailyChecks (inkompatibles Format)
                if (db.objectStoreNames.contains('resonanzresults')) {
                    db.deleteObjectStore('resonanzresults');
                }

                // Protokoll 1: Frequenz-Scan-Ergebnisse
                if (!db.objectStoreNames.contains('frequencyTests')) {
                    const ft = db.createObjectStore('frequencyTests', {
                        keyPath: 'id',
                        autoIncrement: true,
                    });
                    ft.createIndex('date', 'date', { unique: false });
                }

                // Protokoll 2: Verhältnis-/Pausen-Scan-Ergebnisse
                if (!db.objectStoreNames.contains('rhythmTests')) {
                    const rt = db.createObjectStore('rhythmTests', {
                        keyPath: 'id',
                        autoIncrement: true,
                    });
                    rt.createIndex('date', 'date', { unique: false });
                }

                // Protokoll 3: tägliche 5-Minuten-Checks
                if (!db.objectStoreNames.contains('dailyChecks')) {
                    const dc = db.createObjectStore('dailyChecks', {
                        keyPath: 'id',
                        autoIncrement: true,
                    });
                    dc.createIndex('date', 'date', { unique: false });
                }

                // Zone-2-Ergebnisse (Feld- und Stufentest)
                if (!db.objectStoreNames.contains('zone2results')) {
                    const z2 = db.createObjectStore('zone2results', {
                        keyPath: 'id',
                        autoIncrement: true,
                    });
                    z2.createIndex('date', 'date', { unique: false });
                }

                // Nacht-Atemfrequenz-Messungen
                if (!db.objectStoreNames.contains('sleepMeasurements')) {
                    const sm = db.createObjectStore('sleepMeasurements', {
                        keyPath: 'id',
                        autoIncrement: true,
                    });
                    sm.createIndex('date', 'date', { unique: false });
                }
            };

            request.onsuccess = (e) => {
                this.db = e.target.result;
                resolve();
            };

            request.onerror = (e) => reject(e.target.error);
        });
    }

    // ─── Sessions ────────────────────────────────────────────────────────────

    async saveSession(session) {
        const data = {
            date:            new Date().toISOString(),
            phase:           session.phase,
            durationSeconds: session.durationSeconds,
            avgCoherence:    session.avgCoherence,
            peakCoherence:   session.peakCoherence,
            avgRMSSD:        session.avgRMSSD,
            peakRMSSD:       session.peakRMSSD,
            lfhfRatio:       session.lfhfRatio,
            breathRhythm:    session.breathRhythm,
            anchorId:        session.anchorId,
            anchorName:      session.anchorName,
            timeToCoherence: session.timeToCoherence ?? null,
            coherenceData:   session.coherenceData ?? [],
            longestStreak:   session.longestStreak ?? 0,
            bodyScanBaseline: session.bodyScanBaseline ?? null,
        };

        return this._add(STORES.SESSIONS, data);
    }

    async getSessions(limit = 50) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORES.SESSIONS, 'readonly');
            const store = tx.objectStore(STORES.SESSIONS);
            const index = store.index('date');
            const results = [];

            const request = index.openCursor(null, 'prev');
            request.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor && results.length < limit) {
                    results.push(cursor.value);
                    cursor.continue();
                } else {
                    resolve(results);
                }
            };
            request.onerror = (e) => reject(e.target.error);
        });
    }

    async getSessionsByPhase(phase) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORES.SESSIONS, 'readonly');
            const store = tx.objectStore(STORES.SESSIONS);
            const index = store.index('phase');
            const request = index.getAll(phase);
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    // ─── Einstellungen ────────────────────────────────────────────────────────

    async getSetting(key, defaultValue = null) {
        const record = await this._get(STORES.SETTINGS, key);
        return record ? record.value : defaultValue;
    }

    async setSetting(key, value) {
        return this._put(STORES.SETTINGS, { key, value });
    }

    // ─── Emotionale Anker ────────────────────────────────────────────────────

    async getAnchors() {
        return this._getAll(STORES.ANCHORS);
    }

    async saveAnchor(anchor) {
        if (anchor.id) {
            return this._put(STORES.ANCHORS, anchor);
        }
        return this._add(STORES.ANCHORS, anchor);
    }

    async deleteAnchor(id) {
        return this._delete(STORES.ANCHORS, id);
    }

    // ─── Baseline ────────────────────────────────────────────────────────────

    async saveBaseline(data) {
        return this._put(STORES.BASELINE, { key: 'baseline', ...data, date: new Date().toISOString() });
    }

    async getBaseline() {
        return this._get(STORES.BASELINE, 'baseline');
    }

    // ─── Kalibrierungs-Ergebnisse (Protokoll 1/2/3) ──────────────────────────

    async saveFrequencyTest(result) {
        return this._add('frequencyTests', { date: new Date().toISOString(), ...result });
    }

    async getFrequencyTests(limit = 10) {
        return this._getRecent('frequencyTests', limit);
    }

    async saveRhythmTest(result) {
        return this._add('rhythmTests', { date: new Date().toISOString(), ...result });
    }

    async getRhythmTests(limit = 10) {
        return this._getRecent('rhythmTests', limit);
    }

    async saveDailyCheck(result) {
        return this._add('dailyChecks', { date: new Date().toISOString(), ...result });
    }

    async getDailyChecks(limit = 10) {
        return this._getRecent('dailyChecks', limit);
    }

    /** Letzter Daily-Check, falls von heute (lokales Datum) – sonst null */
    async getTodaysDailyCheck() {
        const [latest] = await this.getDailyChecks(1);
        if (!latest) return null;
        const today = new Date().toDateString();
        return new Date(latest.date).toDateString() === today ? latest : null;
    }

    // ─── Zone-2-Ergebnisse ───────────────────────────────────────────────────

    async saveZone2Result(result) {
        return this._add('zone2results', result);
    }

    async getZone2Results(limit = 10) {
        return new Promise((resolve, reject) => {
            const tx      = this.db.transaction('zone2results', 'readonly');
            const store   = tx.objectStore('zone2results');
            const index   = store.index('date');
            const results = [];
            const request = index.openCursor(null, 'prev');
            request.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor && results.length < limit) {
                    results.push(cursor.value);
                    cursor.continue();
                } else {
                    resolve(results);
                }
            };
            request.onerror = (e) => reject(e.target.error);
        });
    }

    // ─── Nacht-Atemfrequenz-Messungen ────────────────────────────────────────

    async saveSleepMeasurement(result) {
        return this._add('sleepMeasurements', { date: new Date().toISOString(), ...result });
    }

    async getSleepMeasurements(limit = 10) {
        return this._getRecent('sleepMeasurements', limit);
    }

    // ─── Statistiken ─────────────────────────────────────────────────────────

    async getStats() {
        const sessions = await this.getSessions(1000);
        if (sessions.length === 0) return null;

        const coherenceValues = sessions.map(s => s.avgCoherence).filter(Boolean);
        const rmssdValues = sessions.map(s => s.avgRMSSD).filter(Boolean);

        return {
            totalSessions: sessions.length,
            totalMinutes: Math.round(sessions.reduce((a, s) => a + (s.durationSeconds || 0), 0) / 60),
            peakCoherence: Math.max(...sessions.map(s => s.peakCoherence || 0)),
            avgCoherence: coherenceValues.length
                ? Math.round(coherenceValues.reduce((a, b) => a + b, 0) / coherenceValues.length)
                : 0,
            peakRMSSD: Math.max(...sessions.map(s => s.peakRMSSD || 0)),
            avgRMSSD: rmssdValues.length
                ? Math.round(rmssdValues.reduce((a, b) => a + b, 0) / rmssdValues.length)
                : 0,
            lastSession: sessions[0]?.date ?? null,
            recentSessions: sessions.slice(0, 14),
        };
    }

    // ─── Hilfsmethoden ───────────────────────────────────────────────────────

    _getRecent(storeName, limit) {
        return new Promise((resolve, reject) => {
            const tx      = this.db.transaction(storeName, 'readonly');
            const store   = tx.objectStore(storeName);
            const index   = store.index('date');
            const results = [];
            const request = index.openCursor(null, 'prev');
            request.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor && results.length < limit) {
                    results.push(cursor.value);
                    cursor.continue();
                } else {
                    resolve(results);
                }
            };
            request.onerror = (e) => reject(e.target.error);
        });
    }

    _add(storeName, data) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readwrite');
            const request = tx.objectStore(storeName).add(data);
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    _put(storeName, data) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readwrite');
            const request = tx.objectStore(storeName).put(data);
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    _get(storeName, key) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readonly');
            const request = tx.objectStore(storeName).get(key);
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    _getAll(storeName) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readonly');
            const request = tx.objectStore(storeName).getAll();
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    _delete(storeName, key) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readwrite');
            const request = tx.objectStore(storeName).delete(key);
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }
}
