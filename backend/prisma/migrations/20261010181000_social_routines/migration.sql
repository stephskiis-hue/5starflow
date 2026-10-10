-- The registry upsert never overwrites owner-controlled state, so flip the social routines here once.
-- Old Claude-app social tasks are retired (the MSI social gate replaces them); the unified social entry is on and heartbeat-watched.
UPDATE "Routine" SET "enabled" = false, "expectedEveryMinutes" = NULL, "lastStatus" = NULL WHERE "slug" = 'ext-social-mac';
UPDATE "Routine" SET "enabled" = true, "expectedEveryMinutes" = 480, "externalId" = NULL,
  "config" = COALESCE("config", '{}'::jsonb) || '{"activeHours":[7,22]}'::jsonb
WHERE "slug" = 'ext-social-daily';
