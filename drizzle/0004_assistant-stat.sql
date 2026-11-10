CREATE TABLE "assistant_stat" (
	"day" date NOT NULL,
	"mode" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "assistant_stat_day_mode_pk" PRIMARY KEY("day","mode"),
	CONSTRAINT "assistant_stat_mode_chk" CHECK ("assistant_stat"."mode" in ('allergen', 'general', 'guardrail', 'demo')),
	CONSTRAINT "assistant_stat_count_chk" CHECK ("assistant_stat"."count" >= 0)
);
