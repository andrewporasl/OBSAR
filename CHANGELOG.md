# Changelog

All notable changes to OBSAR are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.2.1] - 2026-10-11

### Fixed
- With an empty search box you can now scroll through the whole library. Files load in pages of 120 as you reach the bottom, newest first, with a running "x of y" count; before, only the 80 most recent files were shown.

## [0.2.0] - 2026-10-11

First public release.

### Added
- Search any number of folders by what the files look like (SigLIP2), what they say (Qwen2.5-VL captions and text recognition) and their filenames.
- Native drag-out: drop a tile straight into Explorer, Discord, Slack, Premiere or a browser. Multi-select with Ctrl and Shift.
- Live sync: new, changed, renamed and deleted files are picked up within seconds; every library re-syncs on launch.
- Settings: libraries (resync, rebuild, pause, remove with keep-or-delete index), storage breakdown with locations and free space, general options, About.
- First-run setup that installs the Python runtime, AI libraries and models to a drive you choose, with progress inside the app. Captions are optional and default off without an NVIDIA GPU.
- Detail panel plays videos and opens images full-size. Arrow keys move through results.
- Global shortcut `Ctrl+Shift+Space`, tray icon, remembered window size.
- Automatic updates from GitHub Releases.
- Log files for troubleshooting (`logs/` next to the index).
