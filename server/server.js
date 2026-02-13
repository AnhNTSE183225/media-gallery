const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const config = require('./config.json');

const app = express();
const db = new Database('library.db');
const PORT = 3001;

app.use(cors());
app.use(express.json());

// --- DATABASE SETUP ---
db.exec(`
  CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE,
    type TEXT,       -- 'image' or 'story'
    artist TEXT,
    name TEXT,       -- filename for images, folder name for stories
    pages TEXT,      -- JSON array of file paths if it is a story
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS asset_tags (
    asset_id INTEGER,
    tag TEXT,
    FOREIGN KEY(asset_id) REFERENCES assets(id)
  );
`);

// --- SCANNER LOGIC ---
const insertAsset = db.prepare(`INSERT OR REPLACE INTO assets (path, type, artist, name, pages) VALUES (?, ?, ?, ?, ?)`);
const insertTag = db.prepare(`INSERT INTO asset_tags (asset_id, tag) VALUES (?, ?)`);
const clearTags = db.prepare(`DELETE FROM asset_tags WHERE asset_id = ?`);

function getFilesRecursively(dir) {
    let results = [];
    try {
        const list = fs.readdirSync(dir);
        list.forEach(file => {
            const filePath = path.join(dir, file);
            const stat = fs.statSync(filePath);
            if (stat && stat.isDirectory()) {
                results = results.concat(getFilesRecursively(filePath));
            } else {
                if (config.allowedExtensions.includes(path.extname(file).toLowerCase())) {
                    results.push(filePath);
                }
            }
        });
    } catch (err) {
        console.warn(`Skipping directory ${dir}: ${err.message}`);
    }
    return results.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

function scanDirectory(dirPath, artistName = null, currentTags = []) {
    if (!fs.existsSync(dirPath)) return;

    const items = fs.readdirSync(dirPath);

    for (const item of items) {
        const fullPath = path.join(dirPath, item);
        let stat;
        try {
            stat = fs.statSync(fullPath);
        } catch (e) {
            continue; // Skip if can't stat
        }

        if (stat.isDirectory()) {
            // LOGIC: First folder is ALWAYS Artist
            if (!artistName) {
                scanDirectory(fullPath, item, []); // Set artist, start fresh tags
                continue;
            }

            // LOGIC: Check Strict Allowlist
            if (config.allowedTags.includes(item)) {
                // It's a Tag -> Go deeper
                scanDirectory(fullPath, artistName, [...currentTags, item]);
            } else {
                // It's NOT a Tag -> It is a STORY (Strict Mode)
                // We stop checking tags and consume everything inside as pages
                const storyPages = getFilesRecursively(fullPath);

                if (storyPages.length > 0) {
                    const result = insertAsset.run(fullPath, 'story', artistName, item, JSON.stringify(storyPages));
                    clearTags.run(result.lastInsertRowid);
                    currentTags.forEach(tag => insertTag.run(result.lastInsertRowid, tag));
                    console.log(`[Story] Indexed: ${item} (${storyPages.length} pages)`);
                }
            }
        } else {
            // It is a File -> It is a STANDALONE IMAGE
            if (artistName && config.allowedExtensions.includes(path.extname(item).toLowerCase())) {
                const result = insertAsset.run(fullPath, 'image', artistName, item, null);
                clearTags.run(result.lastInsertRowid);
                currentTags.forEach(tag => insertTag.run(result.lastInsertRowid, tag));
                // console.log(`[Image] Indexed: ${item}`);
            }
        }
    }
}

// --- API ENDPOINTS ---

// 1. Trigger Scan
app.post('/api/scan', (req, res) => {
    console.log("Starting Scan...");
    try {
        scanDirectory(config.rootDirectory);
        res.json({ success: true, message: "Scan complete" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// 2. Search
app.get('/api/search', (req, res) => {
    const { q } = req.query; // q = "tag1,tag2"

    let sql = `SELECT DISTINCT a.* FROM assets a`;
    const params = [];

    if (q) {
        const tags = q.split(',').map(t => t.trim());
        // This SQL ensures the asset has ALL the searched tags
        if (tags.length > 0 && tags[0] !== '') {
            const placeholders = tags.map(() => '?').join(',');
            sql += ` JOIN asset_tags at ON a.id = at.asset_id WHERE at.tag IN (${placeholders}) GROUP BY a.id HAVING COUNT(DISTINCT at.tag) = ?`;
            params.push(...tags, tags.length);
        }
    }

    // Order by Artist then Name
    sql += ` ORDER BY a.artist ASC, a.name ASC`;

    const rows = db.prepare(sql).all(...params);

    // Parse pages JSON for stories
    const results = rows.map(r => ({
        ...r,
        pages: r.pages ? JSON.parse(r.pages) : null
    }));

    res.json(results);
});

// 3. Serve Media (Crucial for local file access)
app.get('/api/media', (req, res) => {
    const filePath = req.query.path;
    if (!filePath || !fs.existsSync(filePath)) return res.sendStatus(404);
    res.sendFile(filePath);
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
