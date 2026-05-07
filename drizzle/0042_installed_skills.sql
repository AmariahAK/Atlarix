-- Custom SQL migration file, put your code below! --

CREATE TABLE `installed_skills` (
  `id` text NOT NULL,
  `name` text NOT NULL,
  `version` text NOT NULL,
  `author` text NOT NULL,
  `description` text NOT NULL,
  `tags` text NOT NULL,
  `compatible_modes` text NOT NULL,
  `installed_at` integer NOT NULL,
  `scope` text NOT NULL,
  `workspace_path` text,
  `cached_files` text NOT NULL,
  PRIMARY KEY(`id`, `scope`, `workspace_path`)
);
