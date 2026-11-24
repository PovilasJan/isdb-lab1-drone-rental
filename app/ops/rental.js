// Global object "Rental" (Lukas).
//
//   M1 (m1_lt / m1_lvee): rental + payment
//   M2 (M2_lt / M2_lvee): flight_log, linked by flight_log.rental_id
//   Fragment = rental.branch_id -> branch.country_code (lib/fragments.js: locateBranch / fragmentOf).
//   In M1 the FKs need the rental's customer and drone in the same fragment as its branch,
//   so that is checked before inserting. The drone's flight logs are in the M2 fragment with the same key.
const { runGlobal } = require('../lib/global-op');
const { FRAGMENTS, KEYS } = require('../lib/db');
const {
  fragmentsFor, assertUuid, newUuid, locateBranch, nextM1Id, nextM2Id,
} = require('../lib/fragments');
const { badRequest, conflict, notFound } = require('../lib/errors');

const RENTAL_STATUS = ['reserved', 'active', 'completed', 'cancelled'];
const PAYMENT_METHOD = ['card', 'bank_transfer', 'cash', 'paypal'];
const PAYMENT_TYPE = ['deposit', 'rental_fee', 'deposit_refund', 'damage_fee'];
const CONDITION = ['excellent', 'good', 'fair', 'poor'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 3600 * 1000;

// ---------------------------------------------------------------- validation helpers

function dateField(name, value) {
  if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw badRequest(`${name}: data turi būti YYYY-MM-DD`);
  }
  return value;
}

function numberField(name, value, { integer = false, min = 0, max = Infinity, positive = false } = {}) {
  const n = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (positive && n <= 0)) {
    throw badRequest(`${name}: neteisinga reikšmė`);
  }
  if (integer && !Number.isInteger(n)) throw badRequest(`${name}: turi būti sveikasis skaičius`);
  return n;
}

function enumField(name, value, values) {
  if (!values.includes(value)) throw badRequest(`${name}: leidžiama ${values.join(', ')}`);
  return value;
}

function rejectUnknown(input, allowed, what) {
  const unknown = Object.keys(input).filter((k) => !allowed.includes(k));
  if (unknown.length) throw badRequest(`${what}: nežinomi atributai: ${unknown.join(', ')}`);
}

function parsePayment(p, i) {
  rejectUnknown(p, ['amount', 'method', 'payment_type', 'paid_at'], `payments[${i}]`);
  const paidAt = p.paid_at ?? null;
  if (paidAt !== null && Number.isNaN(Date.parse(paidAt))) throw badRequest(`payments[${i}].paid_at: neteisinga data`);
  return {
    amount: numberField(`payments[${i}].amount`, p.amount, { positive: true }),
    method: enumField(`payments[${i}].method`, p.method ?? 'card', PAYMENT_METHOD),
    payment_type: enumField(`payments[${i}].payment_type`, p.payment_type, PAYMENT_TYPE),
    paid_at: paidAt,
  };
}

function parseFlight(f, i) {
  rejectUnknown(f, ['started_at', 'duration_min', 'max_altitude_m', 'distance_km', 'battery_used_pct', 'incident_reported'],
    `flights[${i}]`);
  const startedAt = new Date(f.started_at);
  if (!f.started_at || Number.isNaN(startedAt.getTime())) throw badRequest(`flights[${i}].started_at: neteisinga data`);
  return {
    started_at: startedAt,
    duration_min: numberField(`flights[${i}].duration_min`, f.duration_min, { integer: true, positive: true }),
    max_altitude_m: numberField(`flights[${i}].max_altitude_m`, f.max_altitude_m, { integer: true, max: 120 }),
    distance_km: numberField(`flights[${i}].distance_km`, f.distance_km),
    battery_used_pct: numberField(`flights[${i}].battery_used_pct`, f.battery_used_pct, { integer: true, min: 1, max: 100 }),
    incident_reported: f.incident_reported === true || f.incident_reported === 'true',
  };
}

// A rental id does not say where the row is, so the M1 fragments are searched.
async function locateRental(g, rentalId) {
  assertUuid(rentalId, 'rental_id');
  for (const frag of KEYS) {
    const { rows } = await g.read(frag, 'SELECT * FROM rental WHERE rental_id = $1', [rentalId]);
    if (rows[0]) {
      g.log('globalu', `nuoma rasta ${FRAGMENTS[frag].m1Name} → jos skrydžiai ${FRAGMENTS[frag].m2Name}`);
      return { frag, rental: rows[0] };
    }
  }
  throw notFound(`Nuoma ${rentalId} nerasta nei viename M1 fragmente`);
}

// ---------------------------------------------------------------- 1. SELECT

// Rental report: M1 rental + customer + drone model, M2 flight counts.
// The optional text filter searches the rented drone's maintenance descriptions.
async function list(filter = {}) {
  const country = filter.country || null;
  if (filter.status) enumField('status', filter.status, RENTAL_STATUS);
  if (filter.maintenance_search !== undefined && typeof filter.maintenance_search !== 'string') {
    throw badRequest('Apžiūrų paieška turi būti tekstas');
  }
  const search = (filter.maintenance_search || '').trim();
  const onlyIncidents = filter.incident === 'true' || filter.incident === true;

  return runGlobal(async (g) => {
    const frags = fragmentsFor(country);
    g.log('globalu', country
      ? `šalis ${country} → užklausa tik fragmentui ${frags[0]}`
      : 'šalis nenurodyta → užklausa visiems fragmentams');

    const rentals = [];
    for (const frag of frags) {
      const where = [];
      const params = [];
      if (country) { params.push(country); where.push(`b.country_code = $${params.length}`); }
      if (filter.status) { params.push(filter.status); where.push(`r.status = $${params.length}`); }
      const { rows } = await g.read(frag, `
        SELECT r.rental_id, r.drone_id, r.start_date, r.end_date,
               r.total_price, r.status,
               c.first_name || ' ' || c.last_name AS customer,
               b.name AS branch_name, b.country_code,
               m.manufacturer || ' ' || m.model_name AS model
        FROM rental r
        JOIN customer c USING (customer_id)
        JOIN branch b ON b.branch_id = r.branch_id
        JOIN drone_commercial d USING (drone_id)
        JOIN drone_model m USING (model_id)
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY r.start_date DESC, c.last_name`, params);
      if (!rows.length) continue;

      let selectedRows = rows;
      if (search) {
        const ids = [...new Set(rows.map((r) => r.drone_id))];
        const docs = await g.m2read(frag,
          `drone_technical.find({$text: {$search: ${JSON.stringify(search)}}, _id: {$in: [${ids.length} id]}})`,
          (db) => db.collection('drone_technical').find({
            $text: { $search: search },
            _id: { $in: ids },
          }, { projection: { _id: 1 } }).toArray());
        const matched = new Set(docs.map((d) => d._id));
        selectedRows = rows.filter((r) => matched.has(r.drone_id));
        if (!selectedRows.length) continue;
      }

      const flightRows = await g.m2read(frag,
        `flight_log.find({rental_id: {$in: [${selectedRows.length} id]}})`,
        (db) => db.collection('flight_log').find(
          { rental_id: { $in: selectedRows.map((r) => r.rental_id) } },
          { projection: { rental_id: 1, incident_reported: 1 } },
        ).toArray());
      const flights = new Map();
      for (const flight of flightRows) {
        const totals = flights.get(flight.rental_id) ?? { flights: 0, incidents: 0 };
        totals.flights += 1;
        if (flight.incident_reported) totals.incidents += 1;
        flights.set(flight.rental_id, totals);
      }

      for (const r of selectedRows) {
        const f = flights.get(r.rental_id) ?? { flights: 0, incidents: 0 };
        if (onlyIncidents && !f.incidents) continue;
        rentals.push({
          ...r,
          fragment: frag,
          flight_count: f.flights,
        });
      }
    }
    g.log('globalu', `sujungta pagal rental_id ir drone_id → ${rentals.length} nuomų`);
    return rentals;
  }, { readOnly: true });
}

async function ensureSearchIndexes() {
  for (const frag of KEYS) {
    const db = FRAGMENTS[frag].m2;
    if (!(await db.listCollections({ name: 'drone_technical' }, { nameOnly: true }).hasNext())) {
      console.warn(`${FRAGMENTS[frag].m2Name}.drone_technical nerasta: tekstinės paieškos indeksas nesukurtas`);
      continue;
    }
    await db.collection('drone_technical').createIndex(
      { 'maintenance.description': 'text' }, { default_language: 'none' });
  }
}

// ---------------------------------------------------------------- 2. INSERT

// New rental: rental + payments into the branch's m1_X, flight_log documents with the same
// rental_id into M2_X. Input: customer_id, drone_id, branch_id, start_date, end_date,
// status (default active), total_price (default daily_rate x days), payments[], flights[].
// An active rental takes its drone (available -> rented).
async function insert(input = {}) {
  rejectUnknown(input, ['customer_id', 'drone_id', 'branch_id', 'start_date', 'end_date', 'status',
    'total_price', 'payments', 'flights'], 'Nuoma');
  const customerId = numberField('customer_id', input.customer_id, { integer: true, positive: true });
  assertUuid(input.drone_id, 'drone_id');
  assertUuid(input.branch_id, 'branch_id');
  const startDate = dateField('start_date', input.start_date);
  const endDate = dateField('end_date', input.end_date);
  if (endDate < startDate) throw badRequest('end_date negali būti ankstesnė už start_date');
  const status = enumField('status', input.status ?? 'active', RENTAL_STATUS);
  const totalPrice = input.total_price === undefined ? null : numberField('total_price', input.total_price);
  const payments = (input.payments ?? []).map(parsePayment);
  const flights = (input.flights ?? []).map(parseFlight);
  if (flights.length && !['active', 'completed'].includes(status)) {
    throw badRequest('Skrydžių gali turėti tik aktyvi arba užbaigta nuoma');
  }

  return runGlobal(async (g) => {
    const { frag } = await locateBranch(g, input.branch_id);

    const { rows: [customer] } = await g.read(frag, 'SELECT customer_id FROM customer WHERE customer_id = $1', [customerId]);
    if (!customer) {
      throw conflict(`Klientas ${customerId} nerastas ${FRAGMENTS[frag].m1Name}: klientas ir filialas turi būti tame pačiame fragmente`);
    }

    // Lock the drone: concurrent rentals of the same drone wait here.
    const { rows: [drone] } = await g.write(frag,
      'SELECT status, daily_rate FROM drone_commercial WHERE drone_id = $1 FOR UPDATE', [input.drone_id]);
    if (!drone) {
      throw conflict(`Dronas ${input.drone_id} nerastas ${FRAGMENTS[frag].m1Name}: dronas ir filialas turi būti tame pačiame fragmente`);
    }
    if (status === 'active' && drone.status !== 'available') {
      throw conflict(`Dronas negali būti išnuomotas: jo statusas „${drone.status}“`);
    }

    if (flights.length) {
      const tech = await g.m2read(frag, `drone_technical.findOne({_id: "${input.drone_id}"})`, (db) =>
        db.collection('drone_technical').findOne({ _id: input.drone_id }, { projection: { _id: 1 } }));
      if (!tech) throw notFound(`Drono ${input.drone_id} techninė dalis nerasta ${FRAGMENTS[frag].m2Name}`);
    }

    const days = Math.round((Date.parse(endDate) - Date.parse(startDate)) / DAY_MS) + 1;
    const price = totalPrice ?? Math.round(drone.daily_rate * days * 100) / 100;

    const rentalId = newUuid();
    g.log('globalu', `naujas globalus identifikatorius rental_id = ${rentalId}`);

    await g.write(frag, `
      INSERT INTO rental (rental_id, customer_id, drone_id, branch_id, start_date, end_date, total_price, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [rentalId, customerId, input.drone_id, input.branch_id, startDate, endDate, price, status]);

    let paymentId = payments.length ? await nextM1Id(g, 'payment', 'payment_id') : 0;
    for (const p of payments) {
      await g.write(frag, `
        INSERT INTO payment (payment_id, rental_id, amount, method, payment_type, paid_at)
        VALUES ($1, $2, $3, $4, $5, coalesce($6::timestamp, now()))`,
      [paymentId++, rentalId, p.amount, p.method, p.payment_type, p.paid_at]);
    }

    if (status === 'active') {
      await g.write(frag, "UPDATE drone_commercial SET status = 'rented' WHERE drone_id = $1", [input.drone_id]);
    }

    let flightId = flights.length ? await nextM2Id(g, 'flight_log', '_id') : 0;
    const docs = flights.map((f) => ({
      _id: flightId++, drone_id: input.drone_id, rental_id: rentalId, ...f,
    }));
    if (docs.length) {
      await g.m2write(frag, `flight_log.insertMany(${docs.length} dok., rental_id = "${rentalId}")`,
        (db) => db.collection('flight_log').insertMany(docs),
        (db) => db.collection('flight_log').deleteMany({ rental_id: rentalId }));
    }

    return {
      rental_id: rentalId, fragment: frag, total_price: price, status,
      payments: payments.length, flights: docs.length,
    };
  });
}

// ---------------------------------------------------------------- 3. UPDATE

// Finishes a rental. Input (all optional): payment_method (default card), rental_fee
// (default total_price), damage_fee (> 0 adds a damage_fee payment), condition (default: one
// step worse if the rental had an incident).
// M1: rental.status = completed, payments, drone_commercial.status = available.
// M2: drone_technical.total_flight_hours += flight time of the rental, battery_cycles += its
// flights, condition after an incident.
async function update(rentalId, input = {}) {
  rejectUnknown(input, ['payment_method', 'rental_fee', 'damage_fee', 'condition'], 'Nuoma');
  const method = enumField('payment_method', input.payment_method ?? 'card', PAYMENT_METHOD);
  const fee = input.rental_fee === undefined ? null : numberField('rental_fee', input.rental_fee, { positive: true });
  const damage = input.damage_fee === undefined ? null : numberField('damage_fee', input.damage_fee, { positive: true });
  const condition = input.condition === undefined ? null : enumField('condition', input.condition, CONDITION);

  return runGlobal(async (g) => {
    const { frag } = await locateRental(g, rentalId);

    // Lock the rental and re-read its status: two finishes must not both add flight hours.
    const { rows: [locked] } = await g.write(frag,
      'SELECT status, total_price, drone_id FROM rental WHERE rental_id = $1 FOR UPDATE', [rentalId]);
    if (!['reserved', 'active'].includes(locked.status)) {
      throw conflict(`Nuoma jau ${locked.status === 'completed' ? 'užbaigta' : 'atšaukta'}, užbaigti negalima`);
    }

    const flights = await g.m2read(frag, `flight_log.find({rental_id: "${rentalId}"})`, (db) =>
      db.collection('flight_log').find({ rental_id: rentalId }).toArray());
    const minutes = flights.reduce((s, f) => s + f.duration_min, 0);
    const incident = flights.some((f) => f.incident_reported);

    const tech = await g.m2read(frag, `drone_technical.findOne({_id: "${locked.drone_id}"})`, (db) =>
      db.collection('drone_technical').findOne({ _id: locked.drone_id }));
    if (!tech) throw notFound(`Drono ${locked.drone_id} techninė dalis nerasta ${FRAGMENTS[frag].m2Name}`);

    await g.write(frag, "UPDATE rental SET status = 'completed' WHERE rental_id = $1", [rentalId]);

    const toPay = [{ amount: fee ?? locked.total_price, type: 'rental_fee' }];
    if (damage !== null) toPay.push({ amount: damage, type: 'damage_fee' });
    let paymentId = await nextM1Id(g, 'payment', 'payment_id');
    for (const p of toPay) {
      await g.write(frag, `
        INSERT INTO payment (payment_id, rental_id, amount, method, payment_type, paid_at)
        VALUES ($1, $2, $3, $4, $5, now())`,
      [paymentId++, rentalId, p.amount, method, p.type]);
    }

    await g.write(frag, "UPDATE drone_commercial SET status = 'available' WHERE drone_id = $1 AND status = 'rented'",
      [locked.drone_id]);

    const newCondition = condition
      ?? (incident ? CONDITION[Math.min(CONDITION.indexOf(tech.condition) + 1, CONDITION.length - 1)] : null);
    const hours = Math.round((minutes / 60) * 100) / 100;
    const set = {
      total_flight_hours: Math.round((tech.total_flight_hours + hours) * 100) / 100,
      battery_cycles: tech.battery_cycles + flights.length,
    };
    if (newCondition) set.condition = newCondition;
    const old = { total_flight_hours: tech.total_flight_hours, battery_cycles: tech.battery_cycles, condition: tech.condition };
    await g.m2write(frag, `drone_technical.updateOne({_id: "${locked.drone_id}"}, {$set: {${Object.keys(set).join(', ')}}})`,
      (db) => db.collection('drone_technical').updateOne({ _id: locked.drone_id }, { $set: set }),
      (db) => db.collection('drone_technical').updateOne({ _id: locked.drone_id }, { $set: old }));

    return {
      rental_id: rentalId,
      fragment: frag,
      status: 'completed',
      payments: toPay.length,
      flights: flights.length,
      flight_hours_added: hours,
      condition: newCondition ?? tech.condition,
    };
  });
}

// ---------------------------------------------------------------- 4. DELETE

// Deletes the rental with everything that depends on it, children first:
// payment -> rental (M1), flight_log with that rental_id (M2). An active rental
// gives its drone back (rented -> available). Afterwards GET /api/check shows no orphans.
async function remove(rentalId) {
  return runGlobal(async (g) => {
    const { frag } = await locateRental(g, rentalId);

    const { rows: [locked] } = await g.write(frag,
      'SELECT status, drone_id FROM rental WHERE rental_id = $1 FOR UPDATE', [rentalId]);
    const payments = await g.write(frag, 'DELETE FROM payment WHERE rental_id = $1', [rentalId]);
    await g.write(frag, 'DELETE FROM rental WHERE rental_id = $1', [rentalId]);
    if (locked.status === 'active') {
      await g.write(frag, "UPDATE drone_commercial SET status = 'available' WHERE drone_id = $1 AND status = 'rented'",
        [locked.drone_id]);
    }

    const flights = await g.m2read(frag, `flight_log.find({rental_id: "${rentalId}"})`, (db) =>
      db.collection('flight_log').find({ rental_id: rentalId }).toArray());
    if (flights.length) {
      await g.m2write(frag, `flight_log.deleteMany({rental_id: "${rentalId}"})`,
        (db) => db.collection('flight_log').deleteMany({ rental_id: rentalId }),
        (db) => db.collection('flight_log').insertMany(flights));
    }

    return {
      rental_id: rentalId,
      fragment: frag,
      deleted: { payment: payments.rowCount, rental: 1, flight_log: flights.length },
    };
  });
}

module.exports = { list, insert, update, remove, ensureSearchIndexes };
