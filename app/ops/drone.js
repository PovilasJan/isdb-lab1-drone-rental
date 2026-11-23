// Global object "Drone" (Povilas).
//
// The M0 table drone (14 attributes) is split vertically:
//   M1 drone_commercial : model_id, branch_id, purchase_date, purchase_price, daily_rate,
//                         deposit_amount, status                       (m1_lt / m1_lvee)
//   M2 drone_technical  : serial_number, firmware_version, total_flight_hours, battery_cycles,
//                         last_inspection_date, condition + embedded maintenance[]
//                                                                      (M2_lt / M2_lvee)
// Both parts have the same key: drone_id (UUID) in M1, _id in M2.
// Horizontal fragment = the drone's branch country (lib/fragments.js).
// Rows that depend on a drone: rental + payment (M1), flight_log (M2).
const { runGlobal } = require('../lib/global-op');
const { FRAGMENTS } = require('../lib/db');
const { fragmentsFor, assertUuid, newUuid, locateBranch, locateDrone } = require('../lib/fragments');
const { badRequest, conflict, notFound } = require('../lib/errors');

const STATUS = ['available', 'rented', 'maintenance', 'retired'];
const CONDITION = ['excellent', 'good', 'fair', 'poor'];

// Every global attribute: which vertical fragment it lives in, its type, default on insert.
const ATTRS = {
  model_id: { part: 'm1', type: 'int' },
  branch_id: { part: 'm1', type: 'uuid' },
  purchase_date: { part: 'm1', type: 'date' },
  purchase_price: { part: 'm1', type: 'number' },
  daily_rate: { part: 'm1', type: 'number' },
  deposit_amount: { part: 'm1', type: 'number' },
  status: { part: 'm1', type: 'enum', values: STATUS, default: 'available' },
  serial_number: { part: 'm2', type: 'string' },
  firmware_version: { part: 'm2', type: 'string' },
  total_flight_hours: { part: 'm2', type: 'number', default: 0 },
  battery_cycles: { part: 'm2', type: 'int', default: 0 },
  last_inspection_date: { part: 'm2', type: 'date', nullable: true, default: null },
  condition: { part: 'm2', type: 'enum', values: CONDITION },
};
const M1_ATTRS = Object.keys(ATTRS).filter((a) => ATTRS[a].part === 'm1');
const M2_ATTRS = Object.keys(ATTRS).filter((a) => ATTRS[a].part === 'm2');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const toMongoDate = (s) => (s === null ? null : new Date(`${s}T00:00:00Z`));
const fromMongoDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ?? null);

function convert(name, spec, raw) {
  const value = typeof raw === 'string' ? raw.trim() : raw;
  if (value === null || value === '') {
    if (spec.nullable) return null;
    throw badRequest(`${name}: privalomas`);
  }
  switch (spec.type) {
    case 'int':
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw badRequest(`${name}: turi būti neneigiamas skaičius`);
      if (spec.type === 'int' && !Number.isInteger(n)) throw badRequest(`${name}: turi būti sveikasis skaičius`);
      return n;
    }
    case 'date':
      if (!DATE_RE.test(value)) throw badRequest(`${name}: data turi būti YYYY-MM-DD`);
      return value;
    case 'uuid':
      assertUuid(value, name);
      return value;
    case 'enum':
      if (!spec.values.includes(value)) throw badRequest(`${name}: leidžiama ${spec.values.join(', ')}`);
      return value;
    default:
      return String(value);
  }
}

// Splits a global drone (form input) into its M1 and M2 parts.
// partial = update: only the attributes that were sent.
function splitDrone(input, { partial }) {
  const m1 = {};
  const m2 = {};
  for (const [name, spec] of Object.entries(ATTRS)) {
    let raw = input[name];
    if (raw === undefined) {
      if (partial) continue;
      if (!('default' in spec)) throw badRequest(`${name}: privalomas`);
      raw = spec.default;
    }
    const value = raw === null && spec.nullable ? null : convert(name, spec, raw);
    if (spec.part === 'm1') m1[name] = value;
    else m2[name] = spec.type === 'date' ? toMongoDate(value) : value;
  }
  const unknown = Object.keys(input).filter((k) => !(k in ATTRS));
  if (unknown.length) throw badRequest(`Nežinomi atributai: ${unknown.join(', ')}`);
  return { m1, m2 };
}

// M1 row + M2 document -> one global drone.
function joinDrone(frag, c, t) {
  return {
    drone_id: c.drone_id,
    fragment: frag,
    country_code: c.country_code,
    branch_id: c.branch_id,
    branch_name: c.branch_name,
    model_id: c.model_id,
    model: `${c.manufacturer} ${c.model_name}`,
    purchase_date: c.purchase_date,
    purchase_price: c.purchase_price,
    daily_rate: c.daily_rate,
    deposit_amount: c.deposit_amount,
    status: c.status,
    serial_number: t.serial_number,
    firmware_version: t.firmware_version,
    total_flight_hours: t.total_flight_hours,
    battery_cycles: t.battery_cycles,
    last_inspection_date: fromMongoDate(t.last_inspection_date),
    condition: t.condition,
    maintenance_count: t.maintenance.length,
  };
}

const M1_SELECT = `
  SELECT d.*, m.manufacturer, m.model_name, b.name AS branch_name, b.country_code
  FROM drone_commercial d
  JOIN drone_model m USING (model_id)
  JOIN branch b USING (branch_id)`;

// serial_number is unique inside one M2 fragment (index), but global uniqueness needs
// a look into the other fragment too.
async function assertSerialFree(g, serial, exceptDroneId = null) {
  for (const frag of Object.keys(FRAGMENTS)) {
    const doc = await g.m2read(frag, `drone_technical.findOne({serial_number: "${serial}"})`, (db) =>
      db.collection('drone_technical').findOne({ serial_number: serial, _id: { $ne: exceptDroneId } }));
    if (doc) throw conflict(`Serijos numeris ${serial} jau naudojamas (${FRAGMENTS[frag].m2Name})`);
  }
}

// ---------------------------------------------------------------- 1. SELECT

// Drone list: M1 commercial part + M2 technical part joined by drone_id.
// Filters: country (M1, also picks the fragments), status (M1), condition (M2).
async function list(filter = {}) {
  const country = filter.country || null;
  if (filter.status && !STATUS.includes(filter.status)) throw badRequest('Neteisingas statusas');
  if (filter.condition && !CONDITION.includes(filter.condition)) throw badRequest('Neteisinga būklė');

  return runGlobal(async (g) => {
    const frags = fragmentsFor(country);
    g.log('globalu', country
      ? `šalis ${country} → užklausa tik fragmentui ${frags[0]}`
      : 'šalis nenurodyta → užklausa visiems fragmentams');

    const drones = [];
    for (const frag of frags) {
      const where = [];
      const params = [];
      if (country) { params.push(country); where.push(`b.country_code = $${params.length}`); }
      if (filter.status) { params.push(filter.status); where.push(`d.status = $${params.length}`); }
      const { rows } = await g.read(frag, `${M1_SELECT}
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY b.name, m.model_name`, params);
      if (!rows.length) continue;

      const query = { _id: { $in: rows.map((r) => r.drone_id) } };
      if (filter.condition) query.condition = filter.condition;
      const docs = await g.m2read(frag,
        `drone_technical.find({_id: {$in: [${rows.length} id]}${filter.condition ? `, condition: "${filter.condition}"` : ''}})`,
        (db) => db.collection('drone_technical').find(query).toArray());

      const tech = new Map(docs.map((d) => [d._id, d]));
      for (const row of rows) {
        if (tech.has(row.drone_id)) drones.push(joinDrone(frag, row, tech.get(row.drone_id)));
      }
    }
    g.log('globalu', `sujungta pagal drone_id → ${drones.length} dronų`);
    return drones;
  }, { readOnly: true });
}

// One drone with everything about it: both vertical parts, maintenance history with the
// technician's name (M2), rentals and income (M1), flight totals (M2).
async function get(droneId) {
  return runGlobal(async (g) => {
    const frag = await locateDrone(g, droneId);

    const { rows: [c] } = await g.read(frag, `${M1_SELECT} WHERE d.drone_id = $1`, [droneId]);
    const t = await g.m2read(frag, `drone_technical.findOne({_id: "${droneId}"})`, (db) =>
      db.collection('drone_technical').findOne({ _id: droneId }));
    if (!t) throw notFound(`Drono ${droneId} techninė dalis nerasta ${FRAGMENTS[frag].m2Name}`);

    const employeeIds = [...new Set(t.maintenance.map((m) => m.employee_id))];
    const employees = await g.m2read(frag, `employee.find({_id: {$in: [${employeeIds.length} id]}})`, (db) =>
      db.collection('employee').find({ _id: { $in: employeeIds } }).toArray());
    const names = new Map(employees.map((e) => [e._id, `${e.first_name} ${e.last_name}`]));

    const { rows: [rentals] } = await g.read(frag, `
      SELECT count(DISTINCT r.rental_id)::int AS count,
             coalesce(sum(p.amount) FILTER (WHERE p.payment_type IN ('rental_fee', 'damage_fee')), 0) AS income,
             max(r.start_date) AS last_start
      FROM rental r LEFT JOIN payment p USING (rental_id)
      WHERE r.drone_id = $1`, [droneId]);

    const [flights] = await g.m2read(frag, `flight_log.aggregate([{$match: {drone_id}}, {$group}])`, (db) =>
      db.collection('flight_log').aggregate([
        { $match: { drone_id: droneId } },
        { $group: {
          _id: null,
          count: { $sum: 1 },
          minutes: { $sum: '$duration_min' },
          km: { $sum: '$distance_km' },
          incidents: { $sum: { $cond: ['$incident_reported', 1, 0] } },
        } },
      ]).toArray());

    return {
      drone: joinDrone(frag, c, t),
      maintenance: t.maintenance.map((m) => ({
        ...m,
        maintenance_date: fromMongoDate(m.maintenance_date),
        employee: names.get(m.employee_id) ?? m.employee_id,
      })),
      rentals,
      flights: flights ?? { count: 0, minutes: 0, km: 0, incidents: 0 },
    };
  }, { readOnly: true });
}

// ---------------------------------------------------------------- 2. INSERT

// New drone: one UUID, M1 part into the branch's m1_X, M2 part into M2_X.
async function insert(input) {
  const { m1, m2 } = splitDrone(input, { partial: false });

  return runGlobal(async (g) => {
    const { frag } = await locateBranch(g, m1.branch_id);
    await assertSerialFree(g, m2.serial_number);

    const droneId = newUuid();
    g.log('globalu', `naujas globalus identifikatorius drone_id = ${droneId}`);

    await g.write(frag, `
      INSERT INTO drone_commercial (drone_id, ${M1_ATTRS.join(', ')})
      VALUES ($1, ${M1_ATTRS.map((_, i) => `$${i + 2}`).join(', ')})`,
    [droneId, ...M1_ATTRS.map((a) => m1[a])]);

    await g.m2write(frag, `drone_technical.insertOne({_id: "${droneId}", maintenance: []})`,
      (db) => db.collection('drone_technical').insertOne({ _id: droneId, ...m2, maintenance: [] }),
      (db) => db.collection('drone_technical').deleteOne({ _id: droneId }));

    return { drone_id: droneId, fragment: frag };
  });
}

// ---------------------------------------------------------------- 3. UPDATE

// Changes any of the 13 attributes. Each one is written where it lives (M1 or M2).
// A new branch in another country moves the drone to the other horizontal fragments:
// drone_commercial m1_X -> m1_Y (two PostgreSQL databases -> two-phase commit) and
// drone_technical + its flight logs M2_X -> M2_Y. A drone with rentals cannot move:
// the rentals belong to the old branch and stay in m1_X, where their FK needs the drone.
async function update(droneId, input) {
  const { m1, m2 } = splitDrone(input, { partial: true });
  if (!Object.keys(m1).length && !Object.keys(m2).length) throw badRequest('Nėra ką keisti');

  return runGlobal(async (g) => {
    const src = await locateDrone(g, droneId);
    const dst = m1.branch_id ? (await locateBranch(g, m1.branch_id)).frag : src;
    if (m2.serial_number) await assertSerialFree(g, m2.serial_number, droneId);

    // Lock the M1 row first: it also blocks new rentals of this drone until we finish.
    const { rows: [current] } = await g.write(src,
      'SELECT * FROM drone_commercial WHERE drone_id = $1 FOR UPDATE', [droneId]);
    const before = await g.m2read(src, `drone_technical.findOne({_id: "${droneId}"})`, (db) =>
      db.collection('drone_technical').findOne({ _id: droneId }));
    if (!before) throw notFound(`Drono ${droneId} techninė dalis nerasta ${FRAGMENTS[src].m2Name}`);

    if (src === dst) {
      g.log('globalu', 'dronas lieka tame pačiame horizontaliajame fragmente');
      const m1Keys = Object.keys(m1);
      if (m1Keys.length) {
        await g.write(src,
          `UPDATE drone_commercial SET ${m1Keys.map((a, i) => `${a} = $${i + 2}`).join(', ')} WHERE drone_id = $1`,
          [droneId, ...m1Keys.map((a) => m1[a])]);
      }
      const m2Keys = Object.keys(m2);
      if (m2Keys.length) {
        const old = Object.fromEntries(m2Keys.map((a) => [a, before[a]]));
        await g.m2write(src, `drone_technical.updateOne({_id: "${droneId}"}, {$set: {${m2Keys.join(', ')}}})`,
          (db) => db.collection('drone_technical').updateOne({ _id: droneId }, { $set: m2 }),
          (db) => db.collection('drone_technical').updateOne({ _id: droneId }, { $set: old }));
      }
      return { drone_id: droneId, fragment: src, moved: false };
    }

    g.log('globalu', `naujas filialas kitoje šalyje → dronas keliauja iš ${src} į ${dst}`);
    const { rows: [{ n }] } = await g.write(src,
      'SELECT count(*)::int AS n FROM rental WHERE drone_id = $1', [droneId]);
    if (n > 0) {
      throw conflict(`Dronas turi ${n} nuomų ${FRAGMENTS[src].m1Name}. Jos priklauso senajam filialui ir lieka ` +
        'jo fragmente, todėl dronas į kitos šalies filialą perkeltas būti negali.');
    }

    // M1: insert into the new fragment, delete from the old one (committed together by 2PC).
    const row = { ...current, ...m1 };
    await g.write(dst, `
      INSERT INTO drone_commercial (drone_id, ${M1_ATTRS.join(', ')})
      VALUES ($1, ${M1_ATTRS.map((_, i) => `$${i + 2}`).join(', ')})`,
    [droneId, ...M1_ATTRS.map((a) => row[a])]);
    await g.write(src, 'DELETE FROM drone_commercial WHERE drone_id = $1', [droneId]);

    // M2: the drone document (maintenance is embedded) and its flight logs.
    const flights = await g.m2read(src, `flight_log.find({drone_id: "${droneId}"})`, (db) =>
      db.collection('flight_log').find({ drone_id: droneId }).toArray());
    const doc = { ...before, ...m2 };

    await g.m2write(dst, `drone_technical.insertOne({_id: "${droneId}"})`,
      (db) => db.collection('drone_technical').insertOne(doc),
      (db) => db.collection('drone_technical').deleteOne({ _id: droneId }));
    if (flights.length) {
      await g.m2write(dst, `flight_log.insertMany(${flights.length} dok.)`,
        (db) => db.collection('flight_log').insertMany(flights),
        (db) => db.collection('flight_log').deleteMany({ drone_id: droneId }));
      await g.m2write(src, `flight_log.deleteMany({drone_id: "${droneId}"})`,
        (db) => db.collection('flight_log').deleteMany({ drone_id: droneId }),
        (db) => db.collection('flight_log').insertMany(flights));
    }
    await g.m2write(src, `drone_technical.deleteOne({_id: "${droneId}"})`,
      (db) => db.collection('drone_technical').deleteOne({ _id: droneId }),
      (db) => db.collection('drone_technical').insertOne(before));

    return { drone_id: droneId, from: src, to: dst, moved: true, flight_logs_moved: flights.length };
  });
}

// ---------------------------------------------------------------- 4. DELETE

// Deletes the drone from M1 and M2 with everything that depends on it, children first,
// so no orphan is left: payment -> rental -> drone_commercial (M1),
// flight_log (of the drone or of its rentals) -> drone_technical with its maintenance (M2).
async function remove(droneId) {
  return runGlobal(async (g) => {
    const frag = await locateDrone(g, droneId);

    await g.write(frag, 'SELECT 1 FROM drone_commercial WHERE drone_id = $1 FOR UPDATE', [droneId]);
    const payments = await g.write(frag, `
      DELETE FROM payment WHERE rental_id IN (SELECT rental_id FROM rental WHERE drone_id = $1)`, [droneId]);
    const rentals = await g.write(frag,
      'DELETE FROM rental WHERE drone_id = $1 RETURNING rental_id', [droneId]);
    await g.write(frag, 'DELETE FROM drone_commercial WHERE drone_id = $1', [droneId]);

    const rentalIds = rentals.rows.map((r) => r.rental_id);
    const flightQuery = { $or: [{ drone_id: droneId }, { rental_id: { $in: rentalIds } }] };
    const flights = await g.m2read(frag, `flight_log.find({$or: [{drone_id}, {rental_id ∈ ${rentalIds.length} nuomos}]})`,
      (db) => db.collection('flight_log').find(flightQuery).toArray());
    if (flights.length) {
      await g.m2write(frag, `flight_log.deleteMany(${flights.length} dok.)`,
        (db) => db.collection('flight_log').deleteMany({ _id: { $in: flights.map((f) => f._id) } }),
        (db) => db.collection('flight_log').insertMany(flights));
    }

    const doc = await g.m2read(frag, `drone_technical.findOne({_id: "${droneId}"})`, (db) =>
      db.collection('drone_technical').findOne({ _id: droneId }));
    if (doc) {
      await g.m2write(frag, `drone_technical.deleteOne({_id: "${droneId}"}) su ${doc.maintenance.length} maintenance`,
        (db) => db.collection('drone_technical').deleteOne({ _id: droneId }),
        (db) => db.collection('drone_technical').insertOne(doc));
    }

    return {
      drone_id: droneId,
      fragment: frag,
      deleted: {
        payment: payments.rowCount,
        rental: rentals.rowCount,
        drone_commercial: 1,
        flight_log: flights.length,
        drone_technical: doc ? 1 : 0,
        maintenance: doc ? doc.maintenance.length : 0,
      },
    };
  });
}

module.exports = { list, get, insert, update, remove, STATUS, CONDITION };
