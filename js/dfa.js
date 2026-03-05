/**
 * DFA-alpha1 – Detrended Fluctuation Analysis (Kurzzeit-Exponent)
 *
 * Algorithmus:
 *   1. Integriere die RR-Reihe (kumulative Abweichung vom Mittelwert)
 *   2. Teile in Segmente der Länge n auf (n = 4 … 16)
 *   3. Passe pro Segment einen linearen Trend an, berechne RMS der Residuen F(n)
 *   4. Lineare Regression im Log-Log-Raum → Steigung = alpha1
 *
 * alpha1 ≈ 0.75  →  aerobe Schwelle (VT1) / obere Grenze Zone 2
 * alpha1 < 0.5   →  VT2 überschritten
 *
 * Benötigt mindestens 32 RR-Intervalle (optimal ≥ 128).
 *
 * @param  {number[]} rrArray – RR-Intervalle in Millisekunden
 * @returns {number|null}      – alpha1 (3 Dezimalstellen) oder null
 */
export function computeAlpha1(rrArray) {
    if (!rrArray || rrArray.length < 32) return null;

    const N    = rrArray.length;
    const mean = rrArray.reduce((s, v) => s + v, 0) / N;

    // 1. Integrierte Zeitreihe
    const y = new Float64Array(N);
    let cumsum = 0;
    for (let i = 0; i < N; i++) {
        cumsum += rrArray[i] - mean;
        y[i]    = cumsum;
    }

    // 2. RMS-Fluktuation für n = 4 … 16
    const logN = [];
    const logF = [];

    for (let n = 4; n <= 16; n++) {
        const numSeg = Math.floor(N / n);
        if (numSeg < 2) break;

        let sumSq = 0;
        let total = 0;

        for (let s = 0; s < numSeg; s++) {
            const off = s * n;

            // Lineare Regression im Segment (least squares)
            let sx = 0, sy = 0, sxx = 0, sxy = 0;
            for (let i = 0; i < n; i++) {
                sx  += i;
                sy  += y[off + i];
                sxx += i * i;
                sxy += i * y[off + i];
            }
            const denom = n * sxx - sx * sx;
            const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
            const inter = (sy - slope * sx) / n;

            // Residuen-Quadrate
            for (let i = 0; i < n; i++) {
                const res = y[off + i] - (slope * i + inter);
                sumSq += res * res;
            }
            total += n;
        }

        if (total === 0) continue;
        const F = Math.sqrt(sumSq / total);
        if (F > 0) {
            logN.push(Math.log(n));
            logF.push(Math.log(F));
        }
    }

    if (logN.length < 3) return null;

    // 3. Log-Log-Regression → Steigung = alpha1
    const m = logN.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < m; i++) {
        sx  += logN[i];
        sy  += logF[i];
        sxx += logN[i] * logN[i];
        sxy += logN[i] * logF[i];
    }
    const denom   = m * sxx - sx * sx;
    if (denom === 0) return null;

    const alpha1 = (m * sxy - sx * sy) / denom;
    return Math.round(alpha1 * 1000) / 1000;  // 3 Dezimalstellen
}
