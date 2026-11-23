// Orphan check over all four fragments.
// Inside one PostgreSQL database the foreign keys already guarantee integrity; this checks
// the references that no DBMS enforces: between M1 and M2, inside MongoDB, and between
// the horizontal fragments.
const { runGlobal } = require('./global-op');
const { FRAGMENTS, KEYS } = require('./db');

const missing = (values, existing) => {
  const set = new Set(existing);
  return [...new Set(values)].filter((v) => v !== null && v !== undefined && !set.has(v));
};

async function checkOrphans() {
  return runGlobal(async (g) => {
    const checks = [];
    const add = (name, bad) => checks.push({ name, ok: bad.length === 0, count: bad.length, sample: bad.slice(0, 5) });

    const dronesByFrag = {};
    const employeesByFrag = {};
    const branchIds = [];

    for (const frag of KEYS) {
      const { m1Name, m2Name } = FRAGMENTS[frag];
      const drones = (await g.read(frag, 'SELECT drone_id FROM drone_commercial')).rows.map((r) => r.drone_id);
      const rentals = (await g.read(frag, 'SELECT rental_id FROM rental')).rows.map((r) => r.rental_id);
      branchIds.push(...(await g.read(frag, 'SELECT branch_id FROM branch')).rows.map((r) => r.branch_id));

      const tech = await g.m2read(frag, 'drone_technical.distinct("_id")', (db) =>
        db.collection('drone_technical').distinct('_id'));
      const flights = await g.m2read(frag, 'flight_log.find({}, {drone_id, rental_id})', (db) =>
        db.collection('flight_log').find({}, { projection: { drone_id: 1, rental_id: 1 } }).toArray());
      const employees = await g.m2read(frag, 'employee.find({}, {branch_id})', (db) =>
        db.collection('employee').find({}, { projection: { branch_id: 1 } }).toArray());
      const technicians = await g.m2read(frag, 'drone_technical.distinct("maintenance.employee_id")', (db) =>
        db.collection('drone_technical').distinct('maintenance.employee_id'));

      add(`${m1Name}.drone_commercial be dalies ${m2Name}.drone_technical`, missing(drones, tech));
      add(`${m2Name}.drone_technical be dalies ${m1Name}.drone_commercial`, missing(tech, drones));
      add(`${m2Name}.flight_log → drone_id nėra ${m2Name}.drone_technical`,
        flights.filter((f) => !tech.includes(f.drone_id)).map((f) => f._id));
      add(`${m2Name}.flight_log → rental_id nėra ${m1Name}.rental`,
        flights.filter((f) => f.rental_id && !rentals.includes(f.rental_id)).map((f) => f._id));
      add(`${m2Name} maintenance → employee_id nėra ${m2Name}.employee`,
        missing(technicians, employees.map((e) => e._id)));

      dronesByFrag[frag] = drones;
      employeesByFrag[frag] = employees;
    }

    const [a, b] = KEYS;
    add('tas pats dronas abiejuose horizontaliuosiuose fragmentuose',
      dronesByFrag[a].filter((id) => dronesByFrag[b].includes(id)));
    // employee is replicated to both M2 fragments, branch is split between the M1 fragments
    const empA = employeesByFrag[a].map((e) => e._id);
    const empB = employeesByFrag[b].map((e) => e._id);
    add(`employee kopijos ${FRAGMENTS[a].m2Name} ir ${FRAGMENTS[b].m2Name} nesutampa`,
      [...missing(empA, empB), ...missing(empB, empA)]);
    add('employee.branch_id nėra nei viename M1 fragmente',
      missing(employeesByFrag[a].map((e) => e.branch_id), branchIds));

    return checks;
  }, { readOnly: true });
}

module.exports = { checkOrphans };
