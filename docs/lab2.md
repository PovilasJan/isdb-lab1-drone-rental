# Lab 2 – globalios duomenų operacijos

Programa `app/` (Node.js + Express, naršyklėje http://localhost:3000) vykdo globalias operacijas
per visus keturis fragmentus. Naudotojas dirba su globaliais objektais (dronas, nuoma) ir fragmento
nesirenka: kur kas guli, nustato programa.

|          | M1 – PostgreSQL (`dbvs1`) | M2 – MongoDB (`dbvs2`) |
|----------|---------------------------|------------------------|
| **lt**   | `m1_lt`                   | `M2_lt`                |
| **lvee** | `m1_lvee`                 | `M2_lvee`              |

Horizontalusis kriterijus vienas abiem vertikaliesiems fragmentams: filialo `country_code = 'LT'` → `lt`,
kita šalis → `lvee`. Todėl visa informacija apie vieną droną ar nuomą yra fragmentuose su tuo pačiu raktu.

## Paleidimas

```bash
cp .env.example .env
docker compose up -d                              # DB, pgAdmin, mongo-express, app
docker compose run --rm setup                     # M0 + M1 (m1_lt, m1_lvee)
docker compose run --rm --no-deps migrate-mongo   # M2 (M2_lt, M2_lvee)
docker compose restart app                        # po app/ kodo pakeitimų
```

## Struktūra

| Failas | Kas jame |
|---|---|
| `app/lib/db.js` | jungtys į 4 fragmentus |
| `app/lib/fragments.js` | lokalizacija: `fragmentOf`, `locateBranch`, `locateDrone`; globalūs ID (`newUuid`, `nextM1Id`, `nextM2Id`) |
| `app/lib/global-op.js` | globali operacija: transakcijos M1, kompensacija M2, dviejų fazių patvirtinimas, vykdymo eiga |
| `app/lib/orphans.js` | našlaičių patikra |
| `app/ops/drone.js` | **Povilas** – globalus objektas „Dronas“ |
| `app/ops/rental.js` | **Lukas** – globalus objektas „Nuoma“ |
| `app/public/` | naudotojo sąsaja |

Kiekvienas atsakymas grąžina `trace` – žingsnių sąrašą (kuris fragmentas, kokia užklausa, kiek eilučių).
Sąsaja jį rodo skiltyje „Vykdymo eiga“, todėl gynime matosi, kuriuos fragmentus operacija palietė.

## Bendri mechanizmai

**Lokalizacija.** Globalus ID nepasako, kur yra įrašas, todėl `locateDrone` / `locateBranch` ieško M1
fragmentuose. Jei filtre nurodyta šalis, užklausa siunčiama tik į tos šalies fragmentus (`fragmentsFor`).

**Globalūs identifikatoriai.** M1 ir M2 bendri objektai (dronas, nuoma, filialas, darbuotojas) turi UUID,
kurį sugeneruoja programa, todėl tą pačią reikšmę galima įrašyti į abi DBVS. Sveikųjų skaičių raktai
(`payment_id`, `flight_id`, `maintenance_id`, `customer_id`) neturi sekos: nauja reikšmė = abiejų
fragmentų maksimumas + 1, kad abiejų fragmentų sąjungoje raktas liktų unikalus.

**Globali transakcija** (`runGlobal`):
- M1 rašymai vyksta atvirose PostgreSQL transakcijose, kol baigiasi visa operacija.
- MongoDB veikia be replica set, todėl daugelio dokumentų transakcijų neturi. Kiekvienas M2 rašymas
  vykdomas iš karto ir užregistruoja **kompensaciją** (atvirkštinį veiksmą).
- Pabaigoje: vienas M1 fragmentas → `COMMIT`; du M1 fragmentai → **dviejų fazių patvirtinimas**:
  `PREPARE TRANSACTION` abiejuose (1 fazė), tada `COMMIT PREPARED` abiejuose (2 fazė).
  Tam `dbvs1` paleidžiamas su `max_prepared_transactions=10`.
- Klaida iki patvirtinimo → `ROLLBACK` (arba `ROLLBACK PREPARED`) M1 ir M2 kompensacijos atvirkštine tvarka.

**Našlaičių patikra** (skirtukas „Našlaičių patikra“, `GET /api/check`). PostgreSQL viduje ryšius saugo
išoriniai raktai. Patikra tikrina tai, ko neužtikrina nei viena DBVS: `drone_commercial` ↔ `drone_technical`
1:1 tame pačiame fragmente, `flight_log` → dronas ir nuoma, `maintenance.employee_id` → `employee`,
tas pats dronas ne abiejuose horizontaliuosiuose fragmentuose, `employee` kopijos M2 fragmentuose sutampa.

## Povilas – globalus objektas „Dronas“

M0 lentelė `drone` (14 atributų) skaidoma vertikaliai: komercinė dalis `drone_commercial` (M1) ir techninė
dalis `drone_technical` su įterptu `maintenance[]` masyvu (M2). Abi dalys turi tą patį raktą `drone_id`.

| Operacija | Ką daro | Fragmentai ir tvarka |
|---|---|---|
| **Atrinkimas** – `GET /api/drones`, `GET /api/drones/:id` | Dronų sąrašas su filtrais (šalis, statusas – M1; būklė – M2) ir drono kortelė: visi 14 atributų, apžiūros su techniko vardu, nuomos ir pajamos, skrydžiai. | Šalis nurodyta → tik tos šalies fragmentai, kitaip abu. Kiekviename: M1 `drone_commercial` ⋈ `drone_model` ⋈ `branch`, tada M2 `drone_technical` pagal tų dronų id, sujungiama pagal `drone_id`. Kortelė dar ima `rental`/`payment` (M1), `employee` ir `flight_log` (M2). |
| **Įterpimas** – `POST /api/drones` | Naujas dronas su vienu UUID. | Filialo šalis → fragmentas X. Serijos numerio unikalumas tikrinamas abiejuose M2 (indeksas galioja tik viename). `INSERT drone_commercial` į `m1_X`, `insertOne drone_technical` į `M2_X` (kompensacija: `deleteOne`). |
| **Redagavimas** – `PATCH /api/drones/:id` | Keičia bet kuriuos atributus; kiekvienas rašomas ten, kur guli (M1 ar M2). Filialas kitoje šalyje perkelia droną į kitus horizontaliuosius fragmentus. | Tame pačiame fragmente: `UPDATE drone_commercial` ir/ar `updateOne drone_technical` (kompensacija: senos reikšmės). Perkėlimas X → Y: `INSERT` į `m1_Y`, `DELETE` iš `m1_X` (2PC), `drone_technical` ir jo `flight_log` perkeliami iš `M2_X` į `M2_Y`. Dronas su nuomomis neperkeliamas: nuomos priklauso senajam filialui ir lieka `m1_X`, o ten jų FK reikalauja drono. |
| **Šalinimas** – `DELETE /api/drones/:id` | Pašalina droną ir viską, kas nuo jo priklauso. | Vaikai pirma: M1 `payment` → `rental` → `drone_commercial`; M2 `flight_log` (drono arba jo nuomų) → `drone_technical` (apžiūros išsitrina kartu, nes įterptos). Po to našlaičių patikra rodo, kad nieko neliko. |

## Lukas – globalus objektas „Nuoma“ (dar neįgyvendinta)

`rental` + `payment` (M1) ir `flight_log` (M2), susieti per `rental_id`. Fragmentą nustato nuomos filialas;
M1 išoriniai raktai reikalauja, kad klientas ir dronas būtų tame pačiame fragmente. Planas ir naudotini
pagalbininkai aprašyti `app/ops/rental.js`; maršrutai `server.js` ir skirtukas „Nuomos“ jau paruošti.

| Operacija | Planas |
|---|---|
| Atrinkimas | Nuomos su klientu, dronu ir sumokėta suma (M1) + skrydžių skaičius, km, incidentai (M2 `flight_log`) ir drono būklė (M2). |
| Įterpimas | `rental` + mokėjimai į `m1_X`, `flight_log` su tuo pačiu `rental_id` į `M2_X`. |
| Redagavimas | Nuomos užbaigimas: statusas, `rental_fee` mokėjimas, drono statusas (M1) + `total_flight_hours`, `battery_cycles`, po incidento `condition` (M2). |
| Šalinimas | `payment` → `rental` (M1), jos `flight_log` (M2), tada našlaičių patikra. |

## Žinomi apribojimai

- `nextM1Id` / `nextM2Id` neapsaugoti nuo dviejų vienu metu vykdomų operacijų (laboratoriniam darbui pakanka).
- Jei 2PC antroje fazėje nepavyksta `COMMIT PREPARED`, paruošta transakcija lieka `pg_prepared_xacts`
  ir patvirtinama rankiniu būdu; M2 tada nekompensuojamas, nes sprendimas jau „commit“.
- Kompensacija M2 nėra izoliuota: kol operacija vyksta, kitas skaitytojas gali trumpam pamatyti
  M2 pakeitimą, kurio M1 dar nepatvirtino.
