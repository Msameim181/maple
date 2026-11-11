-- metadata
CREATE TABLE IF NOT EXISTS "directory_invitations" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"invited_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "directory_invitations_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "directory_members" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "directory_members_pkey" PRIMARY KEY ("org_id", "user_id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "directory_orgs" (
	"id" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "directory_orgs_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "directory_users" (
	"id" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean NOT NULL,
	"name" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "directory_users_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "directory_invitations_email_idx" ON "directory_invitations" USING btree ("email");
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "directory_invitations_org_email_idx" ON "directory_invitations" USING btree ("org_id", "email");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "directory_members_user_idx" ON "directory_members" USING btree ("user_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "directory_users_email_idx" ON "directory_users" USING btree ("email");
