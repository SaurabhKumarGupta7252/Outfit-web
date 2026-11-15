-- Adds parent_id to categories for two-level hierarchy (group → subcategory).
-- Adds template_images table for bearer-protected template preview images stored in Cloudinary.

ALTER TABLE "categories"
  ADD COLUMN "parent_id" uuid REFERENCES "categories"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "categories_parent_idx" ON "categories" ("parent_id") WHERE "parent_id" IS NOT NULL;
--> statement-breakpoint

-- Stores template preview/garment images as private Cloudinary assets.
-- These are served via /api/v1/template-images/:id/content with bearer auth.
CREATE TABLE "template_images" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "template_id" uuid REFERENCES "templates"("id") ON DELETE CASCADE,
  "category_id" uuid REFERENCES "categories"("id") ON DELETE CASCADE,
  "public_id" text NOT NULL,
  "format" varchar(16) NOT NULL,
  "bytes" integer NOT NULL DEFAULT 0,
  "mime_type" varchar(64),
  "width" integer,
  "height" integer,
  "kind" varchar(16) NOT NULL DEFAULT 'preview',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "template_images_kind_check" CHECK ("kind" IN ('preview', 'garment'))
);
--> statement-breakpoint
CREATE INDEX "template_images_template_idx" ON "template_images" ("template_id");
CREATE INDEX "template_images_category_idx" ON "template_images" ("category_id");
