// One global operation = work on several fragments that must succeed or fail together.
//
//   runGlobal(async (g) => { ... })            read/write operation
//   runGlobal(async (g) => { ... }, { readOnly: true })
//
// Inside the callback:
//   g.read(frag, sql, params)      M1 query outside the transaction (lookups, selects)
//   g.write(frag, sql, params)     M1 statement inside the global transaction; the first one
//                                  on a fragment opens BEGIN there
//   g.m2read(frag, text, fn)       M2 read: fn(db) gets the fragment's MongoDB database
//   g.m2write(frag, text, fn, undo) M2 write + the compensation that undoes it
//   g.log(target, text)            a line for the execution trace shown in the UI
//
// How it commits:
//   - MongoDB runs as a standalone server, so it has no multi-document transactions.
//     M2 writes are applied at once and each registers an undo function (compensation).
//   - M1 writes stay in open PostgreSQL transactions until the callback finishes.
//     One M1 fragment  -> COMMIT.
//     Two M1 fragments -> two-phase commit: PREPARE TRANSACTION on both (phase 1),
//                         then COMMIT PREPARED on both (phase 2).
//   - Any error before the commit point: ROLLBACK every M1 transaction and run the M2
//     compensations in reverse order.
//
// simulateFailure (demonstration only, "Imituoti gedimą" in the UI): the commit fails as if
// a participant could not commit. One M1 fragment: the error comes instead of COMMIT.
// Two M1 fragments: the last one "votes no" in phase 1, after the others have prepared.
const { randomUUID } = require('crypto');
const { FRAGMENTS } = require('./db');
const { HttpError } = require('./errors');

const oneLine = (sql) => sql.replace(/\s+/g, ' ').trim();
const simulated = (where) => new HttpError(503, `Imituotas gedimas: ${where}`);

class GlobalOp {
  constructor({ readOnly = false, simulateFailure = false } = {}) {
    this.readOnly = readOnly;
    this.simulateFailure = simulateFailure && !readOnly;
    this.trace = [];
    this.clients = new Map(); // fragment key -> pg client with an open transaction
    this.undo = [];           // M2 compensations, run in reverse on failure
  }

  log(target, text) {
    this.trace.push({ target, text });
  }

  async read(frag, sql, params = []) {
    const f = FRAGMENTS[frag];
    const res = await f.m1.query(sql, params);
    this.log(f.m1Name, `${oneLine(sql)}  → ${res.rowCount} eil.`);
    return res;
  }

  async write(frag, sql, params = []) {
    if (this.readOnly) throw new Error('write() in a read-only global operation');
    const f = FRAGMENTS[frag];
    if (!this.clients.has(frag)) {
      const client = await f.m1.connect();
      this.clients.set(frag, client);
      await client.query('BEGIN');
      this.log(f.m1Name, 'BEGIN');
    }
    const res = await this.clients.get(frag).query(sql, params);
    this.log(f.m1Name, `${oneLine(sql)}  → ${res.rowCount} eil.`);
    return res;
  }

  async m2read(frag, text, fn) {
    const f = FRAGMENTS[frag];
    const result = await fn(f.m2);
    const n = Array.isArray(result) ? `${result.length} dok.` : result ? '1 dok.' : '0 dok.';
    this.log(f.m2Name, `${text}  → ${n}`);
    return result;
  }

  async m2write(frag, text, fn, undo) {
    if (this.readOnly) throw new Error('m2write() in a read-only global operation');
    const f = FRAGMENTS[frag];
    const result = await fn(f.m2);
    this.undo.push({ frag, text, undo });
    this.log(f.m2Name, text);
    return result;
  }

  async commit() {
    const open = [...this.clients.entries()];
    if (open.length <= 1 && this.simulateFailure) {
      throw simulated(open.length ? `${FRAGMENTS[open[0][0]].m1Name} negali įvykdyti COMMIT` : 'prieš patvirtinimą');
    }
    if (open.length === 1) {
      const [frag, client] = open[0];
      await client.query('COMMIT');
      this.log(FRAGMENTS[frag].m1Name, 'COMMIT');
    } else if (open.length > 1) {
      const gid = `skyrent_${randomUUID()}`;
      this.log('2PC', `${open.length} M1 fragmentai → dviejų fazių patvirtinimas (${gid})`);

      // Phase 1: every participant promises it can commit. A failed PREPARE rolls that
      // transaction back by itself; the ones already prepared are rolled back here.
      const prepared = [];
      try {
        for (const [i, [frag, client]] of open.entries()) {
          if (this.simulateFailure && i === open.length - 1) {
            throw simulated(`${FRAGMENTS[frag].m1Name} 1 fazėje atsako „negaliu“`);
          }
          await client.query(`PREPARE TRANSACTION '${gid}_${frag}'`);
          prepared.push(frag);
          this.log(FRAGMENTS[frag].m1Name, '1 fazė: PREPARE TRANSACTION');
        }
      } catch (err) {
        for (const frag of prepared) {
          await this.clients.get(frag).query(`ROLLBACK PREPARED '${gid}_${frag}'`);
          this.log(FRAGMENTS[frag].m1Name, 'ROLLBACK PREPARED');
          this.clients.get(frag).release();
          this.clients.delete(frag);
        }
        throw err;
      }

      // Phase 2: all prepared, the decision is commit. From here on nothing is compensated:
      // if a COMMIT PREPARED fails, that prepared transaction stays and is committed by hand.
      this.undo = [];
      for (const [frag, client] of open) {
        await client.query(`COMMIT PREPARED '${gid}_${frag}'`);
        this.log(FRAGMENTS[frag].m1Name, '2 fazė: COMMIT PREPARED');
      }
    }
    this.release();
  }

  async rollback() {
    for (const [frag, client] of this.clients) {
      try {
        await client.query('ROLLBACK');
        this.log(FRAGMENTS[frag].m1Name, 'ROLLBACK');
      } catch (e) {
        this.log(FRAGMENTS[frag].m1Name, `ROLLBACK nepavyko: ${e.message}`);
      }
    }
    this.release();
    for (const { frag, text, undo } of this.undo.reverse()) {
      try {
        await undo(FRAGMENTS[frag].m2);
        this.log(FRAGMENTS[frag].m2Name, `kompensacija: atšaukta „${text}“`);
      } catch (e) {
        this.log(FRAGMENTS[frag].m2Name, `KOMPENSACIJA NEPAVYKO („${text}“): ${e.message}`);
      }
    }
    this.undo = [];
  }

  release() {
    for (const client of this.clients.values()) client.release();
    this.clients.clear();
  }
}

async function runGlobal(fn, options) {
  const g = new GlobalOp(options);
  try {
    const result = await fn(g);
    await g.commit();
    return { result, trace: g.trace };
  } catch (err) {
    g.log('klaida', err.message);
    await g.rollback();
    err.trace = g.trace;
    throw err;
  }
}

module.exports = { runGlobal };
