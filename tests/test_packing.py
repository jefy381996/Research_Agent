"""The library ships packed, and has to come back exactly.

A git host refuses a file over 100 MB, and the library was being cut down to
fit: make_shippable dropped thousands of the least-cited abstracts purely to
get under the line. The database compresses about five times, so the archive
ships and the database is unpacked from it on first use. That makes the
archive the only copy that ships, so these tests care about one thing above
all - that what comes out is byte for byte what went in.
"""
import hashlib
import io
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import db
import pack_db


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for b in iter(lambda: fh.read(1 << 16), b""):
            h.update(b)
    return h.hexdigest()


class PackingRoundTrips(unittest.TestCase):

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "library.db")
        conn = db.init(self.path)
        conn.execute("INSERT INTO papers(openalex_id, title, abstract, year)"
                     " VALUES(?,?,?,?)",
                     ("W1", "A paper", "An abstract with words in it. " * 50, 2024))
        conn.commit()
        conn.close()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_what_is_packed_comes_back_byte_for_byte(self):
        for fmt in ("zst", "xz"):
            want = sha(self.path)
            archive = pack_db.pack(self.path, fmt, pack_db.LEVELS[fmt])
            out = self.path + f".{fmt}.check"
            db._unpack(archive, out)
            self.assertEqual(sha(out), want, fmt)
            os.remove(out)

    def test_a_checkout_with_only_the_archive_still_opens(self):
        pack_db.pack(self.path, "zst", 10)
        os.remove(self.path)
        self.assertFalse(os.path.exists(self.path))
        conn = db.connect(self.path)          # what every entry point calls
        self.assertEqual(
            conn.execute("SELECT count(*) FROM papers").fetchone()[0], 1)
        conn.close()
        self.assertTrue(os.path.exists(self.path))

    def test_an_archive_is_not_unpacked_over_a_newer_database(self):
        # Unpacking on every connection would throw away a collection run.
        pack_db.pack(self.path, "zst", 10)
        conn = db.connect(self.path)
        conn.execute("INSERT INTO papers(openalex_id, title, year)"
                     " VALUES('W2','Collected since',2025)")
        conn.commit()
        conn.close()
        # Explicit times: both files are written in the same second, and a tie
        # deliberately keeps the database, so a collection run is never lost.
        os.utime(self.path + ".zst", (1_000_000, 1_000_000))
        os.utime(self.path, (2_000_000, 2_000_000))
        conn = db.connect(self.path)
        self.assertEqual(
            conn.execute("SELECT count(*) FROM papers").fetchone()[0], 2)
        conn.close()

    def test_a_newer_archive_replaces_an_older_database(self):
        # A pull brings a new archive; the stale database must give way.
        conn = db.connect(self.path)
        conn.execute("INSERT INTO papers(openalex_id, title, year)"
                     " VALUES('W2','Second',2025)")
        conn.commit(); conn.close()
        pack_db.pack(self.path, "zst", 10)
        conn = db.connect(self.path)
        conn.execute("DELETE FROM papers WHERE openalex_id='W2'")
        conn.commit(); conn.close()
        os.utime(self.path, (1_000_000, 1_000_000))
        os.utime(self.path + ".zst", (2_000_000, 2_000_000))
        conn = db.connect(self.path)
        self.assertEqual(
            conn.execute("SELECT count(*) FROM papers").fetchone()[0], 2)
        conn.close()

    def test_a_broken_archive_does_not_destroy_a_working_database(self):
        pack_db.pack(self.path, "zst", 10)
        with open(self.path + ".zst", "wb") as fh:
            fh.write(b"this is not an archive")
        os.utime(self.path, (1_000_000, 1_000_000))
        os.utime(self.path + ".zst", (2_000_000, 2_000_000))
        conn = db.connect(self.path)          # must still open the old one
        self.assertEqual(
            conn.execute("SELECT count(*) FROM papers").fetchone()[0], 1)
        conn.close()

    def test_nothing_happens_where_there_is_no_archive(self):
        # Every temporary database in every other test takes this path.
        before = sha(self.path)
        db.ensure_database(self.path)
        self.assertEqual(sha(self.path), before)


class TheShippedArchive(unittest.TestCase):

    def test_the_real_archive_is_present_and_within_the_limit(self):
        archive = db.DB_PATH + ".zst"
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        archive = os.path.join(root, archive)
        if not os.path.exists(archive):
            self.skipTest("no packed library in this checkout")
        size = os.path.getsize(archive) / 1e6
        self.assertLess(size, 100, f"the archive is {size:.0f} MB; a git host "
                                   f"refuses it. Publish it as a release "
                                   f"asset and set DB_URL instead.")


if __name__ == "__main__":
    unittest.main()
