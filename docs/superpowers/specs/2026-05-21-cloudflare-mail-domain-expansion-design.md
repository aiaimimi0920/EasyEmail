# Cloudflare Mail Domain Expansion Design

**Date:** 2026-05-21

**Approved Goal:** Extend the EasyEmail `cloudflare_temp_email` domain pool to include six additional Cloudflare zones and ensure they support both root-address creation and fixed-subdomain forms following the existing `slime.indevs.in` pattern.

## Scope

Add these zone roots to the mailbox system:

- `aiaimimi.pp.ua`
- `artloom.cc.cd`
- `neuroloom.pp.ua`
- `yamiyu.cc.cd`
- `yamiyu.pp.ua`
- `yamiyu.us.ci`

For each new zone root:

- support root addresses such as `user@yamiyu.cc.cd`
- support fixed subdomains through the existing wildcard + `SUBDOMAIN_LABEL_POOL` model, such as `user@amber.yamiyu.cc.cd`

## Architecture

The root source of truth remains `config.yaml`.

The effective mailbox behavior is derived from three cooperating layers:

1. `cloudflareMail.routing.plan.domains`
2. `cloudflareMail.worker.vars.DEFAULT_DOMAINS` / `DOMAINS` / `RANDOM_SUBDOMAIN_DOMAINS`
3. rendered runtime config for `serviceBase.runtime.providers.cloudflareTempEmail`

The deploy/render scripts already merge and materialize these layers. The safest implementation is to update the root config with the new zones, render derived configs, then run Cloudflare Email Routing state sync so the worker catch-all is attached for the newly included zones.

For GitHub-hosted publication and deploy flows, the effective domain pool is
materialized from the granular `EASYEMAIL_CF_*` Actions secrets. That means the
operational rollout must persist the new domain pool into:

- `EASYEMAIL_CF_DOMAINS`
- `EASYEMAIL_CF_DEFAULT_DOMAINS`
- `EASYEMAIL_CF_RANDOM_SUBDOMAIN_DOMAINS`

## Behavior Rules

Each new root domain must be represented in the same way as existing wildcard-enabled domains:

- exact root domain entry, e.g. `yamiyu.cc.cd`
- wildcard entry, e.g. `*.yamiyu.cc.cd`
- inclusion in the random-subdomain root pool where we want the worker to generate fixed subdomain forms using `SUBDOMAIN_LABEL_POOL`

The existing `SUBDOMAIN_LABEL_POOL` is reused unchanged.

## Verification Requirements

Implementation is only considered successful after:

1. rendered configs include the six new roots and their wildcard forms
2. Cloudflare routing state is synced for the six zones
3. `open_api/settings` exposes the new roots
4. live mailbox creation succeeds for:
   - at least one root form, e.g. `tmptdvltlj5br8@yamiyu.cc.cd`
   - at least one fixed-subdomain form, e.g. `tmptdvltlj5br8@amber.yamiyu.cc.cd`

## Constraints

- preserve current `SUBDOMAIN_LABEL_POOL`
- prefer minimal root-config changes over code changes
- only change code if config-only execution proves insufficient
