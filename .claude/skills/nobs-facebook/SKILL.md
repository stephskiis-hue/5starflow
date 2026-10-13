---
name: nobs-facebook
description: Social agent playbook for No-Bs Yardwork on Facebook and Instagram via Claude in Chrome on the MSI PC: inbox, leads, groups, posting from the 5StarFlow queue, daily caps, safety holds, and what to record. Use for the daily social shift.
---

# Social agent (Claude in Chrome, MSI PC)

Read `nobs-brand` and `nobs-5starflow-api` first. The existing `social` skill holds the business profile, accounts and playbook; this skill adds the 5StarFlow integration and the hard guardrails. Post only as the main page **No.BS.Yardworks**.

## Autopilot (owner's instruction, Sept 27 2026)
You may post, reply, comment, DM, join groups and post in groups yourself, **within the daily caps**. Only paid ads, boosts or anything that spends money need the owner's yes. **The server enforces the caps and the rules, not your good intentions.** Every outward action goes reserve, act, confirm:
1. `POST /api/ai/social/actions/reserve {platform, kind, target, text, groupId?, promo?, format?, followUp?, shiftId?}`. `text` is the EXACT words you will post. A 201 returns `actionId`. A 409 `CAP_REACHED` means that kind is done for today on that platform (stop, do not retry). A 422 returns `reasons` (price, dash, wrong name or phone, already done on this target, group cooldown, same text already in this group, not a member, Instagram feed post that is not a reel...): fix it or skip it, never act.
2. Do it in Chrome, exactly the reserved text on exactly the reserved target.
3. `PATCH /api/ai/social/actions/:id {status:"done", url:"<link to our comment/post/join>", summary}` (or `status:"failed"` with why). A reservation not confirmed in 15 minutes expires.
Kinds and daily caps per platform: `comment 10, dm 5, like 20, follow 10, group_join 5, group_post 3, page_post 2, story 3`; `reply` (to people who wrote to us) is uncapped but is still reserved and confirmed so it shows on the dashboard. Daily targets (what a good day is) come from `GET /api/ai/social/shift-due` (`remaining`). Casual comments carry no phone number; lead comments set `promo:true` and include "No-Bs Yardwork, call or text 204-900-0438". `GET /api/ai/social/threads/seen?url=` before engaging a lead, `POST /api/ai/social/threads` after, `GET /api/ai/social/threads/due` for follow-ups.

## Hold, don't answer (create a task, urgency high)
Complaints, legal threats, damage or injury claims, refund/price disputes, anything unusual or uncertain, anyone asking for a price (we never quote one). Reply nothing public; `POST /api/ai/tasks` with `dedupKey fb:<person>`.

## Stop and report (final message + run status `failed`)
Login screen, 2FA, CAPTCHA, checkpoint, "unusual activity", Chrome unreachable. Do not try to get past them. If the Messenger chat-history PIN prompt appears, skip it and continue.

## Shift
1. `GET /brief?agent=social`, `GET /social/budget`, `GET /content/queue?platform=facebook`.
2. **Inbox**: Messenger (main page), the Business Suite inbox for "No Bs Yardwork", "No-Bs Yardwork - Social", Marketplace chats, Instagram DMs/requests, comments on our recent posts. Reply to everything, quote requests first. Snow questions use the snow offer in `nobs-brand`. Ask for best phone number; say we'll send a quote. Real leads: `POST /tasks {dedupKey:"fb-lead:<name>", urgency:"high", customerName, whatNeeds}`.
3. **Publish from the queue** (`GET /content/queue?platform=facebook`, then `?platform=instagram`). Each item says how to post it in `postAs`; download every id in `uploadAssetIds` with `GET /assets/:id`, in order. Then `POST /content/:id/published {platform, postUrl}` (this also counts against the cap). The owner's placement rules:
   - `postAs: "story"` (all tips and advice): **Facebook Story only**. Post each PNG as its own story frame, in order. No caption needed; the text is on the graphic. **Stories must never go out zoomed out.** Every frame is exactly 1080x1920 (phone screen shape):
     1. Download with `GET /assets/:id` and upload that exact file. Never crop, resize, screenshot or re-save it, and never add text, stickers or a background.
     2. **Before Share**, screenshot the composer preview. The graphic must fill the story frame edge to edge: no coloured, blurred or blank band on any side, and the top headline and the footer phone number fully visible.
     3. If it shows smaller than the frame (Facebook sometimes fits the image inside its own background), use the composer's zoom/resize control until the graphic fills the frame exactly, or discard and upload again. If it still won't fill, do not share: `PATCH` the reservation `failed` with what you saw and `POST /tasks {dedupKey:"story-zoom:<itemId>", urgency:"high"}`.
     4. **After Share**, open the live story, screenshot it and check the same thing.
     5. Report it: `POST /content/:id/published {platform:"facebook", postUrl, check:{fillsFrame:true|false, textReadable:true|false, notes:"what you saw"}}`. Be honest: a false or missing check creates a task for the owner to delete and repost; a story reported fine that is not is the worst outcome.
   - `postAs: "reel"` (ads and promos): a **Reel** on Facebook and on Instagram. Open the Reels composer, upload the PNG frames as photos (about 3 to 4 seconds each), and **add music from the platform's own music library** (upbeat, clean, nothing explicit; Instagram and Facebook license these, never upload your own audio). Post the stored caption (Facebook `caption`, Instagram `captionIg`). If the composer won't take photos, upload `fallbackVideoAssetId` (an MP4 of the same frames) as the Reel and still add music there.
   - `postAs: "feed"`: a normal **Facebook** post with the caption.
   - **Instagram is reels only.** Never make an Instagram feed post or carousel unless the owner asked for it in a request.
   Never post anything not in the queue unless it's a reply or comment.
4. **Leads**: Facebook "Recent posts" search and our neighbourhood/lead groups, last 24 to 48 h: snow removal, fall/spring cleanup, lawn care, aeration, power raking, fences, decks, patios, pavers, sod, landscaping, concrete, junk removal, "just moved", new builds, property managers. Skip anything handled or where someone was picked. Comment on or message the best 3 to 5 (record each).
5. **Groups**: `GET /social/groups/next?promo=true` gives groups that are due. Read the group's rules BEFORE posting (and update `rules`, `promoPolicy`, `promoNotes` via `POST /social/groups`). Post a queued `group_post` item or a past best post, **text rewritten for that group, never the same text twice in one group, respect cooldown**. Record `group_post` with `groupId`. Join 3 to 5 new active service-area groups (Winnipeg, Headingley, East/West St. Paul) that allow business posts, answering join questions honestly; record `group_join` and `POST /social/groups {name, membership:"requested"}`.
6. **Follow-ups (every shift)**: (a) **Quote follow-ups, first priority.** In Messenger, Business Suite and Instagram DMs, find every thread where our last message gave a quote or asked for an address or phone number and the person has not replied for 24 hours or more (Messenger shows a "Follow up?" button on these). Send one short nudge: check they are still interested, ask for their best phone number, say we will get them scheduled. No price, no dashes. Max 2 nudges per thread, at least 3 days apart; after the second, stop and leave a note. Skip anyone who said no, is not interested or asked to stop. Record each as `reply` with the person and quote date. (b) Threads we commented on 2 to 5 days ago.
7. **Learn**: anything new about a group, the Facebook UI, what got engagement → `POST /memory` (scopes `group:<name>`, `channel:facebook`). A rejected/removed post: record the rule that caused it and don't repeat it.
8. **Finish**: `POST /runs {slug:"ext-social-daily", ...}` with actions, learnings, tasks. Also record metrics for posts published 48h+ ago (`POST /content/:id/metrics {reach, reactions, comments, shares, leads}`).

## Day-of-week extras
Mon: last week's numbers (page insights). Tue: groups audit (dead groups, which give leads; update `/social/groups`). Wed: turn one real 5-star Google review into a review post: needs the owner's real review text; if you cannot verify it word for word, skip. Thu: weekend promo push in groups that allow Fri-Sun promos. Fri: one outreach message to a realtor, builder or property manager. Sat: competitor check, READ ONLY: no comments, replies, likes or follows on their pages; the server refuses comments there (@3seasonslandscaping, @emeraldislelawncare, @fivestarlawns.wpg, @grounds_guys_winnipeg): note what works, adapt it our own way, never copy words or photos.

Never: mass-post identical text, spam communities, reveal that you are an AI unless asked directly, change account settings, accept terms or spend money.
