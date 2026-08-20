/**
 * Tanko cleanup: remove non-English chapters (queue jobs, DB rows, files) and
 * reset chapters whose file may hold the wrong language.
 *
 * Multilingual sources (MangaDex) list the same chapter once per language, and
 * all variants map to the SAME on-disk path (<Serie>/<Chapter>.cbz — the native
 * chapter title carries no language): whichever language downloaded first won
 * the file. This script drops the rows we do not want, deletes files only
 * claimed by them, and deletes shared files so the kept chapter re-downloads
 * in the preferred language.
 *
 * Usage (server STOPPED), from the docker-compose folder:
 *   1. put this file in ./data/ next to docker-compose.yml (bind-mounted at /data)
 *   2. cp data/hakuneko.db data/hakuneko.db.bak   (safety net)
 *   3. docker compose stop tanko
 *   4. docker compose run --rm --no-deps tanko node /data/purge-languages.cjs
 *   5. docker compose start tanko
 *
 * KEEP_LANG: comma-separated ISO codes to keep ('en' by default). Chapters with
 * an unknown language (NULL) are always kept.
 */
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const KEEP_LANG = 'en'; // e.g. 'en,fr'
const DB_FILE = '/data/hakuneko.db';

const keep = new Set(KEEP_LANG.split(',').map(s => s.trim()).filter(Boolean));
const isKeep = row => row.language == null || keep.has(row.language);

const db = new DatabaseSync(DB_FILE);

// --- 1. stuck queue: purge pending jobs, un-mark chapters -------------------
const jobsPurged = db.prepare("DELETE FROM download_jobs WHERE status IN ('queued','downloading')").run().changes;
const chaptersReset = db.prepare("UPDATE library_chapters SET status='new' WHERE status='queued'").run().changes;

// --- 2. classify chapter rows -----------------------------------------------
const rows = db.prepare('SELECT rowid, entry_id, chapter_id, title, language, status, path FROM library_chapters').all();
const dropRows = rows.filter(r => !isKeep(r));
const keepRows = rows.filter(isKeep);

// files claimed by a kept chapter (by path, or by entry+title -> same target)
const keepPaths = new Set(keepRows.filter(r => r.path).map(r => r.path));
const keepKeys = new Set(keepRows.map(r => `${r.entry_id}||${r.title}`));

// kept chapters to reset: their file is shared with a dropped language variant
const tainted = new Map(); // rowid -> { kept, file }
for (const dropped of dropRows) {
    if (!dropped.path) continue;
    const key = `${dropped.entry_id}||${dropped.title}`;
    for (const kept of keepRows) {
        if (kept.path === dropped.path || `${kept.entry_id}||${kept.title}` === key) {
            tainted.set(kept.rowid, { kept, file: dropped.path });
        }
    }
}

// --- 3. apply ---------------------------------------------------------------
const delHistory = db.prepare('DELETE FROM chapter_history WHERE entry_id = ? AND chapter_id = ?');
const delRow = db.prepare('DELETE FROM library_chapters WHERE rowid = ?');
const delJobByChapter = db.prepare('DELETE FROM download_jobs WHERE chapter_id = ?');
const resetRow = db.prepare("UPDATE library_chapters SET status='new', path=NULL, downloaded_at=NULL WHERE rowid = ?");

let rowsDropped = 0;
let filesDeleted = 0;
const removedFiles = new Set();

const removeFile = target => {
    if (!target || removedFiles.has(target)) return;
    removedFiles.add(target);
    try {
        fs.rmSync(target, { recursive: true, force: true });
        filesDeleted++;
    } catch (error) {
        console.warn('  could not delete', target, '-', error.message);
    }
};

// dropped rows: remove row + history + job; delete the file unless a kept
// chapter also claims it (handled below via taint)
for (const row of dropRows) {
    delHistory.run(row.entry_id, row.chapter_id);
    delJobByChapter.run(row.chapter_id);
    delRow.run(row.rowid);
    rowsDropped++;
    if (row.path && !keepPaths.has(row.path) && !keepKeys.has(`${row.entry_id}||${row.title}`)) {
        removeFile(row.path); // file owned by a dropped language only
    }
}

// tainted kept chapters: delete the shared file (whichever row recorded it),
// reset the row, clear its job (an old 'completed' job would block re-enqueue)
for (const { kept, file } of tainted.values()) {
    delJobByChapter.run(kept.chapter_id);
    resetRow.run(kept.rowid);
    removeFile(file);
}

console.log(`jobs purged (queued/downloading): ${jobsPurged}`);
console.log(`chapters un-marked from 'queued': ${chaptersReset}`);
console.log(`non-${KEEP_LANG} rows dropped: ${rowsDropped}`);
console.log(`files deleted: ${filesDeleted}`);
console.log(`kept chapters flagged for re-download (file was shared): ${tainted.size}`);
console.log('Next: start the server, then "Download new chapters" per series (or wait for auto-download).');
db.close();
