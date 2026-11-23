// SkyRent global operations UI. Talks to the JSON API in server.js; every response
// carries a trace that is shown in the "Vykdymo eiga" panel.
const $ = (sel, el = document) => el.querySelector(sel);

const STATUS_LT = { available: 'laisvas', rented: 'išnuomotas', maintenance: 'remontas', retired: 'nurašytas' };
const COND_LT = { excellent: 'puiki', good: 'gera', fair: 'patenkinama', poor: 'prasta' };

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (n) => (n == null ? '–' : `${Number(n).toFixed(2)} €`);

let lookups = null;
let drones = [];
let editing = null; // drone being edited, null = new drone

// ------------------------------------------------------------------ API + trace

// quiet: do not replace the trace panel (list refresh right after a write keeps the write's trace)
async function api(method, url, body, title, { quiet = false } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}`, trace: [] }));
  if (!quiet || !res.ok) showTrace(title, res.ok, data.trace ?? [], data.error);
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data.result;
}

function chipClass(target) {
  if (target.startsWith('m1_')) return 'm1';
  if (target.startsWith('M2_')) return 'm2';
  if (target === '2PC') return 'pc';
  if (target === 'klaida') return 'bad';
  return 'gl';
}

function showTrace(title, ok, trace, error) {
  const head = $('#trace-head');
  head.className = `trace-head ${ok ? 'ok' : 'fail'}`;
  head.textContent = ok ? `✓ ${title}` : `✗ ${title}: ${error}`;
  $('#trace-list').innerHTML = trace.map((s) =>
    `<li><span class="chip ${chipClass(s.target)}">${esc(s.target)}</span><span class="text">${esc(s.text)}</span></li>`).join('');
}

// ------------------------------------------------------------------ tabs

document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== `tab-${btn.dataset.tab}`; });
  });
});

document.querySelectorAll('dialog [data-close]').forEach((b) =>
  b.addEventListener('click', () => b.closest('dialog').close()));

// ------------------------------------------------------------------ drones: select

function fillSelect(select, options, keepFirst = false) {
  const first = keepFirst ? select.options[0].outerHTML : '';
  select.innerHTML = first + options;
}

async function loadLookups() {
  lookups = await api('GET', '/api/lookups', null, 'Žinynai (filialai iš abiejų M1, modeliai)');
  const statusOpts = lookups.statuses.map((s) => `<option value="${s}">${STATUS_LT[s]} (${s})</option>`).join('');
  const condOpts = lookups.conditions.map((c) => `<option value="${c}">${COND_LT[c]} (${c})</option>`).join('');
  fillSelect($('#drone-filter [name=status]'), statusOpts, true);
  fillSelect($('#drone-filter [name=condition]'), condOpts, true);

  const f = $('#drone-form');
  fillSelect(f.status, statusOpts);
  fillSelect(f.condition, condOpts);
  const byCountry = {};
  for (const b of lookups.branches) (byCountry[b.country_code] ??= []).push(b);
  fillSelect(f.branch_id, Object.entries(byCountry).map(([cc, list]) =>
    `<optgroup label="${cc} → ${list[0].fragment}">${list.map((b) =>
      `<option value="${b.branch_id}">${esc(b.name)}</option>`).join('')}</optgroup>`).join(''));
  fillSelect(f.model_id, lookups.models.map((m) =>
    `<option value="${m.model_id}">${esc(m.manufacturer)} ${esc(m.model_name)} · ${esc(m.category)}</option>`).join(''));
}

async function loadDrones({ quiet = false } = {}) {
  const params = new URLSearchParams(new FormData($('#drone-filter')));
  for (const [k, v] of [...params]) if (!v) params.delete(k);
  const label = [...params.values()].join(', ') || 'be filtrų';
  drones = await api('GET', `/api/drones?${params}`, null, `Atrinkimas: dronai (${label})`, { quiet });
  renderDrones();
}

function renderDrones() {
  $('#drone-empty').hidden = drones.length > 0;
  $('#drone-table tbody').innerHTML = drones.map((d) => `
    <tr data-id="${d.drone_id}">
      <td class="mono"><button class="link" data-act="card" title="Drono kortelė">${esc(d.serial_number)}</button></td>
      <td>${esc(d.model)}</td>
      <td title="${esc(d.branch_name)}">${esc(d.branch_name.replace(/^SkyRent /, ''))} <span class="sub">${d.country_code}</span>
        <span class="chip gl tiny" title="Horizontalusis fragmentas">${d.fragment}</span></td>
      <td class="status-${d.status}">${STATUS_LT[d.status]}</td>
      <td class="num">${Number(d.daily_rate).toFixed(2)}</td>
      <td class="cond-${d.condition}">${COND_LT[d.condition]}</td>
      <td class="num">${Number(d.total_flight_hours).toFixed(1)}</td>
      <td>${d.last_inspection_date ?? '<span class="sub">niekada</span>'}</td>
      <td class="row-actions">
        <button class="small" data-act="edit">Keisti</button>
        <button class="small danger" data-act="delete">Šalinti</button>
      </td>
    </tr>`).join('');
}

$('#drone-filter').addEventListener('submit', (e) => {
  e.preventDefault();
  loadDrones().catch(() => {});
});

$('#drone-table').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const drone = drones.find((d) => d.drone_id === btn.closest('tr').dataset.id);
  if (btn.dataset.act === 'card') openCard(drone);
  if (btn.dataset.act === 'edit') openForm(drone);
  if (btn.dataset.act === 'delete') deleteDrone(drone);
});

async function openCard(d) {
  let data;
  try {
    data = await api('GET', `/api/drones/${d.drone_id}`, null, `Atrinkimas: drono kortelė ${d.serial_number}`);
  } catch { return; }
  const x = data.drone;
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  $('#card-body').innerHTML = `
    <h2>${esc(x.model)} · ${esc(x.serial_number)}</h2>
    <p class="card-sub">drone_id ${x.drone_id} · fragmentai m1_${x.fragment} + M2_${x.fragment}</p>
    <div class="card-grid">
      <div><h3><span class="chip m1">M1</span> drone_commercial</h3><dl>
        ${row('Filialas', `${esc(x.branch_name)} (${x.country_code})`)}
        ${row('Pirkta', `${x.purchase_date}, ${eur(x.purchase_price)}`)}
        ${row('Dienos kaina', eur(x.daily_rate))}
        ${row('Užstatas', eur(x.deposit_amount))}
        ${row('Statusas', STATUS_LT[x.status])}
      </dl></div>
      <div><h3><span class="chip m2">M2</span> drone_technical</h3><dl>
        ${row('Programinė įranga', esc(x.firmware_version))}
        ${row('Skrydžio valandos', Number(x.total_flight_hours).toFixed(1))}
        ${row('Baterijos ciklai', x.battery_cycles)}
        ${row('Paskutinė apžiūra', x.last_inspection_date ?? 'niekada')}
        ${row('Būklė', COND_LT[x.condition])}
      </dl></div>
    </div>
    <div class="stats">
      <div class="stat"><b>${data.rentals.count}</b><span>nuomų (M1)</span></div>
      <div class="stat"><b>${eur(data.rentals.income)}</b><span>pajamų (M1)</span></div>
      <div class="stat"><b>${data.flights.count}</b><span>skrydžių, ${Math.round(data.flights.km)} km (M2)</span></div>
      <div class="stat"><b>${data.flights.incidents}</b><span>incidentų (M2)</span></div>
    </div>
    <h3>Techninės apžiūros <span class="chip m2 tiny">M2 įterptas masyvas</span></h3>
    ${data.maintenance.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Data</th><th>Tipas</th><th>Aprašymas</th><th>Technikas</th><th class="num">Kaina</th></tr></thead>
      <tbody>${data.maintenance.map((m) => `<tr>
        <td>${m.maintenance_date}</td><td>${esc(m.maintenance_type)}</td>
        <td style="white-space:normal">${esc(m.description)}</td><td>${esc(m.employee)}</td>
        <td class="num">${eur(m.cost)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="sub">Apžiūrų nėra.</p>'}`;
  $('#card-dialog').showModal();
}

// ------------------------------------------------------------------ drones: insert / update

const FIELDS = ['branch_id', 'model_id', 'purchase_date', 'purchase_price', 'daily_rate', 'deposit_amount', 'status',
  'serial_number', 'firmware_version', 'total_flight_hours', 'battery_cycles', 'last_inspection_date', 'condition'];
const NUMERIC = new Set(['model_id', 'purchase_price', 'daily_rate', 'deposit_amount', 'total_flight_hours', 'battery_cycles']);

function openForm(drone = null) {
  editing = drone;
  const f = $('#drone-form');
  f.reset();
  $('#drone-form-error').hidden = true;
  $('#drone-form-title').textContent = drone ? `Redaguoti droną ${drone.serial_number}` : 'Naujas dronas';
  if (drone) {
    for (const k of FIELDS) f[k].value = drone[k] ?? '';
  } else {
    f.purchase_date.value = new Date().toISOString().slice(0, 10);
    f.total_flight_hours.value = 0;
    f.battery_cycles.value = 0;
    f.status.value = 'available';
    f.condition.value = 'excellent';
  }
  $('#drone-dialog').showModal();
}

// For an update only the attributes that changed are sent, so the trace shows exactly
// which vertical fragment (M1, M2 or both) had to be touched.
function formValues() {
  const f = $('#drone-form');
  const out = {};
  for (const k of FIELDS) {
    const raw = f[k].value.trim();
    const value = raw === '' ? null : NUMERIC.has(k) ? Number(raw) : raw;
    if (editing) {
      const old = editing[k] ?? null;
      const same = NUMERIC.has(k) ? Number(old) === value : old === value;
      if (same) continue;
    }
    out[k] = value;
  }
  return out;
}

$('#drone-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = formValues();
  const err = $('#drone-form-error');
  err.hidden = true;
  try {
    if (editing) {
      if (!Object.keys(body).length) { err.textContent = 'Niekas nepakeista.'; err.hidden = false; return; }
      await api('PATCH', `/api/drones/${editing.drone_id}`, body,
        `Redagavimas: ${editing.serial_number} (${Object.keys(body).join(', ')})`);
    } else {
      await api('POST', '/api/drones', body, `Įterpimas: naujas dronas ${body.serial_number}`);
    }
    $('#drone-dialog').close();
    await loadDrones({ quiet: true }).catch(() => {});
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

$('#new-drone').addEventListener('click', () => openForm(null));

// ------------------------------------------------------------------ drones: delete

async function deleteDrone(d) {
  if (!confirm(`Pašalinti droną ${d.serial_number} (${d.model}) kartu su jo nuomomis, mokėjimais ir skrydžiais?`)) return;
  try {
    const r = await api('DELETE', `/api/drones/${d.drone_id}`, null, `Šalinimas: dronas ${d.serial_number}`);
    const del = r.deleted;
    $('#trace-head').textContent += `. Pašalinta: ${del.payment} payment, ${del.rental} rental, ` +
      `1 drone_commercial (m1_${r.fragment}); ${del.flight_log} flight_log, ` +
      `1 drone_technical su ${del.maintenance} maintenance (M2_${r.fragment}).`;
    await loadDrones({ quiet: true });
  } catch { /* shown in the trace */ }
}

// ------------------------------------------------------------------ rentals (Lukas)

$('#try-rentals').addEventListener('click', () => api('GET', '/api/rentals', null, 'Nuomų atrinkimas').catch(() => {}));

// ------------------------------------------------------------------ orphan check

$('#run-check').addEventListener('click', async () => {
  let checks;
  try { checks = await api('GET', '/api/check', null, 'Našlaičių patikra'); } catch { return; }
  $('#check-list').innerHTML = checks.map((c) => `
    <li>
      <span class="mark ${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✗'}</span>
      <span>${esc(c.name)}</span>
      <span>${c.ok ? '' : `${c.count} įr.`}</span>
      ${c.ok ? '' : `<span class="sample">${c.sample.map(esc).join(', ')}</span>`}
    </li>`).join('');
});

// ------------------------------------------------------------------ start

loadLookups().then(loadDrones).catch(() => {});
