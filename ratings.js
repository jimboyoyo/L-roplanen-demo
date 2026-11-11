// ─── Project ratings ──────────────────────────────────────────────────────────
//
//  • A student who has finished a project sees five stars in that project's panel
//    header and can rate it 1–5 (clicking again changes the rating).
//  • The average of all students' ratings is drawn as gold stars above the
//    project's node on the map.
//
// Data lives in Firebase next to the rest of the student data:
//     students/{studentKey}/ratings/{nodeId} = 1..5
// The page only READS Firebase. Saving goes through the Worker (POST /student/rate),
// which takes the student from the login token. See worker/rate-endpoint.md.
//
// Loaded after badges.js. badges.js calls window.updateProjectRatings(fbData)
// every time it has fetched students.json, so the map stars follow the live data.

(function () {
  const RATE_WORKER = 'https://aged-math-1ef5.jimbernstrom.workers.dev';
  const STAR_GOLD   = '#ffc928';
  const SVG_NS      = 'http://www.w3.org/2000/svg';

  // ── State ───────────────────────────────────────────────────────────────────
  let lastFbData  = {};     // the latest students.json (with our own saves patched in)
  let ratingStats = {};     // nodeId → { avg, count }
  let drawnSig    = '';     // what the map currently shows, so we only redraw on change

  const toList = raw => Array.isArray(raw) ? raw : Object.values(raw || {});
  const isStudentLogin = () => (window.loggedInEmail || '').endsWith('@edu.orebro.se');
  const ownName = () => window.loggedInStudentName || sessionStorage.getItem('auth_name') || '';
  const fmt = n => n.toLocaleString('sv-SE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  // ── Averages ────────────────────────────────────────────────────────────────
  // A rating only counts while the student still has the project among their
  // finished ones (so removing a finished project also removes its rating).
  function buildRatingStats(fbData) {
    const sums = {};
    Object.values(fbData || {}).forEach(st => {
      if (!st || typeof st.ratings !== 'object' || !st.ratings) return;
      const finished = new Set(toList(st.finished?.projects));
      Object.entries(st.ratings).forEach(([id, v]) => {
        const n = Number(v);
        if (!/^project-/.test(id) || !finished.has(id) || !Number.isInteger(n) || n < 1 || n > 5) return;
        (sums[id] = sums[id] || { sum: 0, count: 0 });
        sums[id].sum += n;
        sums[id].count += 1;
      });
    });
    const stats = {};
    Object.entries(sums).forEach(([id, s]) => { stats[id] = { avg: s.sum / s.count, count: s.count }; });
    return stats;
  }

  // ── Stars on the map ────────────────────────────────────────────────────────
  function starPoints(cx, cy, outer) {
    const inner = outer * 0.4;
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? outer : inner;
      const a = -Math.PI / 2 + i * Math.PI / 5;
      pts.push((cx + r * Math.cos(a)).toFixed(2) + ',' + (cy + r * Math.sin(a)).toFixed(2));
    }
    return pts.join(' ');
  }

  function ensureHalfStarGradient(svg) {
    if (svg.getElementById('rating-half-star')) return;
    const defs = svg.querySelector('defs') || svg.insertBefore(document.createElementNS(SVG_NS, 'defs'), svg.firstChild);
    const g = document.createElementNS(SVG_NS, 'linearGradient');
    g.setAttribute('id', 'rating-half-star');
    g.setAttribute('x1', '0'); g.setAttribute('x2', '1'); g.setAttribute('y1', '0'); g.setAttribute('y2', '0');
    [['0.5', STAR_GOLD, '1'], ['0.5', STAR_GOLD, '0.22']].forEach(([offset, colour, opacity]) => {
      const s = document.createElementNS(SVG_NS, 'stop');
      s.setAttribute('offset', offset); s.setAttribute('stop-color', colour); s.setAttribute('stop-opacity', opacity);
      g.appendChild(s);
    });
    defs.appendChild(g);
  }

  // The box of the node itself (its first rect), falling back to the whole group.
  function nodeBox(el) {
    try {
      const target = el.tagName === 'rect' ? el : (el.querySelector('rect') || el);
      const b = target.getBBox();
      return b.width ? b : null;
    } catch (e) { return null; }
  }

  function renderMapStars() {
    const svg = typeof getSvg === 'function' ? getSvg() : null;
    if (!svg) return;

    // Whole and half stars to show for every rated project: the average, to the nearest half
    const shown = Object.entries(ratingStats).map(([id, s]) => [id, Math.round(s.avg * 2) / 2]);
    const sig = shown.map(([id, v]) => id + ':' + v).sort().join('|');
    if (sig === drawnSig && svg.getElementById('rating-layer')) return;
    drawnSig = sig;

    svg.getElementById('rating-layer')?.remove();
    const layer = document.createElementNS(SVG_NS, 'g');
    layer.setAttribute('id', 'rating-layer');
    layer.style.pointerEvents = 'none';                 // stars never get in the way of clicking a node
    ensureHalfStarGradient(svg);

    shown.forEach(([id, value]) => {
      const el = svg.getElementById(id);
      const box = el && nodeBox(el);
      if (!box) return;

      const count   = Math.ceil(value);                 // 3.5 → three whole stars and one half
      const half    = value % 1 !== 0;
      const size    = Math.max(10, box.width / 5.4);    // five stars always fit across the node
      const gap     = size * 0.12;
      const rowW    = count * size + (count - 1) * gap;
      const left    = box.x + box.width / 2 - rowW / 2;
      const centreY = box.y - size * 0.8;               // sits just above the node's top edge (clear of its border)

      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'rating-stars');
      g.setAttribute('data-node', id);
      for (let i = 0; i < count; i++) {
        const star = document.createElementNS(SVG_NS, 'polygon');
        star.setAttribute('points', starPoints(left + size / 2 + i * (size + gap), centreY, size / 2));
        star.setAttribute('fill', half && i === count - 1 ? 'url(#rating-half-star)' : STAR_GOLD);
        star.setAttribute('stroke', 'rgba(10,10,26,0.75)');
        star.setAttribute('stroke-width', (size * 0.07).toFixed(2));
        star.setAttribute('stroke-linejoin', 'round');
        g.appendChild(star);
      }
      layer.appendChild(g);
    });

    // Under the student icons (they are appended to the SVG after the map has loaded)
    const studentLayer = svg.getElementById('student-layer');
    if (studentLayer) svg.insertBefore(layer, studentLayer); else svg.appendChild(layer);
  }

  // Called by badges.js with every fresh students.json
  window.updateProjectRatings = function (fbData) {
    lastFbData  = fbData || {};
    ratingStats = buildRatingStats(lastFbData);
    renderMapStars();
    refreshAverageText();
  };

  // ── Rating row in the project panel (students only, finished projects only) ─
  const ROW_ID = 'ratingRow';
  const removeRatingRow = () => document.getElementById(ROW_ID)?.remove();

  function refreshAverageText() {
    const row = document.getElementById(ROW_ID);
    const out = row?.querySelector('.rating-avg');
    if (!out) return;
    const s = ratingStats[row.dataset.node];
    out.textContent = s ? `Snitt ${fmt(s.avg)} · ${s.count} betyg` : '';
  }

  async function saveRating(nodeId, rating) {
    const token = sessionStorage.getItem('auth_token');
    const res = await fetch(RATE_WORKER + '/student/rate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, nodeId, rating }),
    });
    if (!res.ok) throw new Error('Worker ' + res.status);
    return res.json().catch(() => ({}));
  }

  async function addRatingRow(name) {
    removeRatingRow();
    const studentName = ownName();
    if (!isStudentLogin() || !studentName || !/^project-/.test(name)) return;
    const header = document.querySelector('#panel .panel-header > div:first-child');
    if (!header) return;

    // Who we are and whether the project is finished (the same data the ✓ button reads)
    const key = nameToKey(studentName);
    let st = {};
    try {
      const r = await fetch(`https://laroplanen-help-default-rtdb.europe-west1.firebasedatabase.app/students/${encodeURIComponent(key)}.json`);
      st = await r.json() || {};
    } catch (e) { return; }
    if (!toList(st.finished?.projects).includes(name)) return;
    if (document.getElementById(ROW_ID)) return;                       // a faster call already added it
    const stillHere = document.getElementById('panelTitle');
    if (!stillHere || document.getElementById('panel').classList.contains('closed')) return;

    let mine = Number(st.ratings?.[name]) || 0;

    const row = document.createElement('div');
    row.id = ROW_ID;
    row.dataset.node = name;
    row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap;';
    row.innerHTML = `
      <span class="rating-label" style="font-size:11px;color:#999;"></span>
      <span class="rating-stars-input" role="radiogroup" aria-label="Betygsätt projektet" style="display:inline-flex;gap:1px;"></span>
      <span class="rating-avg" style="font-size:11px;color:#aaa;"></span>`;
    header.appendChild(row);

    const label = row.querySelector('.rating-label');
    const holder = row.querySelector('.rating-stars-input');
    const stars = [1, 2, 3, 4, 5].map(n => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', n + (n === 1 ? ' stjärna' : ' stjärnor'));
      b.textContent = '★';
      b.style.cssText = 'background:none;border:none;padding:0 1px;font-size:22px;line-height:1;cursor:pointer;font-family:inherit;transition:transform 0.1s;';
      holder.appendChild(b);
      return b;
    });

    const paint = upTo => stars.forEach((b, i) => {
      b.style.color = i < upTo ? STAR_GOLD : '#d8d8de';
      b.setAttribute('aria-checked', String(i + 1 === mine));
    });
    const setLabel = text => { label.textContent = text; };
    const idleLabel = () => setLabel(mine ? 'Ditt betyg' : 'Betygsätt projektet');

    paint(mine); idleLabel(); refreshAverageText();

    stars.forEach((b, i) => {
      b.addEventListener('mouseenter', () => { paint(i + 1); b.style.transform = 'scale(1.15)'; });
      b.addEventListener('mouseleave', () => { paint(mine); b.style.transform = ''; });
      b.addEventListener('click', async () => {
        const rating = i + 1;
        if (rating === mine) return;
        const previous = mine;
        stars.forEach(s => { s.disabled = true; });
        setLabel('Sparar…');
        try {
          await saveRating(name, rating);
          mine = rating;
          // Show it on the map straight away; the next poll brings the server's numbers
          const own = (lastFbData[key] = lastFbData[key] || {});
          own.ratings = { ...(own.ratings || {}), [name]: rating };
          if (!toList(own.finished?.projects).includes(name)) {
            own.finished = { ...(own.finished || {}), projects: [...toList(own.finished?.projects), name] };
          }
          window.updateProjectRatings(lastFbData);
          setLabel('Tack för ditt betyg!');
          setTimeout(() => { if (row.isConnected) idleLabel(); }, 2500);
        } catch (err) {
          console.error('[rating]', err);
          mine = previous;
          setLabel('Kunde inte spara – försök igen');
        } finally {
          stars.forEach(s => { s.disabled = false; });
          paint(mine);
        }
      });
    });
  }

  // ── Hook into the panel functions that already exist ────────────────────────
  if (typeof openPanel === 'function' && !openPanel.__withRating) {
    const _openPanel = openPanel;
    openPanel = function (name, ...rest) {
      const p = _openPanel.call(this, name, ...rest);
      addRatingRow(name).catch(e => console.warn('Rating row failed:', e));
      return p;
    };
    openPanel.__withRating = true;
  }
  ['openStudentPanel', 'openHallOfFame', 'openClassOverview', 'closePanel'].forEach(fn => {
    if (typeof window[fn] !== 'function' || window[fn].__noRatingRow) return;
    const orig = window[fn];
    window[fn] = function (...a) { removeRatingRow(); return orig.apply(this, a); };
    window[fn].__noRatingRow = true;
  });
})();
