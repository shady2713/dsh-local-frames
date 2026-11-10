# local-frames skill

Use the `lf_` tools for the local-frames plugin. Do not write the plugin database or settings directly.

Call order: `lf_status → lf_target_add → lf_collect_start（可用 paths 传首批视频）→ lf_video_add（追加）→ lf_status 汇报 → lf_export`.

- `lf_status` — read-only: settings without secrets, object list, task progress, file funnel including duplicate-frame skips, data-directory usage, and the environment check (Node/npm/ffmpeg/ffprobe/DSH/Git).
- `lf_target_add` — add one object with a unique active name, per-language aliases and a one-sentence definition.
- `lf_collect_start` — create and start the single collection task. `targetIds` omitted means every unarchived object; `paths` may carry the first batch of local video paths.
- `lf_video_add` — add one absolute local video file or directory path to the running or paused task. Source files are only read and are never moved, renamed or modified.
- `lf_collect_control` — pause, resume (also retries `ERROR` files) or cancel a task.
- `lf_export` — export qualified frames of a task: `images/`, `labels.csv`, `sources.csv`, `README.txt`.

Rules the agent must keep:

- Only local paths are accepted, and only under the configured allow-root list. Never invent URLs, authors, licenses or regions for local files.
- The model judges the user-defined objects only. Do not add aerial/real/quality/watermark judgments.
- `1` means the model explicitly saw the object with `CLEAR`/`SMALL` visibility; `0` only when the model explicitly answered `ABSENT`; `UNSURE`, `TINY` and `OCCLUDED` stay empty.
- Duplicate frames (`DUPLICATE`) are never sent to the model, never labeled and never exported.
- Settings are edited on the plugin's settings pages; secrets and cookies never enter SQLite, logs or exports.
