---
title: "Cire Wiki — Map of Content"
tags: [index]
aliases: [home, map of content, MOC]
related: []
last-reviewed: 2026-07-31
---

# Cire Wiki

Map of Content for the Cire wedding invite project.

## Quick Links

- [[TODO]] — progress tracking, backlogs, deferred decisions

## Architecture

- [[monorepo-structure]] — cire/web, cire/organiser, cire/api, cire/db layout and dependency flow (inside the OSN monorepo)
- [[invite-builder]] — organiser-editable invite images + copy (slots, storage, API, guest rendering)
- [[platform-plan]] — build plan for the wedding-management platform (guests/events decoupled from the invite, vendors + availability, pricing estimates, budget, checklist, seating, comms)
- [[guest-event-editor]] — plan for the interactive events + guests editor alongside the CSV schema (round-trip export, before-image revert, shared pre-save checks)
- [[consent]] — site-wide cookie/third-party consent: categories, the vendor registry, the `cire_consent` record, and how to add a gated third party
- [[drag-and-drop]] — solid-dnd for drag-to-reorder: library trade-off (vs neodrag/dnd-kit) and its staleness risk, handle-vs-directive wiring, and the keyboard + announcement path we own
- [[host-portal-layout]] — how the organiser portal decides widths: the `page-frame` measure, intrinsic `auto-grid` card grids, the named container queries and every layout switch they drive

## Systems

- [[systems/overview]] — the organiser overview surface
- [[budget]] — budget lines and spend roll-ups
- [[checklist-tasks]] — the planning checklist / tasks module
- [[entitlements]] — per-wedding capability gates
- [[feature-flags]] — GrowthBook flags, key-optional and fail-safe
- [[invite-designs]] — the invite design selector
- [[rsvp-deadline]] — the "respond by" date, the instant it resolves to, and how the invite locks past it
- [[vendors]] — vendor directory, CRM, and the email-verification claim

## Observability

- [[overview]] — platform-native observability, structured logging, redaction rules

## Conventions

- [[contributing]] — branch strategy, commit signing, hooks, observability rules
- [[review-findings]] — severity prefixes, four-field format, backlog maintenance

## Changelog

- [[completed-features]] — shipped feature work
- [[security-fixes]] — resolved security findings
- [[performance-fixes]] — resolved performance findings

## Runbooks

_No runbooks yet. Add one per incident pattern or operational procedure._
