// DEMO for the defence (M2, MongoDB). Run:
//   docker compose exec dbvs2 mongosh -u mongo -p mongo --quiet /work/mongo/demo.js
// or paste single blocks into mongosh / mongo-express.

const lt = db.getSiblingDB('M2_lt');
const lvee = db.getSiblingDB('M2_lvee');
const DRONE = 'b86ff0b4-a611-5a73-b86a-519b7b057b6d'; // same UUID as in M0 and m1_lt.drone_commercial

print('\n== 1. Horizontal fragments (derived from m1_lt / m1_lvee id sets)');
for (const d of [lt, lvee]) {
  print(d.getName(), {
    drone_technical: d.drone_technical.countDocuments(),
    employee: d.employee.countDocuments(),
    flight_log: d.flight_log.countDocuments(),
  });
}

print('\n== 2. One drone: technical part with EMBEDDED maintenance (M2_lt)');
printjson(lt.drone_technical.findOne({ _id: DRONE }));
print('same UUID in M2_lvee:', lvee.drone_technical.countDocuments({ _id: DRONE }), '(other fragment)');

print('\n== 3. Aggregation over the embedded array: maintenance cost per drone (top 5)');
lt.drone_technical.aggregate([
  { $unwind: '$maintenance' },
  { $group: { _id: '$_id', serial: { $first: '$serial_number' }, jobs: { $sum: 1 },
              cost: { $sum: '$maintenance.cost' }, downtime_h: { $sum: '$maintenance.downtime_hours' } } },
  { $sort: { cost: -1 } },
  { $limit: 5 },
]).forEach((r) => printjson(r));

print('\n== 4. $lookup inside the fragment: flights + technician of the drone');
lt.drone_technical.aggregate([
  { $match: { _id: DRONE } },
  { $lookup: { from: 'flight_log', localField: '_id', foreignField: 'drone_id', as: 'flights' } },
  { $lookup: { from: 'employee', localField: 'maintenance.employee_id', foreignField: '_id', as: 'technicians' } },
  { $project: { serial_number: 1, flights: { $size: '$flights' },
                minutes_flown: { $sum: '$flights.duration_min' },
                technicians: { $map: { input: '$technicians', in: { $concat: ['$$this.first_name', ' ', '$$this.last_name'] } } } } },
]).forEach((r) => printjson(r));

print('\n== 5. $jsonSchema validator rejects a bad document (replaces CHECK constraints)');
try {
  lt.drone_technical.insertOne({ _id: DRONE.replace('b86f', '0000'), serial_number: 'X', firmware_version: '1',
    total_flight_hours: 0, battery_cycles: 0, last_inspection_date: null, condition: 'broken', maintenance: [] });
} catch (e) {
  print('rejected:', e.message);
}

print('\n== 6. Global object = M1 part (PostgreSQL m1_lt) + M2 part (this document), joined on drone_id');
print("   m1_lt:  SELECT * FROM drone_commercial WHERE drone_id = '" + DRONE + "';");
print("   M2_lt:  db.drone_technical.findOne({ _id: '" + DRONE + "' })");
