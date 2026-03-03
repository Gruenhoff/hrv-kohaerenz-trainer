/**
 * Datenbank-Modul (IndexedDB)
 * Speichert Sessions, Einstellungen, Fortschrittsdaten
 */

const DB_NAME = 'hrv-trainer';
const DB_VERSION = 1;

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
