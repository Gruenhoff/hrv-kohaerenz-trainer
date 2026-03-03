/**
 * Dashboard-Modul
 * Historische Daten und Fortschrittsdiagramme via Chart.js
 */

export class Dashboard {
    constructor(db) {
        this.db = db;
        this.charts = {};
    }

    async render(container) {
        const stats = await this.db.getStats();
        const baseline = await this.db.getBaseline();
        const anchors = await this.db.getAnchors();

        container.innerHTML = this._buildHTML(stats, baseline);
        if (stats) {
            this._buildCharts(stats.recentSessions);
            this._fillStats(stats, baseline);
        }
    }

    _buildHTML(stats, baseline) {
        const hasData = stats && stats.totalSessions > 0;
        return `
            <!-- Statistik-Karten -->
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-icon">💚</div>
                    <div class="stat-value" id="dash-avg-coherence">${hasData ? stats.avgCoherence + '%' : '—'}</div>
                    <div class="stat-label">Ø Kohärenz</div>
                </div>
                <div class="stat-card stat-card--accent">
                    <div class="stat-icon">⭐</div>
                    <div class="stat-value" id="dash-peak-coherence">${hasData ? stats.peakCoherence + '%' : '—'}</div>
                    <div class="stat-label">Rekord</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon">🫀</div>
                    <div class="stat-value" id="dash-avg-rmssd">${hasData ? stats.avgRMSSD + ' ms' : '—'}</div>
                    <div class="stat-label">Ø RMSSD</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon">📅</div>
                    <div class="stat-value" id="dash-total-sessions">${hasData ? stats.totalSessions : '0'}</div>
                    <div class="stat-label">Sessions</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon">⏱️</div>
                    <div class="stat-value" id="dash-total-minutes">${hasData ? stats.totalMinutes + ' min' : '—'}</div>
                    <div class="stat-label">Trainingszeit</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon">📈</div>
                    <div class="stat-value" id="dash-baseline-compare">${this._baselineCompare(stats, baseline)}</div>
                    <div class="stat-label">vs. Baseline</div>
                </div>
            </div>

            ${hasData ? `
            <!-- Kohärenz-Verlauf -->
            <div class="dash-section">
                <h3 class="dash-section-title">Kohärenz-Verlauf</h3>
                <div class="chart-wrapper">
                    <canvas id="chart-coherence"></canvas>
                </div>
            </div>

            <!-- RMSSD-Verlauf -->
            <div class="dash-section">
                <h3 class="dash-section-title">RMSSD-Verlauf</h3>
                <div class="chart-wrapper">
                    <canvas id="chart-rmssd"></canvas>
                </div>
            </div>

            <!-- Letzte Sessions -->
            <div class="dash-section">
                <h3 class="dash-section-title">Letzte Sessions</h3>
                <div class="session-list">
                    ${stats.recentSessions.slice(0, 8).map(s => this._sessionRow(s)).join('')}
                </div>
            </div>
            ` : `
            <div class="dash-empty">
                <div class="dash-empty-icon">🌱</div>
                <p>Noch keine Sessions aufgezeichnet.<br>Starte dein erstes Training!</p>
            </div>
            `}
        `;
    }

    _baselineCompare(stats, baseline) {
        if (!stats || !baseline) return '—';
        const diff = stats.avgCoherence - (baseline.avgCoherence || 0);
        if (diff > 0) return `+${diff}%`;
        if (diff < 0) return `${diff}%`;
        return '0%';
    }

    _sessionRow(session) {
        const date = new Date(session.date);
        const dateStr = date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
        const timeStr = date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        const phaseLabels = { 1: 'Phase 1', 2: 'Phase 2', 3: 'Phase 3', 4: 'Phase 4' };
        const mins = Math.round((session.durationSeconds || 0) / 60);
        return `
            <div class="session-row">
                <div class="session-date">${dateStr} ${timeStr}</div>
                <div class="session-phase">${phaseLabels[session.phase] || 'Training'}</div>
                <div class="session-stats">
                    <span class="session-coherence" style="color: ${this._coherenceColor(session.avgCoherence)}">${session.avgCoherence || 0}%</span>
                    <span class="session-rmssd">${session.avgRMSSD || 0} ms</span>
                    <span class="session-duration">${mins} min</span>
                </div>
            </div>
        `;
    }

    _coherenceColor(score) {
        if (score >= 85) return '#00d4ff';
        if (score >= 70) return '#44dd88';
        if (score >= 50) return '#ffdd00';
        if (score >= 30) return '#ff8800';
        return '#ff4444';
    }

    _buildCharts(sessions) {
        if (!sessions || sessions.length === 0) return;
        if (typeof Chart === 'undefined') return;

        const chartDefaults = {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#162540',
                    titleColor: '#e8f0fe',
                    bodyColor: '#7a9bc0',
                    borderColor: '#00d4ff22',
                    borderWidth: 1,
                },
            },
            scales: {
                x: {
                    grid: { color: 'rgba(0,212,255,0.05)' },
                    ticks: { color: '#7a9bc0', font: { size: 11 } },
                },
                y: {
                    grid: { color: 'rgba(0,212,255,0.05)' },
                    ticks: { color: '#7a9bc0', font: { size: 11 } },
                },
            },
        };

        const reversed = [...sessions].reverse();
        const labels = reversed.map(s =>
            new Date(s.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
        );

        // Kohärenz-Chart
        const cohCanvas = document.getElementById('chart-coherence');
        if (cohCanvas) {
            if (this.charts.coherence) this.charts.coherence.destroy();
            this.charts.coherence = new Chart(cohCanvas, {
                type: 'line',
                data: {
                    labels,
                    datasets: [{
                        data: reversed.map(s => s.avgCoherence || 0),
                        borderColor: '#00d4ff',
                        backgroundColor: 'rgba(0,212,255,0.08)',
                        pointBackgroundColor: '#00d4ff',
                        pointRadius: 4,
                        tension: 0.4,
                        fill: true,
                    }, {
                        data: reversed.map(s => s.peakCoherence || 0),
                        borderColor: 'rgba(201,168,76,0.6)',
                        backgroundColor: 'transparent',
                        pointRadius: 3,
                        tension: 0.4,
                        borderDash: [4, 4],
                    }],
                },
                options: {
                    ...chartDefaults,
                    scales: {
                        ...chartDefaults.scales,
                        y: { ...chartDefaults.scales.y, min: 0, max: 100 },
                    },
                },
            });
        }

        // RMSSD-Chart
        const rmssdCanvas = document.getElementById('chart-rmssd');
        if (rmssdCanvas) {
            if (this.charts.rmssd) this.charts.rmssd.destroy();
            this.charts.rmssd = new Chart(rmssdCanvas, {
                type: 'line',
                data: {
                    labels,
                    datasets: [{
                        data: reversed.map(s => s.avgRMSSD || 0),
                        borderColor: '#00e5a0',
                        backgroundColor: 'rgba(0,229,160,0.08)',
                        pointBackgroundColor: '#00e5a0',
                        pointRadius: 4,
                        tension: 0.4,
                        fill: true,
                    }],
                },
                options: chartDefaults,
            });
        }
    }

    _fillStats(stats, baseline) {
        // Werte werden direkt in _buildHTML gesetzt
    }

    destroy() {
        Object.values(this.charts).forEach(c => c.destroy());
        this.charts = {};
    }
}
