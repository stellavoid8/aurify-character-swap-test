CREATE TYPE "public"."call_status" AS ENUM('ok', 'error');--> statement-breakpoint
CREATE TYPE "public"."candidate_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_stage" AS ENUM('analyzing', 'generating', 'ranking', 'refining', 'done');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'timed_out');--> statement-breakpoint
CREATE TYPE "public"."provider" AS ENUM('fal', 'anthropic', 'local');--> statement-breakpoint
CREATE TYPE "public"."round_kind" AS ENUM('generation', 'refinement');--> statement-breakpoint
CREATE TYPE "public"."round_status" AS ENUM('running', 'succeeded', 'failed', 'timed_out');--> statement-breakpoint
CREATE TYPE "public"."upload_kind" AS ENUM('template', 'user');--> statement-breakpoint
CREATE TYPE "public"."upload_status" AS ENUM('pending', 'ok', 'rejected');--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"kind" "round_kind" NOT NULL,
	"parent_candidate_id" uuid,
	"model" text NOT NULL,
	"seed" integer NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"fal_request_id" text,
	"status" "candidate_status" DEFAULT 'pending' NOT NULL,
	"image_url" text,
	"identity_score" real,
	"action_score" real,
	"rank" integer,
	"scorer" text,
	"error_code" text,
	"latency_ms" integer,
	"cost_usd_micros" bigint,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "candidates_fal_request_id_unique" UNIQUE("fal_request_id")
);
--> statement-breakpoint
ALTER TABLE "candidates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "job_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"kind" "round_kind" NOT NULL,
	"status" "round_status" DEFAULT 'running' NOT NULL,
	"stage_timings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "job_rounds_job_round_unique" UNIQUE("job_id","round")
);
--> statement-breakpoint
ALTER TABLE "job_rounds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"stage" "job_stage" DEFAULT 'analyzing' NOT NULL,
	"template_upload_id" uuid NOT NULL,
	"user_upload_ids" uuid[] NOT NULL,
	"reference_upload_id" uuid,
	"analysis" jsonb,
	"flags" jsonb DEFAULT '{"crossGender":false,"crossAge":false,"multiPerson":false,"subjectLabel":null}'::jsonb NOT NULL,
	"prompt" text,
	"current_round" integer DEFAULT 0 NOT NULL,
	"chosen_candidate_id" uuid,
	"notices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"deadline_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "provider_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"round_id" uuid,
	"candidate_id" uuid,
	"provider" "provider" NOT NULL,
	"model" text NOT NULL,
	"stage" text NOT NULL,
	"request_id" text,
	"status" "call_status" NOT NULL,
	"latency_ms" integer NOT NULL,
	"cost_usd_micros" bigint DEFAULT 0 NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" "upload_kind" NOT NULL,
	"status" "upload_status" DEFAULT 'pending' NOT NULL,
	"reject_code" text,
	"raw_url" text NOT NULL,
	"url" text,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" integer NOT NULL,
	"faces" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject_face_index" integer,
	"quality_score" real,
	"embedding" real[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "uploads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"request_id" text NOT NULL,
	"candidate_id" uuid,
	"status" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "webhook_events_provider_request_status_unique" UNIQUE("provider","request_id","status")
);
--> statement-breakpoint
ALTER TABLE "webhook_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_round_id_job_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."job_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_parent_candidate_id_candidates_id_fk" FOREIGN KEY ("parent_candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_rounds" ADD CONSTRAINT "job_rounds_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_template_upload_id_uploads_id_fk" FOREIGN KEY ("template_upload_id") REFERENCES "public"."uploads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_reference_upload_id_uploads_id_fk" FOREIGN KEY ("reference_upload_id") REFERENCES "public"."uploads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD CONSTRAINT "provider_calls_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "candidates_round_idx" ON "candidates" USING btree ("round_id");--> statement-breakpoint
CREATE INDEX "job_rounds_session_started_idx" ON "job_rounds" USING btree ("session_id","started_at");--> statement-breakpoint
CREATE INDEX "job_rounds_started_idx" ON "job_rounds" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "jobs_session_created_idx" ON "jobs" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "uploads_session_created_idx" ON "uploads" USING btree ("session_id","created_at");