# src/data — committed open datasets

## countries.json

A trimmed derivative of the **world-countries** dataset
(https://github.com/mledoze/countries, npm `world-countries@5.1.0`), which is
made available under the **Open Database License (ODbL) v1.0**
(https://opendatacommons.org/licenses/odbl/1-0/). Per the ODbL, this derived
database is likewise available under ODbL v1.0, and this notice serves as
attribution: country data © the world-countries contributors.

Timezone lists per country are joined in from the moment-timezone meta map
(npm `moment-timezone@0.6.2`, MIT license; the underlying IANA tz database is
public domain).

Regenerate with `node scripts/build-countries-data.js` (fetches the pinned
upstream versions and rewrites this file's sibling `countries.json`).
