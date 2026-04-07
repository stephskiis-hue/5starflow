-- Roll back the standalone Campaign Management System (v2)
-- Keep SMS Marketing as the only campaign system.

DROP TABLE IF EXISTS "campaign_members";
DROP TABLE IF EXISTS "campaigns";
DROP TABLE IF EXISTS "clients";
