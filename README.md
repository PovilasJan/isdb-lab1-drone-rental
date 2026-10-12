# ISDB Lab 1 – SkyRent (drone rental)

```bash
cp .env.example .env
docker compose up -d
```

pgAdmin http://localhost:5050 · mongo-express http://localhost:8081 · check: `docker compose logs setup migrate-mongo`

| | PostgreSQL | MongoDB |
|---|---|---|
| M0 | `isdb_original` | |
| Lithuania | `m1_lt` (M1-H1) | `M2_lt` (M2-H1) |
| Latvia + Estonia | `m1_lvee` (M1-H2) | `M2_lvee` (M2-H2) |

**Diagrams:** [M0](docs/model/m0_original.svg) · [M1](docs/model/m1_customers_rentals.svg) · [M2](docs/model/m2_document_model.svg) · [M2 rules](docs/model/nosql-migration-rules.txt)

**Split:** M1 = customers, rentals, payments, branches, `drone_commercial`. M2 = `drone_technical` with embedded `maintenance`, `employee`, `flight_log`. Linked by UUID `drone_id`.

**Horizontal:** M1 by `branch.country_code`; M2 derived – drones of `m1_lt` → `M2_lt`.

**Demo:** [sql/60_demo_queries.sql](sql/60_demo_queries.sql) · `docker compose exec dbvs2 mongosh -u mongo -p mongo --quiet /work/mongo/demo.js`
