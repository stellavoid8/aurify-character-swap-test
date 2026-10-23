CREATE TYPE "public"."job_mode" AS ENUM('photo', 'video');--> statement-breakpoint
CREATE TYPE "public"."media_type" AS ENUM('image', 'video');--> statement-breakpoint
ALTER TYPE "public"."job_stage" ADD VALUE 'animating' BEFORE 'done';--> statement-breakpoint
ALTER TYPE "public"."round_kind" ADD VALUE 'animation';--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "video_url" text;--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "segment_index" integer;--> statement-breakpoint
ALTER TABLE "job_rounds" ADD COLUMN "units" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "mode" "job_mode" DEFAULT 'photo' NOT NULL;--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN "media_type" "media_type" DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN "video_url" text;--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN "fps" real;--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN "frame_count" integer;--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN "keyframe" text;