// On-page facts the index watch needs from one HTML page.
const crypto = require('crypto');
const cheerio = require('cheerio');

function extractPageFacts(html) {
  const $ = cheerio.load(String(html || ''));
  const robots = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
  const links = [];
  $('a[href]').each((_, el) => { links.push($(el).attr('href')); });
  $('script, style, noscript, template').remove();
  // tags become spaces so "<h1>Fence</h1><p>repair" counts as two words; cheerio then decodes entities
  const text = cheerio.load(`<p>${($('body').html() || '').replace(/<[^>]+>/g, ' ')}</p>`)('p').text().replace(/\s+/g, ' ').trim();
  return {
    title: $('title').first().text().replace(/\s+/g, ' ').trim() || null,
    h1: $('h1').first().text().replace(/\s+/g, ' ').trim() || null,
    h1Count: $('h1').length,
    canonical: $('link[rel="canonical"]').attr('href')?.trim() || null,
    noindex: /\bnoindex\b/.test(robots),
    description: $('meta[name="description"]').attr('content')?.trim() || null,
    wordCount: text ? text.split(' ').length : 0,
    contentHash: crypto.createHash('sha1').update(text.toLowerCase()).digest('hex'),
    links,
  };
}

module.exports = { extractPageFacts };
