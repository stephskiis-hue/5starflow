"""Unit tests for wfp/blog_publish.py's pure helpers. Run by test/wfp.test.js (python3 -I)."""
import importlib.util
import os
import sys
import unittest

spec = importlib.util.spec_from_file_location("blog_publish", os.path.join(os.environ["WFP_SCRIPT_DIR"], "blog_publish.py"))
bp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bp)

INDEX = """<script>
      var POSTS = [
        {
          title:    'Fence Permits in Winnipeg',
          date:     '2026-09-01',
          image:    '/images/permits.webp',
          excerpt:  'Do you need a permit? It\\'s simple.',
          url:      '/fence-permits.html',
          category: 'Fencing',
          readTime: 5
        }
      ];
</script>"""


class TestIndex(unittest.TestCase):
    def test_parse_keeps_escaped_quotes(self):
        posts = bp.parse_posts(INDEX)
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0]["excerpt"], "Do you need a permit? It's simple.")
        self.assertEqual(posts[0]["readTime"], 5)

    def test_patch_adds_newest_first_and_round_trips(self):
        entry = {"title": "Cedar Fence Cost", "date": "2026-10-21", "image": "/images/cedar.webp", "excerpt": "Real prices.", "url": "/cedar.html", "category": "Fencing", "readTime": 7}
        html, n = bp.patch_posts(INDEX, entry)
        self.assertEqual(n, 2)
        posts = bp.parse_posts(html)
        self.assertEqual([p["url"] for p in posts], ["/cedar.html", "/fence-permits.html"])
        self.assertEqual(posts[1]["excerpt"], "Do you need a permit? It's simple.")
        # same url again = replaced, not duplicated
        html2, n2 = bp.patch_posts(html, {**entry, "title": "Cedar Fence Cost (updated)"})
        self.assertEqual(n2, 2)
        self.assertEqual(bp.parse_posts(html2)[0]["title"], "Cedar Fence Cost (updated)")

    def test_unreadable_array_is_left_alone(self):
        self.assertIsNone(bp.parse_posts("<p>no array</p>"))
        self.assertIsNone(bp.parse_posts("var POSTS = [ makePost('x') ];"))
        new, why = bp.patch_posts("<p>none</p>", {"url": "/x"})
        self.assertIsNone(new)


SITEMAP = """<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://www.wpgfence.ca/</loc>
    <lastmod>2026-01-01</lastmod>
  </url>
</urlset>"""


class TestSitemap(unittest.TestCase):
    def test_add_then_update(self):
        xml, action = bp.patch_sitemap(SITEMAP, "https://www.wpgfence.ca/cedar.html", "2026-10-21")
        self.assertEqual(action, "added")
        self.assertIn("<loc>https://www.wpgfence.ca/cedar.html</loc>", xml)
        self.assertTrue(xml.rstrip().endswith("</urlset>"))
        xml2, action2 = bp.patch_sitemap(xml, "https://www.wpgfence.ca/cedar.html", "2026-11-01")
        self.assertEqual(action2, "updated")
        self.assertEqual(xml2.count("cedar.html"), 1)
        self.assertIn("<lastmod>2026-11-01</lastmod>", xml2)
        self.assertIn("<lastmod>2026-01-01</lastmod>", xml2)  # other urls untouched

    def test_index_and_broken_files_are_refused(self):
        self.assertIsNone(bp.patch_sitemap('<sitemapindex><sitemap><loc>x</loc></sitemap></sitemapindex>', "https://a/b", "2026-10-21")[0])
        self.assertIsNone(bp.patch_sitemap("<html></html>", "https://a/b", "2026-10-21")[0])

    def test_remote_paths(self):
        env = {"FTP_PATH": "/public_html/"}
        self.assertEqual(bp.remote(env, "blog", "x.html"), "/public_html/blog/x.html")
        self.assertEqual(bp.remote(env, "", "sitemap.xml"), "/public_html/sitemap.xml")
        self.assertEqual(bp.remote({"FTP_PATH": "/"}, "images"), "/images")


LIST = """<main><div class="grid">
<!-- 5sf:articles:start -->
<article>old card</article>
<!-- 5sf:articles:end -->
</div></main>"""


class TestListPage(unittest.TestCase):
    def test_cards_replace_what_is_between_markers_only(self):
        out = bp.apply_cards(LIST, "<article>A</article>\n<article>B</article>")
        self.assertIn("<article>A</article>\n<article>B</article>", out)
        self.assertNotIn("old card", out)
        self.assertTrue(out.startswith("<main>") and out.rstrip().endswith("</main>"))
        # re-applying with different cards is stable (no duplicates)
        again = bp.apply_cards(out, "<article>C</article>")
        self.assertEqual(again.count("5sf:articles:start"), 1)
        self.assertNotIn("<article>A</article>", again)
        self.assertIsNone(bp.apply_cards("<p>no markers</p>", "x"))

    def test_update_index_paths(self):
        entry = {"title": "T", "date": "2026-10-21", "image": "", "excerpt": "e", "url": "/articles/t/", "category": "Fence", "readTime": 4}
        # markers win
        html, how = bp.update_index(LIST, "CARDS", None, entry)
        self.assertEqual(how, "markers")
        # missing page: created from the template
        html, how = bp.update_index(None, "CARDS", LIST, entry)
        self.assertEqual(how, "created")
        self.assertIn("CARDS", html)
        self.assertEqual(bp.update_index(None, "CARDS", None, entry)[0], None)
        # old inline array still works when there are no markers
        html, how = bp.update_index(INDEX, None, None, entry)
        self.assertEqual(how, "posts-array")
        # neither: untouched
        self.assertIsNone(bp.update_index("<p>x</p>", "CARDS", None, entry)[0])

    def test_card_image_token(self):
        cards = '<a><img src="__WFP_IMAGE__" alt="" loading="lazy"></a><a><img src="/images/old.webp"></a>'
        self.assertIn('src="/images/new.webp"', bp.fix_card_image(cards, "/images/new.webp"))
        none = bp.fix_card_image(cards, "")
        self.assertNotIn("__WFP_IMAGE__", none)
        self.assertIn("/images/old.webp", none)
        self.assertEqual(none.count("<img"), 1)
        self.assertIsNone(bp.fix_card_image(None, "x"))


class TestSitemapRemoval(unittest.TestCase):
    XML = """<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
       <loc>https://www.wpgfence.ca/</loc>
  </url>
  <url>
       <loc>https://www.wpgfence.ca/blog/</loc>
  </url>
  <url>
       <loc>https://www.wpgfence.ca/blog/old-post/</loc>
  </url>
  <url>
       <loc>https://www.wpgfence.ca/blogger/</loc>
  </url>
</urlset>"""

    def test_prefix_removal_keeps_lookalikes(self):
        xml, n = bp.remove_sitemap_urls(self.XML, ["https://www.wpgfence.ca/blog/"])
        self.assertEqual(n, 2)
        self.assertNotIn("old-post", xml)
        self.assertIn("https://www.wpgfence.ca/</loc>", xml)
        self.assertIn("/blogger/", xml)
        self.assertTrue(xml.rstrip().endswith("</urlset>"))


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=1).result
    sys.exit(0 if result.wasSuccessful() else 1)
