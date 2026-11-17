-- metadata
CREATE TABLE IF NOT EXISTS "directory_sessions" (
	"id" text NOT NULL,
	"user_id" text NOT NULL,
	"idp_sid" text,
	"refresh_token_ciphertext" text,
	"refresh_token_iv" text,
	"refresh_token_tag" text,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"refreshed_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "directory_sessions_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "directory_sessions_user_idx" ON "directory_sessions" USING btree ("user_id");
