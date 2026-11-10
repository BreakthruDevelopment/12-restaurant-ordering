CREATE TABLE "allergen_change" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_counter" (
	"day" date PRIMARY KEY NOT NULL,
	"last" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "menu_category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_category_name_chk" CHECK (char_length("menu_category"."name") between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "menu_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"price_cents" integer NOT NULL,
	"dietary_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"sold_out" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"allergens_verified_at" timestamp with time zone,
	"allergens_verified_by" text,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menu_item_name_chk" CHECK (char_length("menu_item"."name") between 1 and 80),
	CONSTRAINT "menu_item_description_chk" CHECK (char_length("menu_item"."description") <= 300),
	CONSTRAINT "menu_item_price_chk" CHECK ("menu_item"."price_cents" between 0 and 100000),
	CONSTRAINT "menu_item_tags_chk" CHECK ("menu_item"."dietary_tags" <@ array['vegetarian', 'vegan', 'spicy']::text[])
);
--> statement-breakpoint
CREATE TABLE "menu_item_allergen" (
	"item_id" uuid NOT NULL,
	"allergen" text NOT NULL,
	"level" text NOT NULL,
	CONSTRAINT "menu_item_allergen_item_id_allergen_pk" PRIMARY KEY("item_id","allergen"),
	CONSTRAINT "menu_item_allergen_allergen_chk" CHECK ("menu_item_allergen"."allergen" in ('milk', 'egg', 'fish', 'crustacean_shellfish', 'tree_nuts', 'peanuts', 'wheat', 'soy', 'sesame', 'gluten')),
	CONSTRAINT "menu_item_allergen_level_chk" CHECK ("menu_item_allergen"."level" in ('contains', 'may_contain'))
);
--> statement-breakpoint
CREATE TABLE "order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"day" date DEFAULT (now() at time zone 'utc')::date NOT NULL,
	"customer_id" text NOT NULL,
	"status" text DEFAULT 'placed' NOT NULL,
	"pickup_name" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"allergy_alert" boolean DEFAULT false NOT NULL,
	"allergy_allergens" text[] DEFAULT '{}'::text[] NOT NULL,
	"allergy_note" text DEFAULT '' NOT NULL,
	"allergy_customer_confirmed" boolean DEFAULT false NOT NULL,
	"allergy_ack_by" text,
	"allergy_ack_at" timestamp with time zone,
	"subtotal_cents" integer NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"cancel_reason" text,
	"ready_estimate_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_id_customer_uq" UNIQUE("id","customer_id"),
	CONSTRAINT "order_status_chk" CHECK ("order"."status" in ('placed', 'accepted', 'preparing', 'ready', 'picked_up', 'cancelled')),
	CONSTRAINT "order_pickup_name_chk" CHECK (char_length("order"."pickup_name") between 1 and 40),
	CONSTRAINT "order_note_chk" CHECK (char_length("order"."note") <= 200 and char_length("order"."allergy_note") <= 200),
	CONSTRAINT "order_subtotal_chk" CHECK ("order"."subtotal_cents" >= 0),
	CONSTRAINT "order_allergens_chk" CHECK ("order"."allergy_allergens" <@ array['milk', 'egg', 'fish', 'crustacean_shellfish', 'tree_nuts', 'peanuts', 'wheat', 'soy', 'sesame', 'gluten']::text[]),
	CONSTRAINT "order_allergy_shape_chk" CHECK (("order"."allergy_alert" and (cardinality("order"."allergy_allergens") > 0 or char_length("order"."allergy_note") > 0)) or (not "order"."allergy_alert" and cardinality("order"."allergy_allergens") = 0 and "order"."allergy_note" = '')),
	CONSTRAINT "order_ack_shape_chk" CHECK (("order"."allergy_ack_at" is null or "order"."allergy_alert")),
	CONSTRAINT "order_confirmed_shape_chk" CHECK ((not "order"."allergy_customer_confirmed" or "order"."allergy_alert")),
	CONSTRAINT "order_cancel_reason_chk" CHECK ("order"."cancel_reason" is null or char_length("order"."cancel_reason") <= 200)
);
--> statement-breakpoint
CREATE TABLE "order_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" text NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"name" text NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"qty" integer NOT NULL,
	"allergens" jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "order_line_qty_chk" CHECK ("order_line"."qty" between 1 and 20),
	CONSTRAINT "order_line_price_chk" CHECK ("order_line"."unit_price_cents" between 0 and 100000)
);
--> statement-breakpoint
CREATE TABLE "restaurant_setting" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"accepting_orders" boolean DEFAULT true NOT NULL,
	"pickup_minutes" integer DEFAULT 20 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "restaurant_setting_singleton_chk" CHECK ("restaurant_setting"."id" = 1),
	CONSTRAINT "restaurant_setting_pickup_chk" CHECK ("restaurant_setting"."pickup_minutes" between 5 and 90)
);
--> statement-breakpoint
ALTER TABLE "item" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "item" CASCADE;--> statement-breakpoint
ALTER TABLE "rate_event" DROP CONSTRAINT "rate_event_kind_chk";--> statement-breakpoint
-- The template's old kinds ('api_write', 'upload') would violate the new constraint; their rows can never count again.
DELETE FROM "rate_event" WHERE "kind" NOT IN ('order', 'qa', 'menu_write', 'ai', 'demo_load');--> statement-breakpoint
ALTER TABLE "allergen_change" ADD CONSTRAINT "allergen_change_item_id_menu_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."menu_item"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item" ADD CONSTRAINT "menu_item_category_id_menu_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."menu_category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item" ADD CONSTRAINT "menu_item_allergens_verified_by_user_id_fk" FOREIGN KEY ("allergens_verified_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_allergen" ADD CONSTRAINT "menu_item_allergen_item_id_menu_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."menu_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_customer_id_user_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_allergy_ack_by_user_id_fk" FOREIGN KEY ("allergy_ack_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_menu_item_id_menu_item_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_item"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_order_customer_fk" FOREIGN KEY ("order_id","customer_id") REFERENCES "public"."order"("id","customer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "allergen_change_item_at_idx" ON "allergen_change" USING btree ("item_id","at");--> statement-breakpoint
CREATE INDEX "menu_item_category_idx" ON "menu_item" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_customer_idempotency_uidx" ON "order" USING btree ("customer_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "order_day_number_uidx" ON "order" USING btree ("day","number");--> statement-breakpoint
CREATE INDEX "order_status_created_idx" ON "order" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "order_customer_created_idx" ON "order" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "order_line_order_idx" ON "order_line" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "rate_event" ADD CONSTRAINT "rate_event_kind_chk" CHECK ("rate_event"."kind" in ('order', 'qa', 'menu_write', 'ai', 'demo_load'));
--> statement-breakpoint
-- The settings singleton always exists.
INSERT INTO "restaurant_setting" ("id") VALUES (1) ON CONFLICT DO NOTHING;--> statement-breakpoint

-- allergen_change is append-only: no UPDATE, DELETE or TRUNCATE, for anyone, the app included.
CREATE FUNCTION "allergen_change_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'allergen_change is append-only' USING ERRCODE = '55000';
END
$$;--> statement-breakpoint
CREATE TRIGGER "allergen_change_no_update_delete" BEFORE UPDATE OR DELETE ON "allergen_change"
  FOR EACH ROW EXECUTE FUNCTION "allergen_change_append_only"();--> statement-breakpoint
CREATE TRIGGER "allergen_change_no_truncate" BEFORE TRUNCATE ON "allergen_change"
  FOR EACH STATEMENT EXECUTE FUNCTION "allergen_change_append_only"();--> statement-breakpoint

-- The allergy data on an order is safety-critical: fixed at placement, acknowledged once, never cooked unacknowledged.
CREATE FUNCTION "order_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.day IS DISTINCT FROM OLD.day
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.subtotal_cents IS DISTINCT FROM OLD.subtotal_cents
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.allergy_alert IS DISTINCT FROM OLD.allergy_alert
     OR NEW.allergy_allergens IS DISTINCT FROM OLD.allergy_allergens
     OR NEW.allergy_note IS DISTINCT FROM OLD.allergy_note
     OR NEW.allergy_customer_confirmed IS DISTINCT FROM OLD.allergy_customer_confirmed THEN
    RAISE EXCEPTION 'order is immutable after placement' USING ERRCODE = '55000';
  END IF;
  -- The acknowledgment is written once. Only "who" may later become null, when that staff account is deleted.
  IF OLD.allergy_ack_at IS NOT NULL AND (
       NEW.allergy_ack_at IS DISTINCT FROM OLD.allergy_ack_at
       OR (NEW.allergy_ack_by IS NOT NULL AND NEW.allergy_ack_by IS DISTINCT FROM OLD.allergy_ack_by)) THEN
    RAISE EXCEPTION 'allergy acknowledgment cannot be changed' USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('picked_up', 'cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'order is in a final state' USING ERRCODE = '55000';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'cancelled' AND NEW.allergy_alert AND NEW.allergy_ack_at IS NULL THEN
    RAISE EXCEPTION 'allergy alert not acknowledged' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "order_guard" BEFORE UPDATE ON "order" FOR EACH ROW EXECUTE FUNCTION "order_guard"();--> statement-breakpoint

-- Order lines are snapshots: never updated (deleting an order or its customer still cascades).
CREATE FUNCTION "order_line_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'order lines are immutable' USING ERRCODE = '55000';
END
$$;--> statement-breakpoint
CREATE TRIGGER "order_line_immutable" BEFORE UPDATE ON "order_line" FOR EACH ROW EXECUTE FUNCTION "order_line_immutable"();
