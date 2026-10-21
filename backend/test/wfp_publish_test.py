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


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=1).result
    sys.exit(0 if result.wasSuccessful() else 1)
