const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const config = require('./config.json');

const app = express();
// Using v4 to force a fresh database creation because previous attempts failed or were reverted
const db = new Database('library_v4.db');
const PORT = 3001;

app.use(cors());
app.use(express.json());

// --- DATABASE SETUP ---
// Enable Foreign Keys explicitly
db.pragma('foreign_keys = ON');

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
    FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
  );
`);

// --- SCANNER LOGIC ---
const insertAsset = db.prepare(`INSERT OR REPLACE INTO assets (path, type, artist, name, pages) VALUES (?, ?, ?, ?, ?)`);
const insertTag = db.prepare(`INSERT INTO asset_tags (asset_id, tag) VALUES (?, ?)`);
// clearTags is redundant with ON DELETE CASCADE but kept for safety/clarity if needed manually
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
                    // Tags are auto-deleted by ON DELETE CASCADE if replaced
                    currentTags.forEach(tag => insertTag.run(result.lastInsertRowid, tag));
                    console.log(`[Story] Indexed: ${item} (${storyPages.length} pages)`);
                }
            }
        } else {
            // It is a File -> It is a STANDALONE IMAGE
            if (artistName && config.allowedExtensions.includes(path.extname(item).toLowerCase())) {
                const result = insertAsset.run(fullPath, 'image', artistName, item, null);
                // Tags are auto-deleted by ON DELETE CASCADE if replaced
                currentTags.forEach(tag => insertTag.run(result.lastInsertRowid, tag));
                // console.log(`[Image] Indexed: ${item}`);
            }
        }
    }
}

// --- API ENDPOINTS ---

// 1. Reset Database (Clear all data)
app.post('/api/reset', (req, res) => {
    console.log("Resetting database...");
    try {
        db.prepare('DELETE FROM asset_tags').run();
        db.prepare('DELETE FROM assets').run();
        res.json({ success: true, message: "Database cleared" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// 2. Trigger Scan
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

// 3. Search
app.get('/api/search', (req, res) => {
    const { q, text } = req.query; // q = tags, text = artist/name query

    // Clean query builder
    let baseSql = `SELECT DISTINCT a.*, (SELECT GROUP_CONCAT(tag) FROM asset_tags WHERE asset_id = a.id) as tags FROM assets a`;
    let params = [];
    let whereClauses = [];
    let havingClause = "";

    // 1. Join for Tags
    if (q) {
        const tags = q.split(',').map(t => t.trim()).filter(t => t !== '');
        if (tags.length > 0) {
            const placeholders = tags.map(() => '?').join(',');
            baseSql += ` JOIN asset_tags at ON a.id = at.asset_id`;
            // Add to WHERE clause logic, usually combined with AND if other WHERE clauses exist
            // Important: This MUST be part of the WHERE clause before GROUP BY
            whereClauses.push(`at.tag IN (${placeholders})`);
            params.push(...tags);

            // Prepare HAVING clause for later
            havingClause = `GROUP BY a.id HAVING COUNT(DISTINCT at.tag) = ?`;
            // DO NOT push tags.length to params yet! Wait until we append HAVING clause to SQL.
        }
    }

    // 2. Filter by Text (Artist OR Name)
    if (text) {
        whereClauses.push(`(a.artist LIKE ? OR a.name LIKE ?)`);
        const likeQuery = `%${text}%`;
        params.push(likeQuery, likeQuery);
    }

    // 3. Assemble WHERE clause
    if (whereClauses.length > 0) {
        baseSql += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    // 4. Append HAVING clause and its parameter (if applicable)
    // Important: The order of params must match the order of placeholders in SQL string.
    // Order: [TAGS...], [TEXT, TEXT], [COUNT]
    if (havingClause) {
        baseSql += ` ${havingClause}`;
        // NOW push the count parameter
        const tags = q.split(',').map(t => t.trim()).filter(t => t !== '');
        params.push(tags.length);
    }

    try {
        // --- SORTING & PAGINATION LOGIC ---
        // Note: We sort in JavaScript with natural sort instead of SQL to handle numeric filenames correctly
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 24; // Default 24 items per page
        const offset = (page - 1) * limit;

        // 1. Get ALL results (no ORDER BY, LIMIT, or OFFSET yet)
        const rows = db.prepare(baseSql).all(...params);

        // 2. Parse pages JSON and tags CSV
        const parsedItems = rows.map(r => ({
            ...r,
            pages: r.pages ? JSON.parse(r.pages) : null,
            tags: r.tags ? r.tags.split(',') : []
        }));

        // 3. Sort with natural (numeric) sorting
        parsedItems.sort((a, b) => {
            // First sort by artist
            const artistCompare = a.artist.localeCompare(b.artist, undefined, { numeric: true, sensitivity: 'base' });
            if (artistCompare !== 0) return artistCompare;
            // Then by name
            return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });

        // 4. Apply pagination manually
        const total = parsedItems.length;
        const items = parsedItems.slice(offset, offset + limit);

        res.json({
            items,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (err) {
        console.error("Search Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 4. Serve Media (Crucial for local file access)
app.get('/api/media', (req, res) => {
    const filePath = req.query.path;
    if (!filePath) {
        console.error("Media 400: No path provided");
        return res.sendStatus(400);
    }
    if (!fs.existsSync(filePath)) {
        console.error(`Media 404: File not found: ${filePath}`);
        return res.sendStatus(404);
    }
    // console.log(`Serving: ${filePath}`); // Optional debug
    res.sendFile(filePath, { dotfiles: 'allow' }, (err) => {
        if (err) console.error(`Media Error sending ${filePath}:`, err);
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});