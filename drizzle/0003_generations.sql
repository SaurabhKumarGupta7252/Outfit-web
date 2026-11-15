-- Generation milestone: guest-owned images, generations, atomic credit reservation and refund.
-- Hand-written migration (uses PL/pgSQL). Do not regenerate with drizzle-kit.

ALTER TABLE "images" ALTER COLUMN "user_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "images"
  ADD COLUMN "guest_session_id" uuid REFERENCES "guest_sessions"("id") ON DELETE SET NULL,
  ADD COLUMN "installation_id" uuid REFERENCES "device_installations"("id") ON DELETE SET NULL,
  ADD COLUMN "kind" varchar(16) NOT NULL DEFAULT 'upload',
  ADD COLUMN "mime_type" varchar(64),
  ADD COLUMN "width" integer,
  ADD COLUMN "height" integer,
  ADD COLUMN "deleted_at" timestamp with time zone,
  ADD CONSTRAINT "images_kind_check" CHECK ("kind" IN ('upload', 'result'));
--> statement-breakpoint
CREATE INDEX "images_user_idx" ON "images" ("user_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "images_guest_idx" ON "images" ("guest_session_id", "created_at" DESC);
--> statement-breakpoint
CREATE TABLE "generations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "guest_session_id" uuid REFERENCES "guest_sessions"("id") ON DELETE SET NULL,
  "wallet_id" uuid NOT NULL REFERENCES "wallets"("id") ON DELETE RESTRICT,
  "template_id" uuid NOT NULL REFERENCES "templates"("id") ON DELETE RESTRICT,
  "uploaded_image_id" integer REFERENCES "images"("id") ON DELETE SET NULL,
  "output_image_id" integer REFERENCES "images"("id") ON DELETE SET NULL,
  "retry_of" uuid REFERENCES "generations"("id") ON DELETE SET NULL,
  "status" varchar(16) NOT NULL DEFAULT 'PENDING',
  "application_credits" integer NOT NULL,
  "reserved_free" integer NOT NULL DEFAULT 0,
  "reserved_purchased" integer NOT NULL DEFAULT 0,
  "provider" varchar(32) NOT NULL DEFAULT 'magic_hour',
  "provider_project_id" text,
  "provider_credits" integer,
  "idempotency_key" text NOT NULL,
  "error_code" varchar(64),
  "error_message" text,
  "poll_locked_until" timestamp with time zone,
  "submitted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "generations_status_check" CHECK ("status" IN
    ('PENDING', 'RESERVED', 'SUBMITTED', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED')),
  CONSTRAINT "generations_wallet_idem_unique" UNIQUE ("wallet_id", "idempotency_key"),
  CONSTRAINT "generations_provider_project_unique" UNIQUE ("provider", "provider_project_id")
);
--> statement-breakpoint
CREATE INDEX "generations_user_idx" ON "generations" ("user_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "generations_guest_idx" ON "generations" ("guest_session_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "generations_open_idx" ON "generations" ("status", "updated_at")
  WHERE "status" IN ('RESERVED', 'SUBMITTED', 'PROCESSING');
--> statement-breakpoint
-- Only these status changes are allowed:
--   PENDING    -> RESERVED | FAILED
--   RESERVED   -> SUBMITTED | REFUNDED
--   SUBMITTED  -> PROCESSING | COMPLETED | REFUNDED
--   PROCESSING -> COMPLETED | REFUNDED
--   FAILED     -> REFUNDED
-- COMPLETED and REFUNDED are final.
CREATE FUNCTION "generations_check_transition"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.status = 'PENDING'    AND NEW.status IN ('RESERVED', 'FAILED'))
    OR (OLD.status = 'RESERVED'   AND NEW.status IN ('SUBMITTED', 'REFUNDED'))
    OR (OLD.status = 'SUBMITTED'  AND NEW.status IN ('PROCESSING', 'COMPLETED', 'REFUNDED'))
    OR (OLD.status = 'PROCESSING' AND NEW.status IN ('COMPLETED', 'REFUNDED'))
    OR (OLD.status = 'FAILED'     AND NEW.status = 'REFUNDED')
  ) THEN
    RAISE EXCEPTION 'INVALID_GENERATION_TRANSITION: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "generations_status_transition"
  BEFORE UPDATE OF "status" ON "generations"
  FOR EACH ROW EXECUTE FUNCTION "generations_check_transition"();
--> statement-breakpoint
-- Creates a generation and takes its credits out of the wallet in one transaction.
-- Free credits are spent before purchased credits. Repeating the call with the same
-- idempotency key returns the first generation and charges nothing more.
-- Returns {"id": uuid, "created": boolean}. Raises INSUFFICIENT_CREDITS.
CREATE FUNCTION "fn_reserve_generation"(
  p_wallet_id uuid, p_user_id integer, p_guest_session_id uuid, p_template_id uuid,
  p_image_id integer, p_cost integer, p_idempotency_key text, p_retry_of uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_wallet wallets%ROWTYPE;
  v_existing uuid;
  v_id uuid;
  v_free integer;
  v_purchased integer;
BEGIN
  IF p_cost <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  SELECT * INTO v_wallet FROM wallets WHERE id = p_wallet_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;

  SELECT id INTO v_existing FROM generations
   WHERE wallet_id = p_wallet_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object('id', v_existing, 'created', false);
  END IF;

  IF v_wallet.free_balance + v_wallet.purchased_balance < p_cost THEN
    RAISE EXCEPTION 'INSUFFICIENT_CREDITS';
  END IF;

  v_free := LEAST(v_wallet.free_balance, p_cost);
  v_purchased := p_cost - v_free;

  INSERT INTO generations
    (user_id, guest_session_id, wallet_id, template_id, uploaded_image_id, retry_of, status,
     application_credits, reserved_free, reserved_purchased, idempotency_key)
  VALUES
    (p_user_id, p_guest_session_id, p_wallet_id, p_template_id, p_image_id, p_retry_of, 'RESERVED',
     p_cost, v_free, v_purchased, p_idempotency_key)
  RETURNING id INTO v_id;

  UPDATE wallets
     SET free_balance = free_balance - v_free,
         purchased_balance = purchased_balance - v_purchased,
         updated_at = now()
   WHERE id = p_wallet_id;

  INSERT INTO credit_transactions
    (wallet_id, transaction_type, credit_source, amount, free_delta, purchased_delta,
     balance_before, balance_after, reference_id, idempotency_key, description)
  VALUES
    (p_wallet_id, 'DEBIT', 'GENERATION_DEBIT', p_cost, -v_free, -v_purchased,
     v_wallet.free_balance + v_wallet.purchased_balance,
     v_wallet.free_balance + v_wallet.purchased_balance - p_cost,
     v_id::text, 'gen-debit:' || v_id::text, 'Outfit generation');

  RETURN jsonb_build_object('id', v_id, 'created', true);
END;
$$;
--> statement-breakpoint
-- Marks a generation as completed, which makes its debit final. Returns true only for the
-- call that completed it.
CREATE FUNCTION "fn_commit_generation"(p_generation_id uuid, p_output_image_id integer, p_provider_credits integer)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM generations WHERE id = p_generation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GENERATION_NOT_FOUND';
  END IF;
  IF v_status = 'COMPLETED' THEN
    RETURN false;
  END IF;
  IF v_status NOT IN ('SUBMITTED', 'PROCESSING') THEN
    RAISE EXCEPTION 'GENERATION_NOT_COMMITTABLE: %', v_status;
  END IF;

  UPDATE generations
     SET status = 'COMPLETED', output_image_id = p_output_image_id,
         provider_credits = COALESCE(p_provider_credits, provider_credits),
         completed_at = now(), updated_at = now(), poll_locked_until = NULL
   WHERE id = p_generation_id;
  RETURN true;
END;
$$;
--> statement-breakpoint
-- Fails a generation and returns its credits to the same buckets they came from, exactly once.
-- If the guest who started it has since registered, the refund goes to the account's wallet.
-- Returns true only for the call that refunded. A completed generation is never refunded here.
CREATE FUNCTION "fn_refund_generation"(p_generation_id uuid, p_error_code text, p_error_message text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  v_gen generations%ROWTYPE;
  v_wallet wallets%ROWTYPE;
  v_wallet_id uuid;
  v_amount integer;
BEGIN
  SELECT * INTO v_gen FROM generations WHERE id = p_generation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GENERATION_NOT_FOUND';
  END IF;
  IF v_gen.status IN ('REFUNDED', 'COMPLETED') THEN
    RETURN false;
  END IF;

  v_amount := v_gen.reserved_free + v_gen.reserved_purchased;
  v_wallet_id := v_gen.wallet_id;
  IF v_gen.user_id IS NOT NULL THEN
    SELECT id INTO v_wallet_id FROM wallets WHERE user_id = v_gen.user_id;
    IF NOT FOUND THEN
      v_wallet_id := v_gen.wallet_id;
    END IF;
  END IF;

  IF v_amount > 0 THEN
    SELECT * INTO v_wallet FROM wallets WHERE id = v_wallet_id FOR UPDATE;
    UPDATE wallets
       SET free_balance = free_balance + v_gen.reserved_free,
           purchased_balance = purchased_balance + v_gen.reserved_purchased,
           updated_at = now()
     WHERE id = v_wallet_id;

    INSERT INTO credit_transactions
      (wallet_id, transaction_type, credit_source, amount, free_delta, purchased_delta,
       balance_before, balance_after, reference_id, idempotency_key, description)
    VALUES
      (v_wallet_id, 'CREDIT', 'GENERATION_REFUND', v_amount, v_gen.reserved_free, v_gen.reserved_purchased,
       v_wallet.free_balance + v_wallet.purchased_balance,
       v_wallet.free_balance + v_wallet.purchased_balance + v_amount,
       v_gen.id::text, 'gen-refund:' || v_gen.id::text, 'Refund for failed generation');
  END IF;

  UPDATE generations
     SET status = 'REFUNDED', error_code = p_error_code, error_message = left(p_error_message, 500),
         completed_at = now(), updated_at = now(), poll_locked_until = NULL
   WHERE id = p_generation_id;
  RETURN true;
END;
$$;
--> statement-breakpoint
-- Same rules as in 0002, and additionally moves the guest's images and generation history
-- to the account so history survives registration and later refunds reach the account.
CREATE OR REPLACE FUNCTION "fn_merge_guest_into_user"(p_guest_session_id uuid, p_user_id integer)
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

  UPDATE generations SET user_id = p_user_id, updated_at = now()
   WHERE guest_session_id = p_guest_session_id AND user_id IS NULL;
  UPDATE images SET user_id = p_user_id
   WHERE guest_session_id = p_guest_session_id AND user_id IS NULL;

  UPDATE users SET free_grant_consumed = true, updated_at = now() WHERE id = p_user_id;
  UPDATE guest_sessions
     SET status = 'linked', linked_user_id = p_user_id, linked_at = now()
   WHERE id = p_guest_session_id;

  RETURN jsonb_build_object('status', 'linked', 'transferred', v_total, 'linkedToCaller', true);
END;
$$;
--> statement-breakpoint
INSERT INTO "app_settings" ("setting_key", "setting_value") VALUES
  ('generation_limits', '{"timeoutMinutes": 10, "maxUploadBytes": 10485760}')
ON CONFLICT ("setting_key") DO NOTHING;
