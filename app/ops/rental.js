// Global object "Rental" (Lukas) - TO DO.
//
//   M1 (m1_lt / m1_lvee): rental + payment
//   M2 (M2_lt / M2_lvee): flight_log, linked by flight_log.rental_id
//   Fragment = rental.branch_id -> branch.country_code (lib/fragments.js: locateBranch / fragmentOf).
//   In M1 the FKs need the rental's customer and drone in the same fragment as its branch,
//   so check that before inserting. The drone's flight logs are in the M2 fragment with the same key.
//
// Tools (see ops/drone.js for all four operations done this way):
//   runGlobal(async (g) => ..., { readOnly })   lib/global-op.js
//   g.read / g.write (M1), g.m2read / g.m2write with an undo function (M2), g.log
//   locateBranch, locateDrone, newUuid, nextM1Id('payment', 'payment_id'),
//   nextM2Id('flight_log', '_id')                lib/fragments.js
// The routes in server.js and the "Nuomos" tab in the UI already call these functions.
const { HttpError } = require('../lib/errors');

const notYet = (what) => {
  throw new HttpError(501, `${what}: dar neįgyvendinta (Luko dalis)`);
};

// 1. SELECT - rental report across both countries: customer, drone model, money paid (M1)
//    + flight count, km, incidents (M2 flight_log by rental_id) + drone serial/condition (M2).
async function list(filter) {
  notYet('Nuomų atrinkimas');
}

// 2. INSERT - a rental with its flights: rental + payments into m1_X (newUuid() for rental_id,
//    nextM1Id for payment_id), flight_log documents with the same rental_id into M2_X.
async function insert(input) {
  notYet('Nuomos įterpimas');
}

// 3. UPDATE - finish a rental: M1 rental.status = 'completed', rental_fee payment,
//    drone_commercial.status = 'available'; M2 total_flight_hours / battery_cycles
//    (and condition after an incident) in drone_technical.
async function update(rentalId, input) {
  notYet('Nuomos redagavimas');
}

// 4. DELETE - payment -> rental (M1), flight_log with that rental_id (M2),
//    then run the orphan check (GET /api/check).
async function remove(rentalId) {
  notYet('Nuomos šalinimas');
}

module.exports = { list, insert, update, remove };
