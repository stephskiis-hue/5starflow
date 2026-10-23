/**
 * Default pages for the Winnipeg Fence Pros blog, built from the live site's own page (decks.html): the same <head>
 * styles, the transparent top bar with the logo and the hamburger, the full-screen menu (#header), the icon footer and
 * the same scripts, so an article looks and behaves like the rest of winnipegfencepros.com. The article and list parts
 * in between use their own styles, all prefixed wfp- so they never clash with the site's Bootstrap theme.
 * Paths are root-absolute (/vendor/...) because articles live in /articles/<slug>/.
 * Placeholders are {{LIKE_THIS}}; <!--NAME-->...<!--/NAME--> blocks are kept or dropped (template.toggleBlocks).
 */

const SITE_HEAD = `<meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1.0, shrink-to-fit=no">
<link rel="shortcut icon" href="{{FAVICON_URL}}" type="image/x-icon">
<link rel="apple-touch-icon" href="{{LOGO_URL}}">
<link id="googleFonts" href="https://fonts.googleapis.com/css?family=Poppins:300,400,600,700,800%7CMontserrat:300,400,600,700&display=swap" rel="stylesheet" type="text/css">
<link rel="stylesheet" href="/vendor/bootstrap/css/bootstrap.min.css">
<link rel="stylesheet" href="/vendor/fontawesome-free/css/all.min.css">
<link rel="stylesheet" href="/css/theme.css">
<link rel="stylesheet" href="/css/theme-elements.css">
<link rel="stylesheet" href="/css/wfp.css">
<link id="skinCSS" rel="stylesheet" href="/css/skins/wfp.css">
<link rel="stylesheet" href="/css/custom.css">
<link rel="stylesheet" href="/vendor/animate/animate.compat.css" media="print" onload="this.media='all'">
<link rel="stylesheet" href="/vendor/simple-line-icons/css/simple-line-icons.min.css" media="print" onload="this.media='all'">
<script src="/vendor/modernizr/modernizr.min.js"></script>`;

// The site's top bar (logo + hamburger, transparent until you scroll) and its full-screen menu. {{SITE_NAV}} = the menu items.
const SITE_TOP = `<div class="sticky-wrapper sticky-wrapper-transparent sticky-wrapper-effect-1 sticky-wrapper-effect-1-dark sticky-wrapper-border-bottom" data-plugin-sticky data-plugin-options="{'minWidth': 0, 'stickyStartEffectAt': 100, 'padding': {'top': 0}}">
  <div class="sticky-body">
    <div class="container container-xl-custom">
      <div class="row justify-content-between align-items-center">
        <div class="col-auto">
          <div class="py-3"><a href="{{SITE_URL}}/"><!--LOGO--><img src="{{LOGO_URL}}" alt="{{BUSINESS_NAME}}" class="wfp-logo"><!--/LOGO--><!--NOLOGO--><span class="wfp-brand">{{BUSINESS_NAME}}</span><!--/NOLOGO--></a></div>
        </div>
        <div class="col-auto text-end d-flex align-items-center justify-content-end">
          <button class="hamburguer-btn hamburguer-btn-light" data-set-active="false" aria-label="Menu"><span class="hamburguer"><span></span><span></span><span></span></span></button>
        </div>
      </div>
    </div>
  </div>
</div>
<header id="header" class="side-header-overlay-full-screen side-header-hide" data-plugin-options="{'stickyEnabled': false}">
  <button class="hamburguer-btn hamburguer-btn-light hamburguer-btn-side-header hamburguer-btn-side-header-overlay active" data-set-active="false" aria-label="Close the menu"><span class="close"><span></span><span></span></span></button>
  <div class="header-body d-flex h-100">
    <div class="header-column flex-row flex-lg-column justify-content-center h-100">
      <div class="header-container container d-flex h-100">
        <div class="header-row header-row-side-header flex-row h-100 pb-5">
          <div class="side-header-scrollable scrollable colored-slider h-75" data-plugin-scrollable>
            <div class="scrollable-content">
              <div class="header-nav header-nav-light-text header-nav-links header-nav-links-side-header header-nav-links-vertical header-nav-links-vertical-expand header-nav-click-to-open align-self-start">
                <div class="header-nav-main header-nav-main-square header-nav-main-dropdown-no-borders header-nav-main-effect-4 header-nav-main-sub-effect-1">
                  <nav><ul class="nav nav-pills" id="mainNav">{{SITE_NAV}}</ul></nav>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</header>`;

const SITE_FOOTER = `<footer id="footer" class="bg-quaternary border-width-1 custom-border-color-grey py-5 mt-0">
  <div class="container container-xl-custom">
    <div class="row justify-content-between">
      <h4 class="text-color-light mb-3 custom-font-secondary" align="center">
        <a href="{{BLOG_URL}}"><img src="/img/wordpress.webp" alt="Read our articles"></a> <a href="https://www.facebook.com/profile.php?id=61583586323315" target="_blank" rel="noopener"><img src="/img/facebook.webp" alt="Find us on Facebook"></a> <a href="https://www.instagram.com/winnipegfencepros/" target="_blank" rel="noopener"><img src="/img/instagram.webp" alt="Find us on Instagram"></a> &nbsp; <a href="https://g.page/r/CSCkIJNto96IEBM/review" target="_blank" rel="noopener"><img src="/img/google.webp" alt="Find us on Google Maps"></a>
      </h4>
    </div>
    <p class="wfp-footnote">&copy; {{YEAR}} {{BUSINESS_NAME}} · {{CITY}}, {{REGION}}<!--PHONE--> · <a href="tel:{{PHONE}}">{{PHONE}}</a><!--/PHONE--></p>
  </div>
</footer>`;

const SITE_SCRIPTS = ['jquery/jquery.min.js', 'jquery.appear/jquery.appear.min.js', 'jquery.easing/jquery.easing.min.js', 'jquery.cookie/jquery.cookie.min.js',
  'bootstrap/js/bootstrap.bundle.min.js', 'jquery.validation/jquery.validate.min.js', 'jquery.easy-pie-chart/jquery.easypiechart.min.js', 'jquery.gmap/jquery.gmap.min.js',
  'lazysizes/lazysizes.min.js', 'isotope/jquery.isotope.min.js', 'owl.carousel/owl.carousel.min.js', 'magnific-popup/jquery.magnific-popup.min.js', 'vide/jquery.vide.min.js',
  'vivus/vivus.min.js', 'nanoscroller/jquery.nanoscroller.min.js'].map((f) => `<script src="/vendor/${f}"></script>`)
  .concat(['<script src="/js/theme.js"></script>', '<script src="/vendor/rs-plugin/js/jquery.themepunch.tools.min.js"></script>', '<script src="/vendor/rs-plugin/js/jquery.themepunch.revolution.min.js"></script>',
    '<script src="/js/wfp.js"></script>', '<script src="/js/custom.js"></script>', '<script src="/js/theme.init.js"></script>']).join('\n');

const CSS = `
  :root { --wfp-orange: #fea45a; --wfp-orange-deep: #e8873a; --wfp-link: #b85a0b; --wfp-ink: #212529; --wfp-text: #4a4f54; --wfp-muted: #7b8086; --wfp-dark: #333333; --wfp-cream: #faf6f2; --wfp-line: #eadfd5; }
  .wfp-logo { max-height: 110px; width: auto; }
  .wfp-brand { color: #fff; font-weight: 800; font-size: 1.2rem; }
  .wfp-hero { background: linear-gradient(180deg, #2b2e31 0%, var(--wfp-ink) 100%); color: #fff; border-bottom: 5px solid var(--wfp-orange); padding: 170px 0 56px; }
  .wfp-wrap { max-width: 1140px; margin: 0 auto; padding: 0 20px; }
  .wfp-hero h1 { margin: 12px 0 10px; font-size: clamp(1.8rem, 4.4vw, 2.9rem); line-height: 1.2; font-weight: 700; color: #fff; letter-spacing: 0; text-transform: none; }
  .wfp-hero .wfp-lead { margin: 0; max-width: 680px; color: #d4d7da; font-size: 1.05rem; line-height: 1.7; }
  .wfp-crumbs { font-size: .85rem; color: #b8bcc0; }
  .wfp-crumbs a { color: var(--wfp-orange); text-decoration: none; }
  .wfp-tag { display: inline-block; background: var(--wfp-orange); color: var(--wfp-ink); font-size: .75rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; padding: 4px 12px; border-radius: 999px; }
  .wfp-meta { color: #c4c8cc; font-size: .9rem; margin: 0; }
  .wfp-article { max-width: 800px; margin: 0 auto; padding: 0 20px 24px; }
  .wfp-hero-wrap { max-width: 1020px; margin: 0 auto; padding: 0 20px; }
  .wfp-hero-img { display: block; width: 100%; max-width: 980px; margin: -28px auto 0; border-radius: 14px; box-shadow: 0 14px 40px rgba(0, 0, 0, .22); position: relative; z-index: 2; }
  .wfp-content { padding-top: 36px; font-size: 1.04rem; line-height: 1.8; color: var(--wfp-text); }
  .wfp-content h2 { color: var(--wfp-ink); font-size: 1.6rem; line-height: 1.3; margin: 2.2em 0 .6em; padding-bottom: .35em; border-bottom: 3px solid var(--wfp-orange); font-weight: 700; letter-spacing: 0; text-transform: none; }
  .wfp-content h3 { color: var(--wfp-ink); font-size: 1.2rem; margin: 1.8em 0 .4em; font-weight: 600; letter-spacing: 0; text-transform: none; }
  .wfp-content p { margin: 0 0 1.15em; }
  .wfp-content ul, .wfp-content ol { margin: 0 0 1.3em; padding-left: 1.4em; }
  .wfp-content li { margin-bottom: .4em; }
  .wfp-content li::marker { color: var(--wfp-orange-deep); font-weight: 700; }
  .wfp-content a { color: var(--wfp-link); text-decoration: underline; }
  .wfp-content blockquote { margin: 1.6em 0; padding: 14px 22px; background: var(--wfp-cream); border-left: 5px solid var(--wfp-orange); border-radius: 0 10px 10px 0; color: var(--wfp-ink); }
  .wfp-content img, .wfp-content figure { max-width: 100%; height: auto; border-radius: 10px; margin: 1.4em 0; }
  .wfp-content table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; margin: 1.5em 0; font-size: .95rem; }
  .wfp-content th { background: var(--wfp-dark); color: #fff; text-align: left; font-weight: 600; }
  .wfp-content th, .wfp-content td { padding: 10px 14px; border: 1px solid var(--wfp-line); }
  .wfp-content tr:nth-child(even) td { background: var(--wfp-cream); }
  .wfp-cta { background: var(--wfp-dark); color: #fff; border-radius: 16px; padding: 32px 28px; margin: 3em 0 1em; border-left: 8px solid var(--wfp-orange); }
  .wfp-cta h2 { color: #fff; margin: 0 0 8px; font-size: 1.5rem; font-weight: 700; letter-spacing: 0; text-transform: none; }
  .wfp-cta p { margin: 0 0 18px; color: #dfe2e4; }
  .wfp-cta p a { color: var(--wfp-orange); }
  .wfp-btn { display: inline-block; background: var(--wfp-orange); color: var(--wfp-ink) !important; font-weight: 700; padding: 12px 26px; border-radius: 8px; text-decoration: none !important; border: 0; cursor: pointer; font-family: inherit; }
  .wfp-btn:hover { background: var(--wfp-orange-deep); }
  .wfp-cta a.wfp-call { color: var(--wfp-orange); font-weight: 600; margin-left: 14px; white-space: nowrap; }
  .wfp-back { display: inline-block; margin: 8px 0 40px; font-weight: 600; text-decoration: none; color: var(--wfp-link); }
  .wfp-listing { padding: 44px 0 70px; background: var(--wfp-cream); }
  .wfp-pills { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin: 0 0 34px; }
  .wfp-pill { font: inherit; font-size: .88rem; font-weight: 600; background: #fff; color: var(--wfp-ink); border: 2px solid var(--wfp-line); border-radius: 999px; padding: 7px 20px; cursor: pointer; }
  .wfp-pill:hover { border-color: var(--wfp-orange); }
  .wfp-pill.active { background: var(--wfp-orange); border-color: var(--wfp-orange); }
  .wfp-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px; }
  .wfp-card { background: #fff; border-radius: 14px; overflow: hidden; box-shadow: 0 6px 22px rgba(33, 37, 41, .08); display: flex; flex-direction: column; transition: transform .2s, box-shadow .2s; }
  .wfp-card:hover { transform: translateY(-4px); box-shadow: 0 14px 34px rgba(33, 37, 41, .16); }
  .wfp-card[hidden] { display: none; }
  .wfp-thumb { display: block; aspect-ratio: 16 / 9; background: repeating-linear-gradient(90deg, transparent 0 26px, rgba(254, 164, 90, .16) 26px 32px), linear-gradient(135deg, var(--wfp-dark), var(--wfp-ink)); border-bottom: 4px solid var(--wfp-orange); overflow: hidden; }
  .wfp-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .35s; }
  .wfp-card:hover .wfp-thumb img { transform: scale(1.05); }
  .wfp-card-body { padding: 20px 22px 24px; display: flex; flex-direction: column; flex: 1; }
  .wfp-card .wfp-card-meta { color: var(--wfp-muted); font-size: .8rem; margin: 0 0 6px; }
  .wfp-card .wfp-card-meta b { color: var(--wfp-link); text-transform: uppercase; letter-spacing: .04em; }
  .wfp-card h2 { font-size: 1.15rem; line-height: 1.4; margin: 0 0 10px; font-weight: 700; letter-spacing: 0; text-transform: none; }
  .wfp-card h2 a { color: var(--wfp-ink); text-decoration: none; }
  .wfp-card h2 a:hover { color: var(--wfp-link); }
  .wfp-card-excerpt { margin: 0 0 14px; font-size: .93rem; color: var(--wfp-text); line-height: 1.65; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .wfp-more { margin-top: auto; font-weight: 700; font-size: .9rem; text-decoration: none; color: var(--wfp-link); }
  .wfp-loadmore { text-align: center; margin-top: 36px; }
  .wfp-empty { text-align: center; color: var(--wfp-muted); padding: 40px 0; }
  .wfp-footnote { text-align: center; color: #c9cdd1; font-size: .85rem; margin: 6px 0 0; }
  .wfp-footnote a { color: #fff; }
  @media (max-width: 991px) { .wfp-grid { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 760px) { .wfp-hero { padding: 140px 0 40px; } .wfp-grid { grid-template-columns: 1fr; } .wfp-logo { max-height: 80px; } }
`;

const page = (head, main) => `<!DOCTYPE html>
<html class="side-header-overlay-full-screen" lang="en-CA">
<head>
${SITE_HEAD}
${head}
<style>${CSS}</style>
</head>
<body data-plugin-scroll-spy data-plugin-options="{'target': '#header'}">
<div class="body">
${SITE_TOP}
<div role="main" class="main">
${main}
</div>
${SITE_FOOTER}
</div>
${SITE_SCRIPTS}
</body>
</html>`;

const POST_TEMPLATE = page(`<title>{{TITLE}} | {{BUSINESS_NAME}}</title>
<meta name="description" content="{{META_DESCRIPTION}}">
<meta name="robots" content="index, follow, max-image-preview:large">
<link rel="canonical" href="{{CANONICAL}}">
<meta property="og:type" content="article">
<meta property="og:title" content="{{TITLE}}">
<meta property="og:description" content="{{META_DESCRIPTION}}">
<meta property="og:url" content="{{CANONICAL}}">
<meta property="og:image" content="{{IMAGE_URL}}">
<meta property="article:published_time" content="{{DATE}}">
{{SCHEMA}}`, `<section class="wfp-hero"><div class="wfp-wrap">
  <div class="wfp-crumbs"><a href="{{SITE_URL}}/">Home</a> › <a href="{{BLOG_URL}}">Articles</a> › {{CATEGORY}}</div>
  <h1>{{TITLE}}</h1>
  <p class="wfp-meta"><span class="wfp-tag">{{CATEGORY}}</span> &nbsp; {{DATE_HUMAN}} · {{READ_TIME}} min read</p>
</div></section>
<!--HERO--><div class="wfp-hero-wrap"><img class="wfp-hero-img" src="{{IMAGE}}" alt="{{IMAGE_ALT}}" width="1200" height="675"></div><!--/HERO-->
<article class="wfp-article">
  <div class="wfp-content">
{{BODY}}
  </div>
  <div class="wfp-cta">
    <h2>Get a free onsite estimate</h2>
    <p>{{BUSINESS_NAME}} builds fences, decks and pergolas across {{CITY}}. Tell us about your yard and we will come out and give you a clear price. <a href="{{SERVICE_URL}}">See our {{SERVICE_NAME}} work →</a></p>
    <a class="wfp-btn" href="{{QUOTE_URL}}">Get My Free Estimate</a><!--PHONE--><a class="wfp-call" href="tel:{{PHONE}}">or call {{PHONE}}</a><!--/PHONE-->
  </div>
  <a class="wfp-back" href="{{BLOG_URL}}">← All articles</a>
</article>`);

const CARD_TEMPLATE = `<article class="wfp-card" data-category="{{CATEGORY}}">
  <a class="wfp-thumb" href="{{URL}}" tabindex="-1" aria-hidden="true"><!--IMG--><img src="{{IMAGE}}" alt="" loading="lazy" width="600" height="338"><!--/IMG--></a>
  <div class="wfp-card-body">
    <p class="wfp-card-meta"><b>{{CATEGORY}}</b> · {{DATE_HUMAN}} · {{READ_TIME}} min</p>
    <h2><a href="{{URL}}">{{TITLE}}</a></h2>
    <p class="wfp-card-excerpt">{{EXCERPT}}</p>
    <a class="wfp-more" href="{{URL}}">Read the article →</a>
  </div>
</article>`;

// The server rewrites everything between the two markers on every publish; the rest of this page is yours.
const INDEX_TEMPLATE = page(`<title>Fence, Deck &amp; Pergola Articles for Winnipeg Homeowners | {{BUSINESS_NAME}}</title>
<meta name="description" content="Costs, city rules, materials and timing for building a fence, deck or pergola in Winnipeg, from the team at {{BUSINESS_NAME}}.">
<link rel="canonical" href="{{BLOG_URL}}">
<meta property="og:type" content="website">
<meta property="og:title" content="Fence, Deck &amp; Pergola Articles | {{BUSINESS_NAME}}">
<meta property="og:url" content="{{BLOG_URL}}">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"CollectionPage","name":"Articles","url":"{{BLOG_URL}}","publisher":{"@type":"Organization","name":"{{BUSINESS_NAME}}","url":"{{SITE_URL}}"}}</script>`, `<section class="wfp-hero"><div class="wfp-wrap">
  <div class="wfp-crumbs"><a href="{{SITE_URL}}/">Home</a> › Articles</div>
  <h1>Fence, Deck &amp; Pergola Articles</h1>
  <p class="wfp-lead">Straight answers on costs, materials, city rules and timing for homeowners in {{CITY}}.</p>
</div></section>
<section class="wfp-listing"><div class="wfp-wrap">
  <div class="wfp-pills" id="wfp-pills" role="group" aria-label="Filter articles by service"></div>
  <div class="wfp-grid" id="wfp-grid">
<!-- 5sf:articles:start -->
{{CARDS}}
<!-- 5sf:articles:end -->
  </div>
  <p class="wfp-empty" id="wfp-empty" hidden>New articles are on the way. Check back soon.</p>
  <div class="wfp-loadmore"><button class="wfp-btn" id="wfp-more" type="button" hidden>Show more articles</button></div>
</div></section>
<script>
(function () {
  var cards = [].slice.call(document.querySelectorAll('#wfp-grid .wfp-card'));
  var pills = document.getElementById('wfp-pills'), more = document.getElementById('wfp-more'), empty = document.getElementById('wfp-empty');
  var PAGE = 9, shown = PAGE, cat = '';
  var cats = [];
  cards.forEach(function (c) { var k = c.getAttribute('data-category'); if (k && cats.indexOf(k) < 0) cats.push(k); });
  function render() {
    var n = 0, total = 0;
    cards.forEach(function (c) {
      var ok = !cat || c.getAttribute('data-category') === cat;
      if (ok) total++;
      var vis = ok && n < shown;
      if (vis) n++;
      c.hidden = !vis;
    });
    more.hidden = n >= total;
    empty.hidden = total > 0;
  }
  if (cats.length > 1) {
    ['All'].concat(cats).forEach(function (name, i) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'wfp-pill' + (i === 0 ? ' active' : ''); b.textContent = name;
      b.addEventListener('click', function () {
        cat = i === 0 ? '' : name; shown = PAGE;
        [].slice.call(pills.children).forEach(function (p) { p.classList.toggle('active', p === b); });
        render();
      });
      pills.appendChild(b);
    });
  }
  more.addEventListener('click', function () { shown += PAGE; render(); });
  render();
})();
</script>`);

module.exports = { POST_TEMPLATE, CARD_TEMPLATE, INDEX_TEMPLATE };
