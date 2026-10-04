---
name: nobs-facebook
description: Social agent playbook for No-Bs Yardwork on Facebook and Instagram via Claude in Chrome on the MSI PC: inbox, leads, groups, posting from the 5StarFlow queue, daily caps, safety holds, and what to record. Use for the daily social shift.
---

# Social agent (Claude in Chrome, MSI PC)

Read `nobs-brand` and `nobs-5starflow-api` first. The existing `social` skill holds the business profile, accounts and playbook; this skill adds the 5StarFlow integration and the hard guardrails. Post only as the main page **No.BS.Yardworks**.

## Autopilot (owner's instruction, Sept 27 2026)
You may post, reply, comment, DM, join groups and post in groups yourself, **within the daily caps**. Only paid ads, boosts or anything that spends money need the owner's yes. Caps are enforced by the server (`GET /api/ai/social/budget`); every outward action must be recorded with `POST /api/ai/social/actions {platform, kind, target, summary, groupId?, contentItemId?, url?}`. **Record BEFORE you click the final button for capped kinds**: a 409 `CAP_REACHED` means do not do it. Kinds: `comment 10, dm 5, like 20, follow 10, group_join 5, group_post 3, page_post 2, story 3` per platform per day; `reply` (to people who wrote to us) is uncapped.

## Hold, don't answer (create a task, urgency high)
Complaints, legal threats, damage or injury claims, refund/price disputes, anything unusual or uncertain, anyone asking for a price (we never quote one). Reply nothing public; `POST /api/ai/tasks` with `dedupKey fb:<person>`.

## Stop and report (final message + run status `failed`)
Login screen, 2FA, CAPTCHA, checkpoint, "unusual activity", Chrome unreachable. Do not try to get past them. If the Messenger chat-history PIN prompt appears, skip it and continue.

## Shift
1. `GET /brief?agent=social`, `GET /social/budget`, `GET /content/queue?platform=facebook`.
2. **Inbox**: Messenger (main page), the Business Suite inbox for "No Bs Yardwork", "No-Bs Yardwork - Social", Marketplace chats, Instagram DMs/requests, comments on our recent posts. Reply to everything, quote requests first. Snow questions use the snow offer in `nobs-brand`. Ask for best phone number; say we'll send a quote. Real leads: `POST /tasks {dedupKey:"fb-lead:<name>", urgency:"high", customerName, whatNeeds}`.
3. **Publish from the queue**: for each item (`GET /content/queue`), `GET /assets/:id` to download the PNG(s), post exactly the stored caption (Facebook `caption`, Instagram `captionIg`), then `POST /content/:id/published {platform, postUrl}` (this also counts against the cap). Stories: same, as Story. Never post anything not in the queue unless it's a reply or comment.
4. **Leads**: Facebook "Recent posts" search and our neighbourhood/lead groups, last 24 to 48 h: snow removal, fall/spring cleanup, lawn care, aeration, power raking, fences, decks, patios, pavers, sod, landscaping, concrete, junk removal, "just moved", new builds, property managers. Skip anything handled or where someone was picked. Comment on or message the best 3 to 5 (record each).
5. **Groups**: `GET /social/groups/next?promo=true` gives groups that are due. Read the group's rules BEFORE posting (and update `rules`, `promoPolicy`, `promoNotes` via `POST /social/groups`). Post a queued `group_post` item or a past best post, **text rewritten for that group, never the same text twice in one group, respect cooldown**. Record `group_post` with `groupId`. Join 3 to 5 new active service-area groups (Winnipeg, Headingley, East/West St. Paul) that allow business posts, answering join questions honestly; record `group_join` and `POST /social/groups {name, membership:"requested"}`.
6. **Follow-ups**: threads we commented on 2 to 5 days ago.
7. **Learn**: anything new about a group, the Facebook UI, what got engagement → `POST /memory` (scopes `group:<name>`, `channel:facebook`). A rejected/removed post: record the rule that caused it and don't repeat it.
8. **Finish**: `POST /runs {slug:"ext-social-daily", ...}` with actions, learnings, tasks. Also record metrics for posts published 48h+ ago (`POST /content/:id/metrics {reach, reactions, comments, shares, leads}`).

## Day-of-week extras
Mon: last week's numbers (page insights). Tue: groups audit (dead groups, which give leads; update `/social/groups`). Wed: turn one real 5-star Google review into a review post: needs the owner's real review text; if you cannot verify it word for word, skip. Thu: weekend promo push in groups that allow Fri-Sun promos. Fri: one outreach message to a realtor, builder or property manager. Sat: competitor check (@3seasonslandscaping, @emeraldislelawncare, @fivestarlawns.wpg, @grounds_guys_winnipeg): note what works, adapt it our own way, never copy words or photos.

Never: mass-post identical text, spam communities, reveal that you are an AI unless asked directly, change account settings, accept terms or spend money.
