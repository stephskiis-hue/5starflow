No-Bs Yardwork is a Winnipeg lawn care, landscaping and snow removal company. Every social post, ad and story is built from the post layouts below, the tokens in this system and nothing else. The look is bold, square cut and plain spoken: one idea per graphic, big type, lots of air, the phone number on every piece.

## The post layouts

Pick the layout by the job the post has to do. Rotate them so the feed never shows the same layout twice in a row.

| Layout | Use it for | Ground | Headline style |
| --- | --- | --- | --- |
| `StatementPost` | Booking pushes, snow plan, hiring, big news | `forest` with the mow-stripe pattern, or a real photo under a 70% `forest` overlay | `statement-xl`, uppercase, second line in `leaf` |
| `PrintPost` | Brand posts with a witty line, lawn and landscaping plans | `paper` | `print-headline`, sentence case |
| `ReviewPost` | Real Google reviews, thank-you posts | `white` | `quote` |
| `TipPost` | Local tips, how-tos, numbered series | `leaf` | `numeral` + `statement-l`, uppercase |
| `BeforeAfterPost` | Proof: one real job, same angle, before over after | `forest` bands around two photos | Anton, uppercase, one line |
| `FAQPost` | Objection handling: a real customer question answered straight | `paper` question over a `forest` answer | question in `serif`, answer in Anton `leaf` |
| `ComparePost` | Our two plans side by side, or monthly versus per visit | `forest` stripes, highlighted column in `leaf` | Anton, uppercase |
| `FounderPost` | Steph and Ben in their own words with a real photo | `paper` under a full-width photo | `serif`, sentence case |
| `GridPost` | Four services, jobs or steps in one post | `forest` stripes, tiles in `leaf` and `paper` or photos | Anton, uppercase |
| `StoryPoll` | Story question with room for the poll sticker | `forest` stripes, 1080 × 1920 | Anton, uppercase |
| `ReelCover` | Reel first frame and grid cover | real photo under a 60% `forest` overlay, 1080 × 1920 | Anton, uppercase, centred |
| `OfferPost` | Seasonal booking push and the paid ad, all three sizes | photo over `forest`, `leaf` call bar | Anton, uppercase |

Examples of the first four, at 1080 × 1350, are in the Examples asset group.

**Which format first.** For cold reach, founder content is the most reliable first winner for a local crew, then honest before and afters, objection answers and the plan comparison. Grid, tip and print posts are the supporting cast that keeps the feed useful. Never use fake native formats (notes app, fake chats) or AI images passed off as our work.

## Content rules

- Write like the owner typed it on his phone. Short sentences. No corporate fluff.
- No dashes mid-sentence. Use a period or a comma.
- Headlines: 2 to 7 words. The whole graphic stays under about 40 words.
- Never show a price. Never promise what the business hasn't offered.
- Every graphic carries the logo icon and wordmark bottom left and "Call or text 204-900-0438" bottom right (or in the call bar on `OfferPost`).
- Spell the name exactly: No-Bs Yardwork.
- Reviews are real, word for word, first name and neighbourhood only. Never invent a review.
- Borrow the structure of great advertising (a huge statement, a witty line in lots of white space, a single quote, a big number) but never another brand's words, logo, photos or characters.

## Visual foundations

- **Colour.** `forest` is the brand. `leaf` is the one accent. Text on `forest` is `white` or `sage`; text on `leaf` is `leaf-ink`; text on `paper` and `white` is `ink` or `muted`. `star` appears only on review stars.
- **Type.** Three faces, each with one job: Anton (`display`) for statements, numbers and the phone number; DM Serif Display (`serif`) for Print headlines, questions and review quotes; Archivo (`sans`) for kickers, body and footers. Never set body copy in Anton. Never mix Anton and the serif in one headline.
- **Layout.** Canvas 1080 × 1350 (feed), 1080 × 1920 (story and reel cover), 1080 × 1080 (square ads). Keep `safe-statement` or `safe-print` margins on every side; stories keep the top 220px and bottom 300px clear for the app's own buttons. Headline sits in the top half on Statement and Tip posts, in the bottom half on Print posts. Footer is always a row: logo icon and wordmark left, call to action right, a hairline above it (`rule-on-forest` or `rule-on-light`).
- **Pattern.** The only pattern is the mow stripe: vertical bands of `forest-stripe-a` and `forest-stripe-b`, `stripe` wide. It lives on `forest` grounds or as a small swatch on Print posts.
- **Corners.** Square (`radius-none`). The logo icon is round (`radius-badge`). Small inset photos may use `radius-photo`.
- **Photos.** Real job photos only (before and after, crew, trucks, finished lawns). Full bleed behind a Statement post with a `forest` overlay at about 70% so the type stays readable. No stock photos passed off as our work, no house numbers, plates or faces without permission.
- **No** gradients, drop shadows, emoji on graphics, clip art, or rounded cards.

## Logo

The official logo is in the Logos asset group:

- `icon.png`: the round grass-tuft icon. It replaces the old "NB" badge in every footer, 64px, next to the wordmark set in `wordmark` with the `label` line "WINNIPEG · EST. 2019". On `leaf` grounds give it a 5px `forest` ring so it doesn't sink into the green.
- `logo-light.png`: the full hexagon logo in white and `leaf`, for `forest` and photo grounds (reel covers, end cards, big moments).
- `logo-dark.png`: the full logo in `forest`, for `paper`, `white` and `leaf` grounds.

Never redraw, stretch, recolour beyond these two versions, or set the hexagon smaller than 240px wide (its small type stops reading).

## Producing a graphic

1. Choose the layout from the table above and copy its preview from the component.
2. Swap in the words and, if the layout takes one, a real photo. Every slot is marked in the preview (`data-slot`, `data-slot-bg`, `data-slot-list`); the component guidelines list them.
3. Render at 1080 × 1350 (and 1080 × 1920 for stories, 1080 × 1080 for square ads) as PNG: open the HTML in a browser at that exact viewport and screenshot it, or rebuild it on a Design canvas at the same size. The No-Bs HQ renderer does this headless and shrinks `data-fit` text until nothing overflows.
4. Check before it goes out: name spelled right, phone number right, no mid-sentence dashes, no price, text inside the margins, readable on a phone in one second.
