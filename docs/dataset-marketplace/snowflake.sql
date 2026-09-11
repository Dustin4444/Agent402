-- Load one day of the ecosystem dataset into Snowflake and expose it as a
-- Marketplace listing.
--
-- Run as ACCOUNTADMIN (or a role with CREATE DATABASE + CREATE SHARE).
-- Prerequisite: `node scripts/dataset-export.mjs --day <day> --out ./export`
-- has written ./export/dt=<day>/*.ndjson locally.
--
-- Shares can only expose SECURE views and tables, which is why the consumer
-- surface below is a set of secure views over the raw landing tables rather
-- than the landing tables themselves.

-- COST GUARD, the single biggest one on this platform. An X-Small warehouse is
-- 1 credit/hour ($2 on AWS us-east-1 Standard): the day's load is a couple of
-- minutes, but a warehouse left RUNNING is ~$1,460/month. AUTO_SUSPEND = 60
-- and the 60-second billing minimum are what keep this workload in single
-- dollars. Never raise the size for this data - it is ~31 MB/day.
CREATE WAREHOUSE IF NOT EXISTS AGENT402_LOAD
  WAREHOUSE_SIZE = XSMALL
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE;
USE WAREHOUSE AGENT402_LOAD;

CREATE DATABASE IF NOT EXISTS AGENT402;
CREATE SCHEMA   IF NOT EXISTS AGENT402.ECOSYSTEM;
USE SCHEMA AGENT402.ECOSYSTEM;

CREATE FILE FORMAT IF NOT EXISTS NDJSON
  TYPE = JSON
  STRIP_OUTER_ARRAY = FALSE;   -- one JSON object per line, not a wrapped array

CREATE STAGE IF NOT EXISTS DATASET_STAGE FILE_FORMAT = NDJSON;

-- Landing tables. One VARIANT column plus the partition day: the day is a real
-- column, never only a file path, so a consumer can filter without knowing how
-- we store it.
CREATE TABLE IF NOT EXISTS RAW_SELLERS           (DT DATE, V VARIANT);
CREATE TABLE IF NOT EXISTS RAW_ROUTES            (DT DATE, V VARIANT);
CREATE TABLE IF NOT EXISTS RAW_SETTLEMENT_BASE   (DT DATE, V VARIANT);
CREATE TABLE IF NOT EXISTS RAW_SETTLEMENT_SOLANA (DT DATE, V VARIANT);
CREATE TABLE IF NOT EXISTS RAW_SETTLEMENT_MPP    (DT DATE, V VARIANT);

-- ---------------------------------------------------------------------------
-- Per day: PUT from the local export, then COPY. Replace 2026-09-11 throughout.
-- PUT runs from SnowSQL or the Snowsight worksheet's local file upload.
--
--   PUT file://./export/dt=2026-09-11/sellers.ndjson           @DATASET_STAGE/dt=2026-09-11/ AUTO_COMPRESS=TRUE;
--   PUT file://./export/dt=2026-09-11/routes.ndjson            @DATASET_STAGE/dt=2026-09-11/ AUTO_COMPRESS=TRUE;
--   PUT file://./export/dt=2026-09-11/settlement_base.ndjson   @DATASET_STAGE/dt=2026-09-11/ AUTO_COMPRESS=TRUE;
--   PUT file://./export/dt=2026-09-11/settlement_solana.ndjson @DATASET_STAGE/dt=2026-09-11/ AUTO_COMPRESS=TRUE;
--   PUT file://./export/dt=2026-09-11/settlement_mpp.ndjson    @DATASET_STAGE/dt=2026-09-11/ AUTO_COMPRESS=TRUE;

COPY INTO RAW_SELLERS (DT, V)
  FROM (SELECT TO_DATE('2026-09-11'), $1 FROM @DATASET_STAGE/dt=2026-09-11/sellers.ndjson.gz)
  FILE_FORMAT = NDJSON ON_ERROR = ABORT_STATEMENT;
COPY INTO RAW_ROUTES (DT, V)
  FROM (SELECT TO_DATE('2026-09-11'), $1 FROM @DATASET_STAGE/dt=2026-09-11/routes.ndjson.gz)
  FILE_FORMAT = NDJSON ON_ERROR = ABORT_STATEMENT;
COPY INTO RAW_SETTLEMENT_BASE (DT, V)
  FROM (SELECT TO_DATE('2026-09-11'), $1 FROM @DATASET_STAGE/dt=2026-09-11/settlement_base.ndjson.gz)
  FILE_FORMAT = NDJSON ON_ERROR = ABORT_STATEMENT;
COPY INTO RAW_SETTLEMENT_SOLANA (DT, V)
  FROM (SELECT TO_DATE('2026-09-11'), $1 FROM @DATASET_STAGE/dt=2026-09-11/settlement_solana.ndjson.gz)
  FILE_FORMAT = NDJSON ON_ERROR = ABORT_STATEMENT;
COPY INTO RAW_SETTLEMENT_MPP (DT, V)
  FROM (SELECT TO_DATE('2026-09-11'), $1 FROM @DATASET_STAGE/dt=2026-09-11/settlement_mpp.ndjson.gz)
  FILE_FORMAT = NDJSON ON_ERROR = ABORT_STATEMENT;

-- ---------------------------------------------------------------------------
-- Typed, shareable views. Column names match the NDJSON exactly, so the
-- dataset's own manifest is the schema documentation and the two cannot drift.

CREATE OR REPLACE SECURE VIEW SELLERS AS SELECT
  DT                                        AS DT,
  V:origin::STRING                          AS ORIGIN,
  V:display_name::STRING                    AS DISPLAY_NAME,
  V:homepage::STRING                        AS HOMEPAGE,
  V:primary_network::STRING                 AS PRIMARY_NETWORK,
  V:networks                                AS NETWORKS,
  V:tool_count::NUMBER                      AS TOOL_COUNT,
  V:paid_tool_count::NUMBER                 AS PAID_TOOL_COUNT,
  V:origin_responded::BOOLEAN               AS ORIGIN_RESPONDED,
  V:discovery_path::STRING                  AS DISCOVERY_PATH,
  V:source::STRING                          AS SOURCE,
  V:health::FLOAT                           AS HEALTH,
  V:routable::BOOLEAN                       AS ROUTABLE,
  V:mpp::BOOLEAN                            AS MPP,
  V:stellar_pay_to::STRING                  AS STELLAR_PAY_TO,
  V:algorand_pay_to::STRING                 AS ALGORAND_PAY_TO,
  V:pay_to_by_network                       AS PAY_TO_BY_NETWORK,
  V:payment_networks_known::BOOLEAN         AS PAYMENT_NETWORKS_KNOWN,
  V:router_dispatch_eligible::BOOLEAN       AS ROUTER_DISPATCH_ELIGIBLE,
  V:router_dispatch_reason::STRING          AS ROUTER_DISPATCH_REASON,
  V:fetched_at::TIMESTAMP_NTZ               AS FETCHED_AT,
  V:crawl_error::STRING                     AS CRAWL_ERROR
FROM RAW_SELLERS;

CREATE OR REPLACE SECURE VIEW ROUTES AS SELECT
  DT                                        AS DT,
  V:origin::STRING                          AS ORIGIN,
  V:route::STRING                           AS ROUTE,
  V:method::STRING                          AS METHOD,
  V:price_usd::FLOAT                        AS PRICE_USD,
  -- The provenance columns: this is why the table is worth paying for.
  V:price_source::STRING                    AS PRICE_SOURCE,
  V:price_resolved_from::STRING             AS PRICE_RESOLVED_FROM,
  V:origin_declared_price::FLOAT            AS ORIGIN_DECLARED_PRICE,
  V:quote_observed_at::TIMESTAMP_NTZ        AS QUOTE_OBSERVED_AT,
  V:quote_carried_forward::BOOLEAN          AS QUOTE_CARRIED_FORWARD,
  V:networks                                AS NETWORKS,
  V:networks_inferred::BOOLEAN              AS NETWORKS_INFERRED,
  V:networks_verified_at::TIMESTAMP_NTZ     AS NETWORKS_VERIFIED_AT,
  V:method_inferred::BOOLEAN                AS METHOD_INFERRED,
  V:method_corrected_from::STRING           AS METHOD_CORRECTED_FROM,
  V:url_template::STRING                    AS URL_TEMPLATE
FROM RAW_ROUTES;

CREATE OR REPLACE SECURE VIEW SETTLEMENT_BASE AS SELECT
  DT, V:name::STRING AS NAME, V:origins AS ORIGINS, V:homepage::STRING AS HOMEPAGE,
  V:pay_to::STRING AS PAY_TO, V:pay_to_count::NUMBER AS PAY_TO_COUNT,
  V:network::STRING AS NETWORK, V:calls_settled::NUMBER AS CALLS_SETTLED,
  V:total_usd::FLOAT AS TOTAL_USD,
  V:unique_buyers::NUMBER AS UNIQUE_BUYERS,   -- a count; addresses are never published
  V:endpoints::NUMBER AS ENDPOINTS
FROM RAW_SETTLEMENT_BASE;

CREATE OR REPLACE SECURE VIEW SETTLEMENT_SOLANA AS SELECT
  DT, V:pay_to::STRING AS PAY_TO, V:origins AS ORIGINS, V:credits::NUMBER AS CREDITS,
  V:payers::NUMBER AS PAYERS, V:truncated::BOOLEAN AS TRUNCATED,
  V:stale::BOOLEAN AS STALE, V:is_host::BOOLEAN AS IS_HOST
FROM RAW_SETTLEMENT_SOLANA;

CREATE OR REPLACE SECURE VIEW SETTLEMENT_MPP AS SELECT
  DT, V:recipient::STRING AS RECIPIENT, V:sellers AS SELLERS, V:intents AS INTENTS,
  V:transfers::NUMBER AS TRANSFERS, V:volume_usdc::FLOAT AS VOLUME_USDC,
  V:payers::NUMBER AS PAYERS, V:proven::BOOLEAN AS PROVEN,
  V:routable::BOOLEAN AS ROUTABLE, V:is_host::BOOLEAN AS IS_HOST
FROM RAW_SETTLEMENT_MPP;

-- ---------------------------------------------------------------------------
-- Share. The listing itself is created in Snowsight: Marketplace » Provider
-- Studio » Listings, pointing at this share.
CREATE SHARE IF NOT EXISTS AGENT402_ECOSYSTEM;
GRANT USAGE  ON DATABASE AGENT402                TO SHARE AGENT402_ECOSYSTEM;
GRANT USAGE  ON SCHEMA   AGENT402.ECOSYSTEM      TO SHARE AGENT402_ECOSYSTEM;
GRANT SELECT ON VIEW SELLERS           TO SHARE AGENT402_ECOSYSTEM;
GRANT SELECT ON VIEW ROUTES            TO SHARE AGENT402_ECOSYSTEM;
GRANT SELECT ON VIEW SETTLEMENT_BASE   TO SHARE AGENT402_ECOSYSTEM;
GRANT SELECT ON VIEW SETTLEMENT_SOLANA TO SHARE AGENT402_ECOSYSTEM;
GRANT SELECT ON VIEW SETTLEMENT_MPP    TO SHARE AGENT402_ECOSYSTEM;

-- Sanity before submitting the listing: row counts per table for the day, and
-- the share's own view of itself.
SELECT 'sellers' T, COUNT(*) N FROM SELLERS WHERE DT = '2026-09-11'
UNION ALL SELECT 'routes',            COUNT(*) FROM ROUTES            WHERE DT = '2026-09-11'
UNION ALL SELECT 'settlement_base',   COUNT(*) FROM SETTLEMENT_BASE   WHERE DT = '2026-09-11'
UNION ALL SELECT 'settlement_solana', COUNT(*) FROM SETTLEMENT_SOLANA WHERE DT = '2026-09-11'
UNION ALL SELECT 'settlement_mpp',    COUNT(*) FROM SETTLEMENT_MPP    WHERE DT = '2026-09-11';
SHOW GRANTS TO SHARE AGENT402_ECOSYSTEM;
