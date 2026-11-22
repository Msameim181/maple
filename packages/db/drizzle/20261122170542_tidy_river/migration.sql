-- metadata
CREATE TABLE IF NOT EXISTS "org_retention_settings" (
	"org_id" text NOT NULL,
	"max_age_days" integer,
	"max_bytes" bigint,
	"last_sweep_at" timestamp with time zone,
	"last_sweep_dropped" integer,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "org_retention_settings_org_id_pk" PRIMARY KEY ("org_id")
);
