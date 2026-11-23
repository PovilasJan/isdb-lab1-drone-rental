// SkyRent global operations: a web UI and JSON API over the four fragments.
// Every response is { result, trace }: trace lists the steps on each fragment.
const path = require('path');
const express = require('express');
const db = require('./lib/db');
const { toHttp } = require('./lib/errors');
const { checkOrphans } = require('./lib/orphans');
const { lookups } = require('./ops/lookups');
const drone = require('./ops/drone');
const rental = require('./ops/rental');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const send = (fn) => async (req, res) => res.json(await fn(req));

// ?fail=1 on a write: the global transaction fails at its commit point (demo of rollback,
// ROLLBACK PREPARED and M2 compensation; the "Imituoti gedimą" switch in the UI).
const opts = (req) => ({ simulateFailure: req.query.fail === '1' });

app.get('/api/lookups', send(() => lookups()));
app.get('/api/check', send(() => checkOrphans()));

// Povilas - global object "Drone"
app.get('/api/drones', send((req) => drone.list(req.query)));
app.get('/api/drones/:id', send((req) => drone.get(req.params.id)));
app.post('/api/drones', send((req) => drone.insert(req.body, opts(req))));
app.patch('/api/drones/:id', send((req) => drone.update(req.params.id, req.body, opts(req))));
app.delete('/api/drones/:id', send((req) => drone.remove(req.params.id, opts(req))));

// Lukas - global object "Rental"
app.get('/api/rentals', send((req) => rental.list(req.query)));
app.post('/api/rentals', send((req) => rental.insert(req.body, opts(req))));
app.patch('/api/rentals/:id', send((req) => rental.update(req.params.id, req.body, opts(req))));
app.delete('/api/rentals/:id', send((req) => rental.remove(req.params.id, opts(req))));

app.use((err, req, res, next) => {
  const status = toHttp(err);
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message, trace: err.trace ?? [] });
});

const PORT = Number(process.env.PORT ?? 3000);
db.connect().then(() => {
  app.listen(PORT, () => console.log(`SkyRent global app: http://localhost:${PORT}`));
});
