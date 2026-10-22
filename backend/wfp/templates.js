/**
 * Default pages for the Winnipeg Fence Pros blog, styled like winnipegfencepros.com (orange + charcoal, Poppins).
 * They are only defaults: the Settings tab can replace any of them (or import one from a page on the site).
 * Placeholders are {{LIKE_THIS}}; <!--NAME-->...<!--/NAME--> blocks are kept or dropped (template.toggleBlocks).
 */

const CSS = `
  :root { --orange: #fea45a; --orange-deep: #e8873a; --link: #b85a0b; --ink: #212529; --text: #4a4f54; --muted: #7b8086; --dark: #333333; --footer: #4d5154; --cream: #faf6f2; --line: #eadfd5; }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body { margin: 0; font-family: Poppins, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text); background: #fff; line-height: 1.75; -webkit-font-smoothing: antialiased; }
  img { max-width: 100%; height: auto; }
  a { color: var(--link); }
  .wrap { max-width: 1140px; margin: 0 auto; padding: 0 20px; }
  .site-header { background: var(--dark); position: sticky; top: 0; z-index: 20; box-shadow: 0 2px 12px rgba(0, 0, 0, .25); }
  .site-header .bar { max-width: 1140px; margin: 0 auto; padding: 8px 20px; display: flex; align-items: center; justify-content: space-between; gap: 16px; position: relative; }
  .brand { display: flex; align-items: center; color: #fff; font-weight: 800; font-size: 1.15rem; text-decoration: none; }
  .brand img { display: block; height: 56px; width: auto; }
  .nav { display: flex; align-items: center; gap: 4px; }
  .nav a { color: #fff; text-decoration: none; font-weight: 600; font-size: .92rem; padding: 10px 14px; border-radius: 6px; }
  .nav a:hover, .nav a.on { color: var(--orange); }
  .nav a.btn-cta { background: var(--orange); color: var(--ink); margin-left: 8px; }
  .nav a.btn-cta:hover { background: var(--orange-deep); color: var(--ink); }
  .nav-toggle, .burger { display: none; }
  .hero { background: linear-gradient(180deg, #2b2e31 0%, var(--ink) 100%); color: #fff; border-bottom: 5px solid var(--orange); }
  .hero .wrap { padding-top: 52px; padding-bottom: 52px; }
  .hero h1 { margin: 12px 0 10px; font-size: clamp(1.8rem, 4.4vw, 2.9rem); line-height: 1.2; font-weight: 700; color: #fff; }
  .hero p.lead { margin: 0; max-width: 680px; color: #d4d7da; font-size: 1.05rem; }
  .crumbs { font-size: .85rem; color: #b8bcc0; }
  .crumbs a { color: var(--orange); text-decoration: none; }
  .tag { display: inline-block; background: var(--orange); color: var(--ink); font-size: .75rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; padding: 4px 12px; border-radius: 999px; }
  .meta { color: #c4c8cc; font-size: .9rem; margin: 0; }
  main { min-height: 50vh; }
  .article-wrap { max-width: 800px; margin: 0 auto; padding: 0 20px 24px; }
  .hero-img { display: block; width: 100%; max-width: 980px; margin: -28px auto 0; border-radius: 14px; box-shadow: 0 14px 40px rgba(0, 0, 0, .22); position: relative; z-index: 2; }
  .hero-wrap { max-width: 1020px; margin: 0 auto; padding: 0 20px; }
  .content { padding-top: 36px; font-size: 1.04rem; }
  .content h2 { color: var(--ink); font-size: 1.6rem; line-height: 1.3; margin: 2.2em 0 .6em; padding-bottom: .35em; border-bottom: 3px solid var(--orange); font-weight: 700; }
  .content h3 { color: var(--ink); font-size: 1.2rem; margin: 1.8em 0 .4em; font-weight: 600; }
  .content p { margin: 0 0 1.15em; }
  .content ul, .content ol { margin: 0 0 1.3em; padding-left: 1.4em; }
  .content li { margin-bottom: .4em; }
  .content li::marker { color: var(--orange-deep); font-weight: 700; }
  .content blockquote { margin: 1.6em 0; padding: 14px 22px; background: var(--cream); border-left: 5px solid var(--orange); border-radius: 0 10px 10px 0; color: var(--ink); }
  .content img, .content figure { max-width: 100%; border-radius: 10px; margin: 1.4em 0; }
  .content figcaption { color: var(--muted); font-size: .85rem; text-align: center; }
  .content table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; margin: 1.5em 0; font-size: .95rem; }
  .content th { background: var(--dark); color: #fff; text-align: left; font-weight: 600; }
  .content th, .content td { padding: 10px 14px; border: 1px solid var(--line); }
  .content tr:nth-child(even) td { background: var(--cream); }
  .cta { background: var(--dark); color: #fff; border-radius: 16px; padding: 32px 28px; margin: 3em 0 1em; border-left: 8px solid var(--orange); }
  .cta h2 { color: #fff; margin: 0 0 8px; font-size: 1.5rem; border: 0; padding: 0; }
  .cta p { margin: 0 0 18px; color: #dfe2e4; }
  .btn { display: inline-block; background: var(--orange); color: var(--ink); font-weight: 700; padding: 12px 26px; border-radius: 8px; text-decoration: none; }
  .btn:hover { background: var(--orange-deep); }
  .cta a.call { color: var(--orange); font-weight: 600; margin-left: 14px; white-space: nowrap; }
  .back { display: inline-block; margin: 8px 0 40px; font-weight: 600; text-decoration: none; }
  .listing { padding: 44px 0 70px; background: var(--cream); }
  .pills { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin: 0 0 34px; }
  .pill { font: inherit; font-size: .88rem; font-weight: 600; background: #fff; color: var(--ink); border: 2px solid var(--line); border-radius: 999px; padding: 7px 20px; cursor: pointer; }
  .pill:hover { border-color: var(--orange); }
  .pill.active { background: var(--orange); border-color: var(--orange); }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px; }
  .card { background: #fff; border-radius: 14px; overflow: hidden; box-shadow: 0 6px 22px rgba(33, 37, 41, .08); display: flex; flex-direction: column; transition: transform .2s, box-shadow .2s; }
  .card:hover { transform: translateY(-4px); box-shadow: 0 14px 34px rgba(33, 37, 41, .16); }
  .card[hidden] { display: none; }
  .card .thumb { display: block; aspect-ratio: 16 / 9; background: repeating-linear-gradient(90deg, transparent 0 26px, rgba(254, 164, 90, .16) 26px 32px), linear-gradient(135deg, var(--dark), var(--ink)); border-bottom: 4px solid var(--orange); overflow: hidden; }
  .card .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .35s; }
  .card:hover .thumb img { transform: scale(1.05); }
  .card .body { padding: 20px 22px 24px; display: flex; flex-direction: column; flex: 1; }
  .card .meta { color: var(--muted); font-size: .8rem; margin-bottom: 6px; }
  .card .meta b { color: var(--link); text-transform: uppercase; letter-spacing: .04em; }
  .card h2 { font-size: 1.15rem; line-height: 1.4; margin: 0 0 10px; }
  .card h2 a { color: var(--ink); text-decoration: none; }
  .card h2 a:hover { color: var(--link); }
  .card p { margin: 0 0 14px; font-size: .93rem; color: var(--text); }
  .card .body > p:not(.meta) { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .card .more-link { margin-top: auto; font-weight: 700; font-size: .9rem; text-decoration: none; }
  .loadmore { text-align: center; margin-top: 36px; }
  .loadmore button { font: inherit; border: 0; cursor: pointer; }
  .empty { text-align: center; color: var(--muted); padding: 40px 0; }
  .site-footer { background: var(--footer); color: #d4d7da; font-size: .9rem; }
  .site-footer .wrap { padding-top: 36px; padding-bottom: 28px; display: flex; flex-wrap: wrap; gap: 20px 40px; justify-content: space-between; align-items: center; }
  .site-footer a { color: #fff; text-decoration: none; }
  .site-footer a:hover { color: var(--orange); }
  .site-footer nav a { margin-right: 18px; }
  .site-footer p { margin: 0; }
  @media (max-width: 900px) { .grid { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 760px) {
    .burger { display: block; width: 44px; height: 44px; cursor: pointer; border-radius: 8px; position: relative; }
    .burger span, .burger span::before, .burger span::after { position: absolute; left: 10px; right: 10px; height: 3px; background: #fff; border-radius: 2px; content: ""; }
    .burger span { top: 20px; } .burger span::before { top: -8px; left: 0; right: 0; } .burger span::after { top: 8px; left: 0; right: 0; }
    .nav { display: none; position: absolute; top: 100%; left: 0; right: 0; background: var(--dark); flex-direction: column; align-items: stretch; padding: 8px 20px 18px; border-top: 1px solid #4a4a4a; }
    .nav-toggle:checked ~ .nav { display: flex; }
    .nav a { padding: 12px 6px; } .nav a.btn-cta { margin: 8px 0 0; text-align: center; }
    .hero .wrap { padding-top: 36px; padding-bottom: 40px; }
    .grid { grid-template-columns: 1fr; }
  }
`;

const HEADER = `<header class="site-header"><div class="bar">
  <a class="brand" href="{{SITE_URL}}/"><!--LOGO--><img src="{{LOGO_URL}}" alt="{{BUSINESS_NAME}}" height="56"><!--/LOGO--><!--NOLOGO--><span>{{BUSINESS_NAME}}</span><!--/NOLOGO--></a>
  <input type="checkbox" id="nav-toggle" class="nav-toggle" aria-label="Open the menu"><label for="nav-toggle" class="burger"><span></span></label>
  <nav class="nav" aria-label="Main">{{NAV}}<a class="btn-cta" href="{{QUOTE_URL}}">Free Estimate</a></nav>
</div></header>`;

const FOOTER = `<footer class="site-footer"><div class="wrap">
  <p>&copy; {{YEAR}} {{BUSINESS_NAME}} · {{CITY}}, {{REGION}}<!--PHONE--> · <a href="tel:{{PHONE}}">{{PHONE}}</a><!--/PHONE--></p>
  <nav aria-label="Footer">{{NAV}}</nav>
</div></footer>`;

const HEAD_COMMON = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="{{FAVICON_URL}}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap">`;

const POST_TEMPLATE = `<!DOCTYPE html>
<html lang="en-CA">
<head>
${HEAD_COMMON}
<title>{{TITLE}} | {{BUSINESS_NAME}}</title>
<meta name="description" content="{{META_DESCRIPTION}}">
<meta name="robots" content="index, follow, max-image-preview:large">
<link rel="canonical" href="{{CANONICAL}}">
<meta property="og:type" content="article">
<meta property="og:title" content="{{TITLE}}">
<meta property="og:description" content="{{META_DESCRIPTION}}">
<meta property="og:url" content="{{CANONICAL}}">
<meta property="og:image" content="{{IMAGE_URL}}">
<meta property="article:published_time" content="{{DATE}}">
{{SCHEMA}}
<style>${CSS}</style>
</head>
<body>
${HEADER}
<main>
  <section class="hero"><div class="wrap">
    <div class="crumbs"><a href="{{SITE_URL}}/">Home</a> › <a href="{{BLOG_URL}}">Articles</a> › {{CATEGORY}}</div>
    <h1>{{TITLE}}</h1>
    <p class="meta"><span class="tag">{{CATEGORY}}</span> &nbsp; {{DATE_HUMAN}} · {{READ_TIME}} min read</p>
  </div></section>
  <!--HERO--><div class="hero-wrap"><img class="hero-img" src="{{IMAGE}}" alt="{{IMAGE_ALT}}" width="1200" height="675"></div><!--/HERO-->
  <article class="article-wrap">
    <div class="content">
{{BODY}}
    </div>
    <div class="cta">
      <h2>Get a free fence quote</h2>
      <p>{{BUSINESS_NAME}} builds and repairs fences across {{CITY}}. Tell us about your yard and we will get back to you with a clear price. <a href="{{SERVICE_URL}}" style="color:var(--orange)">See our {{SERVICE_NAME}} work →</a></p>
      <a class="btn" href="{{QUOTE_URL}}">Get My Free Quote</a><!--PHONE--><a class="call" href="tel:{{PHONE}}">or call {{PHONE}}</a><!--/PHONE-->
    </div>
    <a class="back" href="{{BLOG_URL}}">← All articles</a>
  </article>
</main>
${FOOTER}
</body>
</html>`;

const CARD_TEMPLATE = `<article class="card" data-category="{{CATEGORY}}">
  <a class="thumb" href="{{URL}}" tabindex="-1" aria-hidden="true"><!--IMG--><img src="{{IMAGE}}" alt="" loading="lazy" width="600" height="338"><!--/IMG--></a>
  <div class="body">
    <p class="meta"><b>{{CATEGORY}}</b> · {{DATE_HUMAN}} · {{READ_TIME}} min</p>
    <h2><a href="{{URL}}">{{TITLE}}</a></h2>
    <p>{{EXCERPT}}</p>
    <a class="more-link" href="{{URL}}">Read the article →</a>
  </div>
</article>`;

// The server rewrites everything between the two markers on every publish; the rest of this page is yours.
const INDEX_TEMPLATE = `<!DOCTYPE html>
<html lang="en-CA">
<head>
${HEAD_COMMON}
<title>Fence, Deck &amp; Yard Articles for Winnipeg Homeowners | {{BUSINESS_NAME}}</title>
<meta name="description" content="Costs, rules, materials and tips for building a fence or deck in Winnipeg, from the team at {{BUSINESS_NAME}}.">
<link rel="canonical" href="{{BLOG_URL}}">
<meta property="og:type" content="website">
<meta property="og:title" content="Fence, Deck &amp; Yard Articles | {{BUSINESS_NAME}}">
<meta property="og:url" content="{{BLOG_URL}}">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"CollectionPage","name":"Articles","url":"{{BLOG_URL}}","publisher":{"@type":"Organization","name":"{{BUSINESS_NAME}}","url":"{{SITE_URL}}"}}</script>
<style>${CSS}</style>
</head>
<body>
${HEADER}
<main>
  <section class="hero"><div class="wrap">
    <div class="crumbs"><a href="{{SITE_URL}}/">Home</a> › Articles</div>
    <h1>Fence, Deck &amp; Yard Articles</h1>
    <p class="lead">Straight answers on costs, materials, city rules and timing for homeowners in {{CITY}}.</p>
  </div></section>
  <section class="listing"><div class="wrap">
    <div class="pills" id="pills" role="group" aria-label="Filter articles by category"></div>
    <div class="grid" id="grid">
<!-- 5sf:articles:start -->
{{CARDS}}
<!-- 5sf:articles:end -->
    </div>
    <p class="empty" id="empty" hidden>No articles in this category yet.</p>
    <div class="loadmore"><button class="btn" id="more" type="button" hidden>Show more articles</button></div>
  </div></section>
</main>
${FOOTER}
<script>
(function () {
  var cards = [].slice.call(document.querySelectorAll('#grid .card'));
  var pills = document.getElementById('pills'), more = document.getElementById('more'), empty = document.getElementById('empty');
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
      b.type = 'button'; b.className = 'pill' + (i === 0 ? ' active' : ''); b.textContent = name;
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
</script>
</body>
</html>`;

module.exports = { POST_TEMPLATE, CARD_TEMPLATE, INDEX_TEMPLATE };
