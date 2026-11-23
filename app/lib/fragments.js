// Localization: which horizontal fragment holds a row, and global identifiers.
//
// Horizontal fragmentation rule (the same as sql/30_*.sql, sql/31_*.sql and mongo/migrate.js):
//   branch.country_code = 'LT'  -> lt   (m1_lt + M2_lt)
//   any other country           -> lvee (m1_lvee + M2_lvee)
// Customers, drones, rentals, payments, flight logs follow their branch, so everything
// about one drone or one rental is in fragments with the same key.
const { randomUUID } = require('crypto');
const { FRAGMENTS, KEYS } = require('./db');
const { badRequest, notFound } = require('./errors');

const fragmentOf = (countryCode) => (countryCode === 'LT' ? 'lt' : 'lvee');

// Fragments a query has to visit: a country filter narrows it to one.
const fragmentsFor = (countryCode) => (countryCode ? [fragmentOf(countryCode)] : KEYS);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertUuid(value, what) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw badRequest(`${what}: neteisingas UUID`);
}

// Objects shared by M1 and M2 get a UUID made by the application, so the same id can be
// written to both DBMS without any sequence to keep in sync.
const newUuid = () => randomUUID();

// A global id does not say where the row is, so the M1 fragments are searched.
async function locateBranch(g, branchId) {
  assertUuid(branchId, 'branch_id');
  for (const frag of KEYS) {
    const { rows } = await g.read(frag, 'SELECT * FROM branch WHERE branch_id = $1', [branchId]);
    if (rows[0]) {
      g.log('globalu', `filialas „${rows[0].name}“ (${rows[0].country_code}) → fragmentas ${frag}`);
      return { frag, branch: rows[0] };
    }
  }
  throw notFound(`Filialas ${branchId} nerastas nei viename M1 fragmente`);
}

async function locateDrone(g, droneId) {
  assertUuid(droneId, 'drone_id');
  for (const frag of KEYS) {
    const { rows } = await g.read(frag, 'SELECT branch_id FROM drone_commercial WHERE drone_id = $1', [droneId]);
    if (rows[0]) {
      g.log('globalu', `dronas rastas ${FRAGMENTS[frag].m1Name} → jo techninė dalis ${FRAGMENTS[frag].m2Name}`);
      return frag;
    }
  }
  throw notFound(`Dronas ${droneId} nerastas nei viename M1 fragmente`);
}

// Integer keys (customer_id, payment_id) have no sequence and must stay unique in the
// union of both fragments: next value = max over both fragments + 1.
// Fine for the lab; two operations running at the same moment could get the same value.
async function nextM1Id(g, table, column) {
  let max = 0;
  for (const frag of KEYS) {
    const { rows } = await g.read(frag, `SELECT coalesce(max(${column}), 0) AS m FROM ${table}`);
    max = Math.max(max, Number(rows[0].m));
  }
  return max + 1;
}

// The same for M2 keys: flight_log._id, or an embedded key such as 'maintenance.maintenance_id'.
async function nextM2Id(g, collection, field) {
  const [array, key] = field.split('.');
  const pipeline = key
    ? [{ $unwind: `$${array}` }, { $group: { _id: null, m: { $max: `$${field}` } } }]
    : [{ $group: { _id: null, m: { $max: `$${field}` } } }];
  let max = 0;
  for (const frag of KEYS) {
    const [doc] = await g.m2read(frag, `${collection}: max(${field})`, (db) =>
      db.collection(collection).aggregate(pipeline).toArray());
    max = Math.max(max, Number(doc?.m ?? 0));
  }
  return max + 1;
}

module.exports = {
  fragmentOf, fragmentsFor, assertUuid, newUuid, locateBranch, locateDrone, nextM1Id, nextM2Id,
};
