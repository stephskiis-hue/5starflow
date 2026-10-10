/**
 * SEO Growth Engine vocabulary: the services we want to rank for, the neighbourhoods we serve,
 * and the knobs the owner can change (SeoSettings.growthConfig, merged by mergeConfig()).
 *
 * A cluster is one service. Its `pillarPath` is the service page every post in the cluster links up to;
 * null means the page does not exist yet, which makes that page a top candidate for page mode.
 * `peaks` are the months (1-12) people search for it in Winnipeg (from .claude/skills/nobs-content/seasonal-calendar.md).
 */
const DEFAULT_ORIGIN = 'https://www.no-bs-yardwork.com';

// Order matters: the first cluster whose term appears in a keyword wins, so specific services come first.
// informational: a topic we write about but do not sell on its own (no service page, no "cost" keyword).
const CLUSTERS = [
  { id: 'spring-cleanup', label: 'Spring cleanup',     head: 'spring cleanup',  terms: ['spring cleanup', 'spring yard', 'snow mold', 'spring lawn'], peaks: [3, 4, 5], pillarPath: '/spring-fall-cleanups' },
  { id: 'snow-removal',   label: 'Snow removal',       head: 'snow removal',    terms: ['snow removal', 'snow', 'shovel', 'ice dam', 'salt'], peaks: [9, 10, 11, 12, 1, 2], pillarPath: '/winter-packages', plannedPillar: '/snow-removal-winnipeg' },
  { id: 'power-raking',   label: 'Power raking',       head: 'power raking',    terms: ['power raking', 'power rake', 'thatch'], peaks: [4, 5], pillarPath: null, plannedPillar: '/power-raking-winnipeg' },
  { id: 'aeration',       label: 'Aeration',           head: 'lawn aeration',   terms: ['aeration', 'aerator', 'core plug'], peaks: [5, 8, 9], pillarPath: null, plannedPillar: '/lawn-aeration-winnipeg' },
  { id: 'overseeding',    label: 'Overseeding',        head: 'overseeding',     terms: ['overseed', 'overseeding', 'grass seed', 'seeding'], peaks: [5, 8, 9], pillarPath: null, plannedPillar: '/overseeding-winnipeg' },
  { id: 'sod',            label: 'Sod',                head: 'sod installation', terms: ['sod', 'sodding', 'turf'], peaks: [5, 6, 8, 9], pillarPath: '/landscaping-winnipeg' },
  { id: 'weed-control',   label: 'Weed control',       head: 'weed control',    terms: ['weed', 'dandelion', 'crabgrass', 'clover', 'herbicide', 'pesticide'], peaks: [5, 6, 9], pillarPath: '/weed-control-winnipeg' },
  { id: 'fertilizing',    label: 'Fertilizing',        head: 'lawn fertilizing', terms: ['fertiliz', 'fertilis', 'winterizer', 'lawn feed'], peaks: [5, 8, 9, 10], pillarPath: '/premium-lawn-care' },
  { id: 'fall-cleanup',   label: 'Fall cleanup',       head: 'fall cleanup',    terms: ['fall cleanup', 'leaf', 'leaves', 'fall yard', 'fall lawn', 'yard cleanup'], peaks: [9, 10, 11], pillarPath: '/spring-fall-cleanups' },
  { id: 'watering',       label: 'Watering',           head: 'lawn watering',   terms: ['water', 'sprinkler', 'irrigation', 'drought'], peaks: [6, 7, 10], pillarPath: '/lawn-care-winnipeg', informational: true },
  { id: 'fencing',        label: 'Fencing',            head: 'fence installation', terms: ['fence', 'fencing', 'gate'], peaks: [5, 6, 7, 8, 9], pillarPath: '/fencing-winnipeg' },
  { id: 'hardscaping',    label: 'Hardscaping',        head: 'patio installation', terms: ['patio', 'paver', 'retaining wall', 'hardscap', 'walkway', 'flagstone'], peaks: [4, 5, 6, 7, 8], pillarPath: '/landscaping-winnipeg' },
  { id: 'landscaping',    label: 'Landscaping',        head: 'landscaping',     terms: ['landscap', 'mulch', 'rock', 'garden bed', 'flower bed', 'edging', 'tree', 'shrub', 'hedge', 'cedar'], peaks: [4, 5, 6, 7, 8], pillarPath: '/landscaping-winnipeg' },
  { id: 'lawn-mowing',    label: 'Grass cutting',      head: 'grass cutting',   terms: ['lawn mowing', 'mowing', 'mow', 'grass cutting', 'cut', 'grass height'], peaks: [4, 5, 6, 7, 8, 9], pillarPath: '/grass-cutting-winnipeg' },
  { id: 'yard-maintenance', label: 'Yard maintenance', head: 'yard maintenance', terms: ['yard maintenance', 'yard work', 'yard care', 'property maintenance'], peaks: [], pillarPath: '/yard-maintenance-winnipeg' },
  { id: 'lawn-care',      label: 'Lawn care',          head: 'lawn care',       terms: ['lawn care', 'lawn service', 'lawn', 'grass', 'yard'], peaks: [], pillarPath: '/lawn-care-winnipeg' },
];

// Neighbourhoods from service-areas-winnipeg. aliases are the normalized forms people type.
const AREAS = [
  ['St. Vital', ['st vital', 'saint vital']], ['St. Boniface', ['st boniface', 'saint boniface']], ['Transcona', ['transcona']],
  ['River Heights', ['river heights']], ['Charleswood', ['charleswood']], ['Fort Garry', ['fort garry']], ['Waverley West', ['waverley west', 'bridgwater', 'south pointe']],
  ['North Kildonan', ['north kildonan']], ['Sage Creek', ['sage creek']], ['Windsor Park', ['windsor park']], ['St. James', ['st james', 'saint james', 'assiniboia']],
  ['Tuxedo', ['tuxedo']], ['Wolseley', ['wolseley', 'west broadway']], ['West End', ['west end', 'spence']], ['North End', ['north end', 'west kildonan']],
  ['East Kildonan', ['east kildonan', 'elmwood']], ['Garden City', ['garden city', 'the maples']], ['Linden Woods', ['linden woods', 'whyte ridge']],
  ['Island Lakes', ['island lakes', 'southdale']], ['Headingley', ['headingley']], ['East St. Paul', ['east st paul', 'west st paul']], ['Downtown', ['downtown winnipeg']],
].map(([name, aliases]) => ({ name, aliases }));

const BRAND_TERMS = ['no bs', 'nobs', 'no bull', 'nobsyardwork', 'no b s'];

// Blog post types the writer knows (same names as CONTENT_TYPES in _blog-autopilot.py).
const CONTENT_TYPES = ['cost guide', 'how-to', 'tips', 'comparison', 'timing guide'];

// Serper discovery templates: {s} = the cluster head term.
const DISCOVERY_TEMPLATES = ['{s} winnipeg', '{s} cost winnipeg', 'when to {s} winnipeg', 'best {s} company winnipeg'];

const DEFAULT_GROWTH_CONFIG = {
  modesEnabled: ['new', 'refresh', 'page'],
  refreshPerWeek: 2,          // refreshes in any rolling 7 days
  pagesPerWeek: 1,            // new landing pages in any rolling 7 days
  areaPagesMax: 6,            // area pages allowed until each existing one earns 50 impressions / 28 days
  reportEveryDays: 7,         // weekly recap
  serperWeeklyBudget: 150,    // Serper calls per ISO week (discovery + rank tracking)
  rankTrackMax: 30,           // keywords checked weekly in Google + the map pack
  inspectPerRun: 60,          // URL Inspection calls per index-watch run (Google allows 2000/day)
  planThreshold: 4,           // score at which an idea becomes "planned"
  crawlMaxUrls: 300,
  retentionDays: 120,         // daily query x page detail kept; older months are rolled up
  assignmentHours: 6,         // how long a reserved assignment stays locked
};

function mergeConfig(stored, env = process.env) {
  const cfg = { ...DEFAULT_GROWTH_CONFIG, ...(stored && typeof stored === 'object' ? stored : {}) };
  const num = (k, e) => { const v = Number(env[e]); if (Number.isFinite(v) && v > 0) cfg[k] = v; };
  num('inspectPerRun', 'SEO_INSPECT_PER_RUN');
  num('crawlMaxUrls', 'SEO_CRAWL_MAX_URLS');
  num('retentionDays', 'SEO_STATS_RETENTION_DAYS');
  num('serperWeeklyBudget', 'SERPER_WEEKLY_BUDGET');
  if (!Array.isArray(cfg.modesEnabled)) cfg.modesEnabled = DEFAULT_GROWTH_CONFIG.modesEnabled;
  return cfg;
}

const clusterById = (id) => CLUSTERS.find((c) => c.id === id) || null;

module.exports = { DEFAULT_ORIGIN, CLUSTERS, AREAS, BRAND_TERMS, CONTENT_TYPES, DISCOVERY_TEMPLATES, DEFAULT_GROWTH_CONFIG, mergeConfig, clusterById };
