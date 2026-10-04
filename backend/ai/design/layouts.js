// Slot contract for each No-Bs layout. The HTML files in ./layouts/ are the design system's own
// previews (see BRAND.md); this file adds what the renderer must enforce: which slots are required,
// which sizes exist, and which lists have a fixed length. Keep in sync with layouts/<Name>.md.
const ALL = ['feed', 'story', 'square'];

const LAYOUTS = {
  StatementPost:   { label: 'Statement',     sizes: ALL,      required: ['kicker', 'headline', 'body'], photos: ['photo'], use: 'Booking pushes, snow plan, hiring, big news. Max twice a week.' },
  TipPost:         { label: 'Tip',           sizes: ALL,      required: ['number', 'kicker', 'headline', 'body'], use: 'Numbered local tip; the number is its place in a running series.' },
  ReviewPost:      { label: 'Review',        sizes: ALL,      required: ['quote', 'reviewer', 'rating'], use: 'One REAL Google review, word for word. First name + neighbourhood only.' },
  PrintPost:       { label: 'Print',         sizes: ALL,      required: ['headline', 'body'], photos: ['photo'], use: 'Witty brand line in lots of white space; lawn and landscaping plans.' },
  BeforeAfterPost: { label: 'Before/After',  sizes: ALL,      required: ['kicker', 'headline', 'before', 'after'], photos: ['before', 'after'], photoRequired: ['before', 'after'], use: 'Proof: one real job, same angle, before over after.' },
  FAQPost:         { label: 'FAQ',           sizes: ALL,      required: ['kicker', 'question', 'answer_headline', 'answer'], use: 'A real customer question answered straight.' },
  ComparePost:     { label: 'Compare',       sizes: ALL,      required: ['kicker', 'headline', 'a_label', 'a_big', 'a_items', 'b_label', 'b_big', 'b_items'], lists: { a_items: [1, 4], b_items: [1, 4] }, use: 'Our two plans side by side, or monthly vs per visit. Never a price.' },
  FounderPost:     { label: 'Founder',       sizes: ALL,      required: ['kicker', 'headline', 'body', 'signature', 'photo'], photos: ['photo'], photoRequired: ['photo'], use: 'Steph and Ben in their own words, with a real photo.' },
  GridPost:        { label: 'Grid',          sizes: ALL,      required: ['kicker', 'headline', 'tiles'], lists: { tiles: [4, 4] }, use: 'Four services, jobs or steps in one post. tiles: [{num,label,photo?}] x4.' },
  StoryPoll:       { label: 'Story poll',    sizes: ['story'], required: ['kicker', 'question', 'body'], use: 'Story question with room for the poll sticker (add the sticker in the app).' },
  ReelCover:       { label: 'Reel cover',    sizes: ['story'], required: ['kicker', 'title'], photos: ['photo'], use: 'Reel first frame and grid cover over a real job photo.' },
  OfferPost:       { label: 'Offer',         sizes: ALL,      required: ['kicker', 'headline', 'points'], photos: ['photo'], lists: { points: [1, 4] }, use: 'Seasonal booking push / paid ad. Optional flag ("SPOTS FILLING UP").' },
};

// canvas px per size (feed default). Story-only layouts always render 1080x1920.
const SIZES = { feed: { w: 1080, h: 1350 }, story: { w: 1080, h: 1920 }, square: { w: 1080, h: 1080 } };

function describeLayouts() {
  return Object.entries(LAYOUTS).map(([name, l]) => ({ name, ...l }));
}

module.exports = { LAYOUTS, SIZES, describeLayouts };
