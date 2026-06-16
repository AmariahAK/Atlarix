-- v13.6: `/` slash-command system removed (prompt-templates duplicated the work-mode
-- picker; the editor was never surfaced). Drop the now-unused local table.
DROP TABLE IF EXISTS `custom_commands`;
