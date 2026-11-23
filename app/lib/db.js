// Connections to the four fragments of the global database.
//
//            M1 (PostgreSQL, dbvs1)   M2 (MongoDB, dbvs2)
//   lt   :   m1_lt                    M2_lt      branches in Lithuania
//   lvee :   m1_lvee                  M2_lvee    branches in any other country (LV, EE)
//
// Settings come from the environment (docker-compose sets them for the app service);
// the defaults match .env.example when the app runs on the host.
const { Pool, types } = require('pg');
const { MongoClient } = require('mongodb');

// PostgreSQL -> JS: dates stay 'YYYY-MM-DD' strings, numeric becomes a number.
types.setTypeParser(1082, (s) => s);                    // date
types.setTypeParser(1114, (s) => s.replace(' ', 'T'));  // timestamp
types.setTypeParser(1700, (s) => parseFloat(s));        // numeric

const pgConfig = {
  host: process.env.PG_HOST ?? 'localhost',
  port: Number(process.env.PG_PORT ?? 5433),
  user: process.env.PG_USER ?? 'postgres',
  password: process.env.PG_PASSWORD ?? 'postgres',
  max: 5,
};

const mongo = new MongoClient(
  process.env.MONGO_URI ?? 'mongodb://mongo:mongo@localhost:27017/?authSource=admin',
);

const FRAGMENTS = {
  lt: { key: 'lt', label: 'LT', m1Name: process.env.M1_LT ?? 'm1_lt', m2Name: process.env.M2_LT ?? 'M2_lt' },
  lvee: { key: 'lvee', label: 'LV + EE', m1Name: process.env.M1_LVEE ?? 'm1_lvee', m2Name: process.env.M2_LVEE ?? 'M2_lvee' },
};

for (const f of Object.values(FRAGMENTS)) {
  f.m1 = new Pool({ ...pgConfig, database: f.m1Name });
  // An idle connection can be killed (e.g. the setup service drops and rebuilds the
  // databases); without this listener the pool's 'error' event would crash the app.
  f.m1.on('error', (err) => console.warn(`${f.m1Name}: idle connection lost (${err.message})`));
  f.m2 = mongo.db(f.m2Name);
}

const KEYS = Object.keys(FRAGMENTS);

async function connect() {
  await mongo.connect();
}

async function close() {
  await Promise.all(Object.values(FRAGMENTS).map((f) => f.m1.end()));
  await mongo.close();
}

module.exports = { FRAGMENTS, KEYS, connect, close };
