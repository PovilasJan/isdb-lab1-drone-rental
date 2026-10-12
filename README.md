# ISDB Lab 1 – SkyRent (drone rental)

## Run

```bash
cp .env.example .env
docker compose up -d
docker compose run --rm --no-deps migrate-mongo
```

pgAdmin: http://localhost:5050 (password from `.env`). Reset: `docker compose run --rm setup`.

| Database | |
|---|---|
| `isdb_original` | M0 – original full DB |
| `m1_lt` | M1-H1 – Lithuania |
| `m1_lvee` | M1-H2 – Latvia + Estonia |

## Diagrams

M0 – [m0_original.svg](docs/model/m0_original.svg) · M1 – [m1_customers_rentals.svg](docs/model/m1_customers_rentals.svg)

## Defence

**Vertical split**
- M1 Customers & Rentals (PostgreSQL): `branch`, `customer`, `rental`, `payment`, `drone_commercial` + classifiers
- M2 Fleet & Maintenance (MongoDB): `employee`, `maintenance`, `flight_log`, technical part of `drone`
- `drone` (14 attr.) split: price/rate/deposit/status → M1, serial/firmware/hours/battery/inspection/condition → M2

**Link M1 ↔ M2:** `drone_id`, `branch_id`, `rental_id`, `employee_id` are UUIDs – same value in both DBMS, no auto-increment to sync.

**Horizontal split:** `branch.country_code` LT → `m1_lt`, LV/EE → `m1_lvee`; customer, rental, payment, drone follow their branch; classifiers copied to both.

**Correctness:** `docker compose logs setup` – M0 = m1_lt ∪ m1_lvee, no overlap.

**Queries to show:** [sql/60_demo_queries.sql](sql/60_demo_queries.sql)
