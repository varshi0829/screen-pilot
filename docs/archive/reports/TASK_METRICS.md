# TASK_METRICS.md — ScreenPilot Telemetry Reference

Generated: 2026-08-21

---

## Status

This file remains a telemetry reference. The schema below reflects the current implementation, but the project did not run a fresh multi-site metrics collection session in this workspace.

## Storage

All analytics are stored in `chrome.storage.local` under the key `screenpilot_analytics`.

```jsonc
{
  "tasks": [/* up to 100 TaskRecord objects, FIFO eviction */],
  "totalCacheHits": 42,
  "updatedAt": 1750000000000
}
```

## What Is Currently Verified

- Analytics code is present and builds.
- The unit harness covers state transitions, session persistence, recovery, and goal verification.
- The extension bundle still compiles after the planner and storage fixes.

## What Still Needs a Real Session

- Plan success rate
- Gemini calls per task
- Task completion rate across supported websites
- Cache hit rate from real user behavior
- Fallback rate on real pages

## Validation Target

Run browser tasks on Gmail, Google Docs, GitHub, Jira, Notion, LinkedIn, Linear, and one unknown site, then record:

- plan success rate
- Gemini calls per task
- completion rate
- cache hit rate
- fallback rate

Until that run happens, this file should be treated as a reference, not a measured report.
