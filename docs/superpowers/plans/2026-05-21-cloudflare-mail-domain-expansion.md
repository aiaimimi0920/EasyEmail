# Cloudflare Mail Domain Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six new Cloudflare zones to EasyEmail's `cloudflare_temp_email` domain pool and make them usable for both root and fixed-subdomain mailbox creation.

**Architecture:** Update the root `config.yaml` as the source of truth, rely on the existing render pipeline to materialize derived service/worker configs, then run Cloudflare Email Routing state sync so the worker catch-all is attached for the new zones.

**Tech Stack:** PowerShell, Python render scripts, Cloudflare Email Routing API, `cloudflare_temp_email` worker config.

---

### Task 1: Expand Root Domain Configuration

**Files:**
- Modify: `C:\Users\Public\nas_home\AI\GameEditor\EasyEmail\config.yaml`

- [x] Add the six new zone roots to `cloudflareMail.worker.vars.DEFAULT_DOMAINS`.
- [x] Add the six new zone roots and wildcard entries to `cloudflareMail.worker.vars.DOMAINS`.
- [x] Add the six new zone roots to `cloudflareMail.worker.vars.RANDOM_SUBDOMAIN_DOMAINS`.
- [x] Add the six new zone roots and wildcard entries to `cloudflareMail.routing.plan.domains`.
- [x] Add the six new zone roots to `cloudflareMail.routing.plan.randomSubdomainDomains`.

### Task 2: Render Derived Configs

**Files:**
- Modify indirectly via render: `C:\Users\Public\nas_home\AI\GameEditor\EasyEmail\deploy\service\base\config\config.yaml`
- Modify indirectly via render: `C:\Users\Public\nas_home\AI\GameEditor\EasyEmail\.tmp\cloudflare_temp_email.wrangler.toml`

- [x] Run `pwsh .\scripts\render-derived-configs.ps1`.
- [x] Confirm the rendered service config contains the new root domains.
- [x] Confirm the rendered worker TOML contains the new `DOMAINS`, `DEFAULT_DOMAINS`, and `RANDOM_SUBDOMAIN_DOMAINS`.

### Task 3: Sync Cloudflare Email Routing State

**Files:**
- Use existing deploy scripts only

- [x] Run `pwsh .\scripts\deploy-cloudflare-email.ps1 -ForceRoutingStateSync`.
- [ ] Verify the deploy script finishes without error.
- [x] Verify the target zones now point catch-all routing at worker `cloudflare_temp_email`.

### Task 4: Live Validation

**Files:**
- Read-only validation against live worker and Cloudflare APIs

- [x] Verify `https://mail.aiaimimi.com/open_api/settings` includes the newly added roots.
- [x] Verify root mailbox creation succeeds for at least one newly added zone root.
- [x] Verify fixed-subdomain mailbox creation succeeds for at least one new wildcard-enabled zone.
- [x] Record the live-created addresses and JWTs in `.tmp` for follow-up OTP polling.

## Execution Notes

- The full `deploy-cloudflare-email.ps1 -ForceRoutingStateSync` path timed out in
  this environment, so the routing rollout was completed by running the
  underlying `sync_email_routing_state.py` script directly against the six new
  zones.
- The GitHub-hosted release path must persist the same domain-pool expansion in
  the granular `EASYEMAIL_CF_DOMAINS`,
  `EASYEMAIL_CF_DEFAULT_DOMAINS`, and
  `EASYEMAIL_CF_RANDOM_SUBDOMAIN_DOMAINS` repository secrets.
