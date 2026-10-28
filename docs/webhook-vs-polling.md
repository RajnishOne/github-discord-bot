# Webhook vs. Polling Architecture in GitHub Discord Bot

GitHub Discord Bot adopts a **hybrid monitoring architecture** to balance real-time delivery speed with broad repository coverage across the GitHub ecosystem:
1. **GitHub App Webhooks** for repositories owned by the user or under the user's GitHub App installation.
2. **Conditional Public API Polling** for any other external public repository across GitHub.

This document outlines the architectural trade-offs, differences in notification latency, event coverage, rate limits, access boundaries, and deduplication guarantees.

---

## 1. High-Level Comparison Matrix

| Dimension | Webhook Monitoring (`monitoring_type: webhook`) | Polling Adapter (`monitoring_type: polling`) |
| :--- | :--- | :--- |
| **Applicability** | Owned repositories / Repositories with installed GitHub App | Any public GitHub repository (`owner/repo`) |
| **Notification Latency** | **Sub-second (100ms – 800ms)** | **Interval-bound (typically 1 – 5 minutes)** |
| **Event Delivery Mechanism** | GitHub pushes HTTP POST to `/api/webhooks/github` | Scheduled worker issues conditional GET requests |
| **API Rate Limit Cost** | **0 API requests consumed** | Consumes API quota (minimized via `304 Not Modified`) |
| **Payload Detail** | Full payload (complete commit list, diffs, full Markdown body) | Standard Events API payload (may lack full commit diffs) |
| **Event Retention Window** | Real-time push stream | Recent 300 events or up to 90 days on GitHub Events API |
| **Prerequisites** | GitHub App installed with repo/organization permissions | None (Zero integration required by repository owner) |
| **Downtime Recovery** | Missed events if endpoint was down during push | Self-healing: Next poll cycle fetches past unseen event IDs |

---

## 2. Notification Latency Analysis

### Webhook-Based Monitoring (Push)
- **Flow:** When a developer pushes commits, publishes a release, or opens a pull request, GitHub immediately enqueues a webhook delivery and executes an HTTP POST request to GitHub Discord Bot's `/api/webhooks/github`.
- **Latency:**
  $$\text{Latency} = T_{\text{GitHub Hook Dispatch}} + T_{\text{Network Roundtrip}} + T_{\text{Normalization}} + T_{\text{Discord Webhook Post}}$$
  $$\text{Typical Total Latency} \approx \mathbf{150\text{ms} - 800\text{ms}}$$
- **User Impact:** Notifications arrive in Discord almost concurrently with the action taking place on GitHub.

### Polling-Based Monitoring (Pull)
- **Flow:** GitHub Discord Bot queries the GitHub Events API (`GET /repos/{owner}/{repo}/events`) on a configured interval (default: 300 seconds / 5 minutes).
- **Latency:**
  $$\text{Latency} \in [0, T_{\text{Interval}}] + T_{\text{Polling Cycle Execution}}$$
  $$\text{Typical Total Latency} \approx \mathbf{0 - 300\text{ seconds (Average 150 seconds)}}$$
- **User Impact:** Notifications are batched and delivered on the next scheduled poll run. For fast-breaking security releases or critical PR reviews, users can configure a tighter interval (e.g., 60 seconds) or trigger manual on-demand polling.

---

## 3. Event Coverage & Payload Differences

### 1. Event Coverage
- **Webhook Integration:** GitHub Webhooks support over 40 fine-grained event types, including `workflow_run`, `discussion`, `branch_protection_rule`, `repository_vulnerability_alert`, and full audit actions.
- **Public Events API:** The public GitHub `/events` endpoint publishes a curated subset of activity (`PushEvent`, `ReleaseEvent`, `PullRequestEvent`, `IssuesEvent`, `WatchEvent`, `ForkEvent`, `CreateEvent`, `DeleteEvent`, `IssueCommentEvent`).
- **GitHub Discord Bot Normalization:** GitHub Discord Bot normalizes the top 6 high-value notification categories across both pipelines:
  - 🚀 **Releases** (`release` / `ReleaseEvent`)
  - 🔀 **Pull Requests** (`pull_request` / `PullRequestEvent`)
  - 🐛 **Issues** (`issues` / `IssuesEvent`)
  - 💻 **Pushes & Commits** (`push` / `PushEvent`)
  - ⭐ **Stars** (`watch` / `WatchEvent`)
  - 🍴 **Forks** (`fork` / `ForkEvent`)

### 2. Payload Depth
- **Webhooks:** Payloads can be up to 25 MB and include the complete list of commits in a push, author and committer metadata, detailed patch summaries, and complete issue/PR markdown bodies.
- **Polling Events:** Payloads are capped by GitHub. For large pushes, `PushEvent` provides commit summaries and the head SHA. When full diffs or release details are needed, GitHub Discord Bot extracts the relevant identifiers and provides direct deep links to GitHub.

---

## 4. Rate Limiting, Caching, and Efficiency

External repositories cannot send webhooks without owner consent. Therefore, GitHub Discord Bot queries GitHub's public REST API. To prevent rate exhaustion:

### 1. Conditional Requests (ETags)
- When polling `/repos/{owner}/{repo}/events`, GitHub Discord Bot persists the `ETag` header in SQLite (`last_etag`).
- Subsequent requests pass `If-None-Match: <last_etag>`.
- If no new activity occurred, GitHub returns **HTTP 304 Not Modified**.
- A 304 response does not return response bodies, saves bandwidth, and executes in milliseconds.

### 2. Quota Management
- **Unauthenticated requests:** Capped at 60 requests per hour per IP.
- **Authenticated requests:** Capped at 5,000 requests per hour per user (or 15,000 for GitHub Enterprise).
- GitHub Discord Bot automatically monitors `x-ratelimit-remaining`, `x-ratelimit-reset`, and `Retry-After`.
- If the remaining quota falls below 5%, the scheduler automatically applies exponential backoff to preserve critical operations.

---

## 5. Unified Deduplication Guarantee

Because a repository might theoretically transition from polling to webhook monitoring (or receive both if an app is installed later), GitHub Discord Bot enforces a **deterministic deduplication key**:

$$\text{dedupKey} = \text{repository} + \text{":"} + \text{category} + \text{":"} + \text{sourceIdentifier}$$

Examples:
- Release: `expressjs/express:release:1029384`
- Pull Request: `facebook/react:pr:28192:opened`
- Push: `torvalds/linux:push:a1b2c3d4e5f6...`

When an event arrives:
1. `EventPipeline` queries `processed_events` in SQLite for `dedupKey`.
2. If the key already exists, the event is immediately discarded with `deduplicated: true`.
3. If new, the event is formatted into a rich Discord embed, delivered, and checkpointed.

This guarantees that **duplicate notifications are never sent to Discord**, regardless of which pipeline captured the event first.

---

## 6. Security and Ownership Integrity

- **Private Repository Rejection:** GitHub Discord Bot strictly rejects private repositories at verification time (`data.private === true`). Private repos are never stored in the database or polled.
- **Clear User Intent:** The UI explicitly labels external repositories as `🔄 Polling Adapter` with interval indicators, and never implies external repositories can deliver real-time webhooks without the repository owner installing GitHub Discord Bot.
