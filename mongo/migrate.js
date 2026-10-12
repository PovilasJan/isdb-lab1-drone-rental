// M2 migration: PostgreSQL (M0) -> MongoDB, two horizontal fragments of
// drone_technical (with embedded maintenance), employee, flight_log.
// Derived horizontal fragmentation: the id sets come from the M1 fragments
//   M2_lt   : drones of m1_lt.drone_commercial,   employees of m1_lt.branch
//   M2_lvee : drones of m1_lvee.drone_commercial, employees of m1_lvee.branch
// M2 has no country attribute. maintenance is embedded in its drone's
// document, flight_log follows its drone.
// Re-runnable: every target collection is dropped and rebuilt.

const { Client, types } = require('pg');
const { MongoClient } = require('mongodb');

const PG = {
  host: process.env.PG_HOST ?? 'localhost',
  port: Number(process.env.PG_PORT ?? 5433),
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE ?? 'isdb_original',
};
const MONGO_URI =
  process.env.MONGO_URI ??
  `mongodb://${process.env.MONGO_USER}:${process.env.MONGO_PASSWORD}@localhost:27017/?authSource=admin`;
const FRAGMENTS = [
  { db: 'M2_lt', m1: 'm1_lt' },
  { db: 'M2_lvee', m1: 'm1_lvee' },
];

// PostgreSQL -> BSON (uuid/char/varchar/text -> string, integers -> number, boolean -> boolean)
types.setTypeParser(1082, (s) => new Date(`${s}T00:00:00Z`));          // date      -> Date (UTC midnight)
types.setTypeParser(1114, (s) => new Date(`${s.replace(' ', 'T')}Z`)); // timestamp -> Date (read as UTC)
types.setTypeParser(1700, (s) => parseFloat(s));                       // numeric   -> double

// Schema validators (replace the CHECK / NOT NULL constraints)
const UUID_RE = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const TYPES = {
  string: { bsonType: 'string' },
  uuid: { bsonType: 'string', pattern: UUID_RE },
  int: { bsonType: ['int', 'long'] },
  number: { bsonType: 'number' }, // JS integers are stored as int32, so accept int and double
  date: { bsonType: 'date' },
  bool: { bsonType: 'bool' },
  array: { bsonType: 'array' },
};

// fields: { name: 'type' | 'type?' }  ('?' = nullable). rules: extra JSON-schema keywords per field.
function jsonSchema(fields, rules = {}) {
  const properties = {};
  for (const [name, spec] of Object.entries(fields)) {
    const base = TYPES[spec.replace('?', '')];
    properties[name] = { ...base, ...rules[name] };
    if (spec.endsWith('?')) properties[name].bsonType = [].concat(base.bsonType, 'null');
  }
  return {
    $jsonSchema: {
      bsonType: 'object',
      required: Object.keys(fields),
      properties,
      additionalProperties: false,
    },
  };
}

// One maintenance record as it is embedded in a drone document
// (drone_id is implied by the parent, maintenance_id is kept as a plain field).
const maintenanceItem = {
  maintenance_id: 'int', employee_id: 'uuid', maintenance_date: 'date',
  maintenance_type: 'string', description: 'string', cost: 'number', downtime_hours: 'number',
};

// `fields` defines the SELECT column list (vertical projection), the validator and the document shape.
// `split` = the column whose value must be in the fragment's id set (drone_id or branch_id).
// `embed` = child table stored as an array field inside each document of this collection.
const collections = [
  {
    name: 'drone_technical', table: 'drone', pk: 'drone_id', split: 'drone_id',
    fields: {
      _id: 'uuid', serial_number: 'string', firmware_version: 'string',
      total_flight_hours: 'number', battery_cycles: 'int', last_inspection_date: 'date?',
      condition: 'string', maintenance: 'array',
    },
    rules: {
      condition: { enum: ['excellent', 'good', 'fair', 'poor'] },
      maintenance: { items: jsonSchema(maintenanceItem).$jsonSchema },
    },
    embed: { field: 'maintenance', table: 'maintenance', pk: 'maintenance_id', fields: maintenanceItem },
    indexes: [{ key: { serial_number: 1 }, unique: true }, { key: { 'maintenance.employee_id': 1 } }],
  },
  {
    name: 'employee', pk: 'employee_id', split: 'branch_id',
    fields: {
      _id: 'uuid', branch_id: 'uuid', first_name: 'string', last_name: 'string',
      email: 'string', role: 'string', certification: 'string?', hired_on: 'date',
    },
    rules: { role: { enum: ['technician', 'pilot_instructor', 'branch_manager', 'safety_inspector'] } },
    indexes: [{ key: { email: 1 }, unique: true }, { key: { branch_id: 1 } }],
  },
  {
    name: 'flight_log', pk: 'flight_id', split: 'drone_id',
    fields: {
      _id: 'int', drone_id: 'uuid', rental_id: 'uuid?', started_at: 'date',
      duration_min: 'int', max_altitude_m: 'int', distance_km: 'number',
      battery_used_pct: 'int', incident_reported: 'bool',
    },
    rules: {
      max_altitude_m: { maximum: 120 },
      battery_used_pct: { minimum: 1, maximum: 100 },
    },
    indexes: [{ key: { drone_id: 1 } }, { key: { rental_id: 1 } }],
  },
];

// Mongo has no foreign keys: [child, field, parent] references inside a fragment are checked after loading.
const references = [
  ['drone_technical', 'maintenance.employee_id', 'employee'],
  ['flight_log', 'drone_id', 'drone_technical'],
];

const columns = (fields, skip) =>
  Object.keys(fields).filter((f) => f !== '_id' && f !== skip).map((f) => `"${f}"`).join(', ');

// id sets of one M1 fragment: which drones and branches belong to it
async function m1Ids(database) {
  const m1 = new Client({ ...PG, database });
  await m1.connect();
  try {
    const drones = (await m1.query('SELECT drone_id FROM drone_commercial')).rows.map((r) => r.drone_id);
    const branches = (await m1.query('SELECT branch_id FROM branch')).rows.map((r) => r.branch_id);
    return { drone_id: drones, branch_id: branches };
  } finally {
    await m1.end();
  }
}

async function main() {
  const pg = new Client(PG);
  const mongo = new MongoClient(MONGO_URI);
  await pg.connect();
  await mongo.connect();

  try {
    for (const { db: dbName, m1 } of FRAGMENTS) {
      const db = mongo.db(dbName);
      const ids = await m1Ids(m1);

      for (const c of collections) {
        const { rows } = await pg.query(
          `SELECT "${c.pk}" AS _id, ${columns(c.fields, c.embed?.field)} FROM "${c.table ?? c.name}" WHERE "${c.split}" = ANY($1::uuid[])`,
          [ids[c.split]],
        );

        if (c.embed) {
          const e = c.embed;
          const { rows: items } = await pg.query(
            `SELECT "drone_id", ${columns(e.fields)} FROM "${e.table}" WHERE "drone_id" = ANY($1::uuid[]) ORDER BY "${e.pk}"`,
            [ids.drone_id],
          );
          const byDrone = new Map();
          for (const { drone_id, ...item } of items) {
            if (!byDrone.has(drone_id)) byDrone.set(drone_id, []);
            byDrone.get(drone_id).push(item);
          }
          for (const row of rows) row[e.field] = byDrone.get(row._id) ?? [];
        }

        await db.collection(c.name).drop().catch((e) => { if (e.codeName !== 'NamespaceNotFound') throw e; });
        const coll = await db.createCollection(c.name, {
          validator: jsonSchema(c.fields, c.rules),
          validationLevel: 'strict',
          validationAction: 'error',
        });
        if (rows.length) await coll.insertMany(rows);
        for (const ix of c.indexes ?? []) await coll.createIndex(ix.key, { unique: Boolean(ix.unique) });
      }

      for (const [child, field, parent] of references) {
        const values = (await db.collection(child).distinct(field)).filter((v) => v !== null);
        const found = await db.collection(parent).countDocuments({ _id: { $in: values } });
        if (found !== values.length) throw new Error(`${dbName}: ${child}.${field} has values missing in ${parent}`);
      }
      console.log(`${dbName} <- ids of ${m1}: ${ids.drone_id.length} drones, ${ids.branch_id.length} branches`);
    }
    await verify(pg, mongo);
  } finally {
    await pg.end();
    await mongo.close();
  }
}

// Correctness: M2_lt + M2_lvee = M0 (no row lost, no row in both fragments)
async function verify(pg, mongo) {
  const checks = [
    ['drone_technical', 'SELECT drone_id::text AS id FROM drone', (d) => d.collection('drone_technical').find({}, { projection: { _id: 1 } })],
    ['maintenance', 'SELECT maintenance_id AS id FROM maintenance',
      (d) => d.collection('drone_technical').aggregate([{ $unwind: '$maintenance' }, { $project: { _id: '$maintenance.maintenance_id' } }])],
    ['employee', 'SELECT employee_id::text AS id FROM employee', (d) => d.collection('employee').find({}, { projection: { _id: 1 } })],
    ['flight_log', 'SELECT flight_id AS id FROM flight_log', (d) => d.collection('flight_log').find({}, { projection: { _id: 1 } })],
  ];
  for (const [name, sql, cursor] of checks) {
    const m0 = new Set((await pg.query(sql)).rows.map((r) => String(r.id)));
    const frag = [];
    for (const { db } of FRAGMENTS) frag.push(...(await cursor(mongo.db(db)).toArray()).map((x) => String(x._id)));
    const unique = new Set(frag);
    const ok = frag.length === m0.size && unique.size === m0.size && [...m0].every((id) => unique.has(id));
    if (!ok) throw new Error(`FAILED ${name}: M0=${m0.size} fragments=${frag.length}`);
    console.log(`OK  ${name.padEnd(16)} ${m0.size} = M2_lt + M2_lvee, disjoint`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});