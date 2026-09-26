# Setup prompts for Claude in Chrome

Paste these into the Claude side panel in Chrome, in order. Upload the `social` skill first.

---

## Prompt 1 — Fill in the business profile (run once)

```
Use the social skill. I'm setting it up for my business. Fill in every TODO in the skill's
business-profile.md by looking at my own accounts in this browser. I'm already logged in.

1. Find my business online: search Google for "No BS Yard Work Winnipeg" and open my Google
   Business Profile and website (if it exists). Get the exact business name, phone, service area,
   services, hours, any offers or prices, and how customers book or ask for a quote.
2. Open my Instagram and Facebook business page (check the profile menus to find which ones I
   manage). Get the @handle and page URL. Read my last ~10 posts to learn how I write (tone,
   emojis, hashtags I already use).
3. On Facebook, list the Winnipeg-area groups I'm a member of that allow local service posts or
   recommendation requests (neighbourhood, community, buy-and-sell groups).
4. Look at 3 Winnipeg lawn/landscaping competitors on Instagram so the hashtags and lead
   searches match what locals actually use.

Rules: READ ONLY. Don't post, like, follow, message, join groups or change any settings. If a
login or verification screen appears, stop and tell me.

When you're done, give me the complete business-profile.md with every TODO replaced, in one
code block I can copy. Mark anything you couldn't confirm with "CHECK:" and don't guess prices.
```

Take the result and either paste it into `business-profile.md` inside the skill and re-upload,
or paste it back into Claude Code and ask it to update the skill and send a new zip.

---

## Prompt 2 — Test run (no posting)

```
Use the social skill: find-leads on Instagram and Facebook for Winnipeg lawn care, yard cleanup
and landscaping. Then draft replies for the top 5. Don't post anything. Show me the drafts.
```

Check the drafts sound like you. If they don't, say what to change ("shorter", "less salesy")
and ask Claude to update the Voice section of the profile.

---

## Prompt 3 — Try one real reply

```
Post draft #1 as a comment. Show me the exact text and link first and wait for my yes.
```

It must stop and ask. If it posts without asking, stop using it and tell Claude Code.

---

## Scheduled shortcuts

Save each of these as a shortcut (type `/` in the side panel → save), then click the clock icon
to schedule it. They're draft-only, so they never post while you're away.

**Morning leads (weekdays, 8:00 AM)**
```
Use the social skill. This is a scheduled run: READ and DRAFT only. find-leads on Instagram and
Facebook (including my local groups) from the last 2 days, skip anyone we've already replied to,
and draft replies for the best 5. List them numbered with links so I can approve later.
```

**Evening inbox (daily, 6:00 PM)**
```
Use the social skill. This is a scheduled run: READ and DRAFT only. Check new comments and DMs
on my Instagram and Facebook page. Summarize who wants what, flag quote requests as urgent, and
draft a reply for each. Don't send anything.
```

**Weekly content plan (Sunday, 7:00 PM)**
```
Use the social skill. This is a scheduled run: READ and DRAFT only. Plan next week's posts with
content-calendar: 3 posts for Instagram and Facebook, based on the season and weather in
Winnipeg, with captions, hashtags and an image idea for each.
```

**To send the approved ones later**, open the side panel and say e.g.
`post replies 1, 3 and 4 from this morning's leads`. It will still show each one before posting.
