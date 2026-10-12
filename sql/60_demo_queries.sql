-- =====================================================================
-- DEMO QUERIES for the defence (pgAdmin -> Query Tool).
-- Each block says which database to open it in.
-- Highlight one statement and press F5.
-- =====================================================================


-- ---------- 1. [m1_lt] and [m1_lvee]: horizontal criterion ----------
-- m1_lt holds only LT branches, m1_lvee only LV + EE branches
SELECT country_code, count(*) AS branches FROM branch GROUP BY country_code;

-- derived fragmentation: rentals / customers follow their branch
SELECT b.country_code, count(*) AS rentals
FROM rental r JOIN branch b USING (branch_id)
GROUP BY b.country_code;

SELECT b.country_code, count(*) AS customers
FROM customer c JOIN branch b ON b.branch_id = c.home_branch_id
GROUP BY b.country_code;

-- classifiers are full copies (10 rows in both fragments)
SELECT (SELECT count(*) FROM country)        AS country,
       (SELECT count(*) FROM drone_category) AS drone_category,
       (SELECT count(*) FROM drone_model)    AS drone_model;


-- ---------- 2. [m1_lt]: one drone, commercial part (M1) ----------
-- 'drone:1' -> deterministic UUID; the same id is used in M0 and later in M2
SELECT d.drone_id, m.manufacturer, m.model_name, b.name AS branch,
       d.daily_rate, d.deposit_amount, d.status
FROM drone_commercial d
JOIN drone_model m USING (model_id)
JOIN branch b USING (branch_id)
WHERE d.drone_id = 'b86ff0b4-a611-5a73-b86a-519b7b057b6d';

-- rentals and income of that drone (fully answered inside M1)
SELECT r.rental_id, c.first_name || ' ' || c.last_name AS customer, r.start_date, r.end_date,
       r.status, sum(p.amount) FILTER (WHERE p.payment_type IN ('rental_fee', 'damage_fee')) AS income
FROM rental r
JOIN customer c USING (customer_id)
LEFT JOIN payment p USING (rental_id)
WHERE r.drone_id = 'b86ff0b4-a611-5a73-b86a-519b7b057b6d'
GROUP BY 1, 2, 3, 4, 5
ORDER BY r.start_date;


-- ---------- 3. [isdb_original]: the same drone in M0 (all 14 attributes) ----------
SELECT * FROM drone WHERE drone_id = 'b86ff0b4-a611-5a73-b86a-519b7b057b6d';
-- purchase_date .. status  -> M1 drone_commercial
-- serial_number .. condition -> M2 (document DB)


-- ---------- 4. [m1_lvee]: the UUID is NOT here (other horizontal fragment) ----------
SELECT count(*) FROM drone_commercial WHERE drone_id = 'b86ff0b4-a611-5a73-b86a-519b7b057b6d';  -- 0


-- ---------- 5. [m1_lt] or [m1_lvee]: business query inside one fragment ----------
-- top customers by money spent
SELECT c.first_name || ' ' || c.last_name AS customer, b.city,
       count(DISTINCT r.rental_id) AS rentals, sum(p.amount) AS paid_eur
FROM customer c
JOIN branch b ON b.branch_id = c.home_branch_id
JOIN rental r USING (customer_id)
JOIN payment p USING (rental_id)
WHERE p.payment_type IN ('rental_fee', 'damage_fee')
GROUP BY 1, 2
ORDER BY paid_eur DESC
LIMIT 5;
