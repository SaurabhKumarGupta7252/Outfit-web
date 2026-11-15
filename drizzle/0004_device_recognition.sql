-- Fix #4: a reinstall gets a fresh installation UUID, so UUID alone cannot stop a second
-- free-credit claim on the same device. Android's Settings.Secure.ANDROID_ID (SSAID)
-- survives reinstalls for the same app signing key and the same user profile on the device,
-- so an installation that presents the same SSAID as one that already claimed is denied.
--
-- The SSAID is a device-scoped identifier, so we store only its hash.

ALTER TABLE "device_installations"
  ADD COLUMN "ssaid_hash" text,
  ADD COLUMN "device_fingerprint" text;
--> statement-breakpoint
-- Partial index so lookups by SSAID stay fast on any reasonable number of installations.
CREATE INDEX "device_installations_ssaid_idx" ON "device_installations" ("ssaid_hash")
  WHERE "ssaid_hash" IS NOT NULL;
