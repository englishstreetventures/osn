CREATE TABLE `wedding_invite_customisations` (
	`wedding_id` text PRIMARY KEY NOT NULL,
	`hero_title` text,
	`hero_subtitle` text,
	`story_eyebrow` text,
	`story_heading` text,
	`story_body` text,
	`hero_image_key` text,
	`story_image_key` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON UPDATE no action ON DELETE cascade
);
