// Data for the form drop-downs.
const { runGlobal } = require('../lib/global-op');
const { KEYS } = require('../lib/db');
const drone = require('./drone');

async function lookups() {
  return runGlobal(async (g) => {
    // branch is horizontally fragmented: the full list is the union of both M1 fragments
    const branches = [];
    for (const frag of KEYS) {
      const { rows } = await g.read(frag,
        'SELECT branch_id, name, city, country_code FROM branch ORDER BY country_code, name');
      branches.push(...rows.map((b) => ({ ...b, fragment: frag })));
    }
    // classifiers are replicated: any one fragment has the full list
    const { rows: models } = await g.read('lt', `
      SELECT model_id, manufacturer, model_name, c.name AS category
      FROM drone_model JOIN drone_category c USING (category_id)
      ORDER BY manufacturer, model_name`);
    return { branches, models, statuses: drone.STATUS, conditions: drone.CONDITION };
  }, { readOnly: true });
}

module.exports = { lookups };
