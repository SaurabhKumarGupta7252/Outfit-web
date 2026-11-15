-- Core business schema: accounts, devices, guest sessions, wallets, immutable ledger, catalog.
-- Hand-written migration (uses PL/pgSQL). Do not regenerate with drizzle-kit.

ALTER TABLE "users" ALTER COLUMN "password" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN "display_name" varchar(120),
  ADD COLUMN "avatar_url" text,
  ADD COLUMN "google_sub" text,
  ADD COLUMN "email_verified" boolean NOT NULL DEFAULT false,
  ADD COLUMN "role" varchar(16) NOT NULL DEFAULT 'user',
  ADD COLUMN "free_grant_consumed" boolean NOT NULL DEFAULT false,
  ADD COLUMN "deleted_at" timestamp with time zone,
  ADD CONSTRAINT "users_google_sub_unique" UNIQUE ("google_sub"),
  ADD CONSTRAINT "users_role_check" CHECK ("role" IN ('user', 'admin'));
--> statement-breakpoint
CREATE TABLE "device_installations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "installation_uuid" uuid NOT NULL,
  "secret_hash" text NOT NULL,
  "platform" varchar(16) NOT NULL DEFAULT 'android',
  "app_version" varchar(32),
  "device_model" varchar(120),
  "first_ip_hash" text,
  "last_ip_hash" text,
  "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "free_credit_claimed" boolean NOT NULL DEFAULT false,
  "free_credit_claimed_at" timestamp with time zone,
  "risk_status" varchar(16) NOT NULL DEFAULT 'unknown',
  "risk_score" integer NOT NULL DEFAULT 0,
  "integrity_metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "device_installations_uuid_unique" UNIQUE ("installation_uuid"),
  CONSTRAINT "device_installations_risk_check" CHECK ("risk_status" IN ('unknown', 'trusted', 'suspicious', 'blocked'))
);
--> statement-breakpoint
CREATE INDEX "device_installations_first_ip_idx" ON "device_installations" ("first_ip_hash", "free_credit_claimed_at");
--> statement-breakpoint
CREATE TABLE "guest_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "installation_id" uuid NOT NULL REFERENCES "device_installations"("id") ON DELETE CASCADE,
  "guest_token_hash" text NOT NULL,
  "linked_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "status" varchar(16) NOT NULL DEFAULT 'active',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone,
  "linked_at" timestamp with time zone,
  CONSTRAINT "guest_sessions_status_check" CHECK ("status" IN ('active', 'linked', 'expired', 'deleted'))
);
--> statement-breakpoint
-- At most one active guest session per installation.
CREATE UNIQUE INDEX "guest_sessions_one_active_idx" ON "guest_sessions" ("installation_id") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "guest_sessions_linked_user_idx" ON "guest_sessions" ("linked_user_id");
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "installation_id" uuid REFERENCES "device_installations"("id") ON DELETE SET NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "refresh_tokens_hash_unique" UNIQUE ("token_hash")
);
--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" ("user_id");
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "password_reset_tokens_hash_unique" UNIQUE ("token_hash")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_type" varchar(16) NOT NULL,
  "guest_session_id" uuid REFERENCES "guest_sessions"("id") ON DELETE SET NULL,
  "user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "free_balance" integer NOT NULL DEFAULT 0,
  "purchased_balance" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "wallets_guest_unique" UNIQUE ("guest_session_id"),
  CONSTRAINT "wallets_user_unique" UNIQUE ("user_id"),
  CONSTRAINT "wallets_owner_type_check" CHECK ("owner_type" IN ('guest', 'user', 'closed')),
  CONSTRAINT "wallets_free_non_negative" CHECK ("free_balance" >= 0),
  CONSTRAINT "wallets_purchased_non_negative" CHECK ("purchased_balance" >= 0),
  CONSTRAINT "wallets_single_owner" CHECK (NOT ("guest_session_id" IS NOT NULL AND "user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "wallet_id" uuid NOT NULL REFERENCES "wallets"("id") ON DELETE RESTRICT,
  "transaction_type" varchar(8) NOT NULL,
  "credit_source" varchar(32) NOT NULL,
  "amount" integer NOT NULL,
  "free_delta" integer NOT NULL DEFAULT 0,
  "purchased_delta" integer NOT NULL DEFAULT 0,
  "balance_before" integer NOT NULL,
  "balance_after" integer NOT NULL,
  "reference_id" text,
  "idempotency_key" text NOT NULL,
  "description" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "credit_transactions_idem_unique" UNIQUE ("idempotency_key"),
  CONSTRAINT "credit_transactions_type_check" CHECK ("transaction_type" IN ('CREDIT', 'DEBIT')),
  CONSTRAINT "credit_transactions_source_check" CHECK ("credit_source" IN (
    'FREE_CREDIT', 'GENERATION_DEBIT', 'GENERATION_REFUND', 'CREDIT_PURCHASE',
    'ADMIN_ADJUSTMENT', 'PURCHASE_REVERSAL', 'GUEST_TRANSFER_OUT', 'GUEST_TRANSFER_IN')),
  CONSTRAINT "credit_transactions_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "credit_transactions_balance_non_negative" CHECK ("balance_after" >= 0)
);
--> statement-breakpoint
CREATE INDEX "credit_transactions_wallet_idx" ON "credit_transactions" ("wallet_id", "created_at" DESC);
--> statement-breakpoint
CREATE FUNCTION "credit_transactions_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'credit_transactions rows are immutable' USING ERRCODE = 'P0001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "credit_transactions_no_update_delete"
  BEFORE UPDATE OR DELETE ON "credit_transactions"
  FOR EACH ROW EXECUTE FUNCTION "credit_transactions_immutable"();
--> statement-breakpoint
CREATE TABLE "categories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" varchar(80) NOT NULL,
  "slug" varchar(80) NOT NULL,
  "description" text,
  "image_url" text,
  "display_order" integer NOT NULL DEFAULT 0,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "categories_slug_unique" UNIQUE ("slug")
);
--> statement-breakpoint
CREATE TABLE "templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "category_id" uuid NOT NULL REFERENCES "categories"("id") ON DELETE RESTRICT,
  "name" varchar(120) NOT NULL,
  "description" text,
  "preview_image_url" text,
  "garment_image_path" text,
  "garment_type" varchar(16) NOT NULL DEFAULT 'entire_outfit',
  "is_featured" boolean NOT NULL DEFAULT false,
  "is_active" boolean NOT NULL DEFAULT true,
  "display_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "templates_garment_type_check" CHECK ("garment_type" IN ('upper_body', 'lower_body', 'entire_outfit'))
);
--> statement-breakpoint
CREATE INDEX "templates_category_idx" ON "templates" ("category_id", "is_active", "display_order");
--> statement-breakpoint
CREATE TABLE "credit_packages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "product_id" varchar(64) NOT NULL,
  "package_name" varchar(80) NOT NULL,
  "credits" integer NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "display_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "credit_packages_product_unique" UNIQUE ("product_id"),
  CONSTRAINT "credit_packages_credits_positive" CHECK ("credits" > 0)
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "setting_key" varchar(80) NOT NULL,
  "setting_value" jsonb NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "app_settings_key_unique" UNIQUE ("setting_key")
);
--> statement-breakpoint
-- Grants the one-time free credits for an installation. Returns true only when credits were
-- added by this call. Safe under concurrency: the installation row lock serialises callers.
CREATE FUNCTION "fn_grant_free_credits"(p_installation_id uuid, p_wallet_id uuid, p_amount integer)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  v_claimed boolean;
  v_free integer;
  v_purchased integer;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  SELECT free_credit_claimed INTO v_claimed
    FROM device_installations WHERE id = p_installation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSTALLATION_NOT_FOUND';
  END IF;
  IF v_claimed THEN
    RETURN false;
  END IF;

  SELECT free_balance, purchased_balance INTO v_free, v_purchased
    FROM wallets WHERE id = p_wallet_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;

  UPDATE device_installations
     SET free_credit_claimed = true, free_credit_claimed_at = now()
   WHERE id = p_installation_id;

  UPDATE wallets SET free_balance = free_balance + p_amount, updated_at = now()
   WHERE id = p_wallet_id;

  INSERT INTO credit_transactions
    (wallet_id, transaction_type, credit_source, amount, free_delta, purchased_delta,
     balance_before, balance_after, reference_id, idempotency_key, description)
  VALUES
    (p_wallet_id, 'CREDIT', 'FREE_CREDIT', p_amount, p_amount, 0,
     v_free + v_purchased, v_free + v_purchased + p_amount,
     p_installation_id::text, 'free:' || p_installation_id::text, 'Welcome credits');

  RETURN true;
END;
$$;
--> statement-breakpoint
-- Links an active guest session to a user and moves the guest balance to the user's wallet.
-- A guest session can be claimed once. A user can receive a guest's free credits once
-- (users.free_grant_consumed); later guest sessions are linked without a transfer, which
-- blocks farming free credits by reinstalling and signing in again.
-- Returns {"status": "linked" | "already_linked", "transferred": n}.
CREATE FUNCTION "fn_merge_guest_into_user"(p_guest_session_id uuid, p_user_id integer)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_session guest_sessions%ROWTYPE;
  v_consumed boolean;
  v_guest_wallet wallets%ROWTYPE;
  v_user_wallet wallets%ROWTYPE;
  v_move_free integer := 0;
  v_move_purchased integer := 0;
  v_total integer := 0;
BEGIN
  SELECT * INTO v_session FROM guest_sessions WHERE id = p_guest_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GUEST_SESSION_NOT_FOUND';
  END IF;
  IF v_session.status <> 'active' THEN
    RETURN jsonb_build_object(
      'status', 'already_linked',
      'transferred', 0,
      'linkedToCaller', v_session.linked_user_id IS NOT DISTINCT FROM p_user_id);
  END IF;

  SELECT free_grant_consumed INTO v_consumed FROM users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  INSERT INTO wallets (owner_type, user_id) VALUES ('user', p_user_id)
    ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_user_wallet FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  SELECT * INTO v_guest_wallet FROM wallets WHERE guest_session_id = p_guest_session_id FOR UPDATE;

  IF FOUND THEN
    v_move_purchased := v_guest_wallet.purchased_balance;
    IF NOT v_consumed THEN
      v_move_free := v_guest_wallet.free_balance;
    END IF;
    v_total := v_move_free + v_move_purchased;

    IF v_total > 0 THEN
      UPDATE wallets
         SET free_balance = free_balance - v_move_free,
             purchased_balance = purchased_balance - v_move_purchased,
             updated_at = now()
       WHERE id = v_guest_wallet.id;
      UPDATE wallets
         SET free_balance = free_balance + v_move_free,
             purchased_balance = purchased_balance + v_move_purchased,
             updated_at = now()
       WHERE id = v_user_wallet.id;

      INSERT INTO credit_transactions
        (wallet_id, transaction_type, credit_source, amount, free_delta, purchased_delta,
         balance_before, balance_after, reference_id, idempotency_key, description)
      VALUES
        (v_guest_wallet.id, 'DEBIT', 'GUEST_TRANSFER_OUT', v_total, -v_move_free, -v_move_purchased,
         v_guest_wallet.free_balance + v_guest_wallet.purchased_balance,
         v_guest_wallet.free_balance + v_guest_wallet.purchased_balance - v_total,
         p_user_id::text, 'merge-out:' || p_guest_session_id::text, 'Moved to registered account'),
        (v_user_wallet.id, 'CREDIT', 'GUEST_TRANSFER_IN', v_total, v_move_free, v_move_purchased,
         v_user_wallet.free_balance + v_user_wallet.purchased_balance,
         v_user_wallet.free_balance + v_user_wallet.purchased_balance + v_total,
         p_guest_session_id::text, 'merge-in:' || p_guest_session_id::text, 'Guest balance carried over');
    END IF;
  END IF;

  UPDATE users SET free_grant_consumed = true, updated_at = now() WHERE id = p_user_id;
  UPDATE guest_sessions
     SET status = 'linked', linked_user_id = p_user_id, linked_at = now()
   WHERE id = p_guest_session_id;

  RETURN jsonb_build_object('status', 'linked', 'transferred', v_total, 'linkedToCaller', true);
END;
$$;
--> statement-breakpoint
INSERT INTO "credit_packages" ("product_id", "package_name", "credits", "display_order") VALUES
  ('credits_50', '50 Credits', 50, 1),
  ('credits_100', '100 Credits', 100, 2),
  ('credits_250', '250 Credits', 250, 3),
  ('credits_500', '500 Credits', 500, 4),
  ('credits_1000', '1,000 Credits', 1000, 5);
--> statement-breakpoint
INSERT INTO "app_settings" ("setting_key", "setting_value") VALUES
  ('free_credits', '{"amount": 25}'),
  ('generation_cost', '{"credits": 2}'),
  ('free_grant_limits', '{"maxGrantsPerIpPerDay": 3}');
--> statement-breakpoint
INSERT INTO "categories" ("name", "slug", "description", "display_order") VALUES
  ('Casual', 'casual', 'Relaxed everyday looks', 1),
  ('Workwear', 'workwear', 'Tailored office outfits', 2),
  ('Streetwear', 'streetwear', 'Bold city styles', 3),
  ('Evening', 'evening', 'Dressed-up night looks', 4),
  ('Traditional', 'traditional', 'Festive and ethnic wear', 5);
