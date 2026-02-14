const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const config = require('./config.json');

const app = express();
// Using v4 to force a fresh database creation because previous attempts failed or were reverted
const db = new Database('library_v4.db');
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Disable compression for SSE endpoints
app.use((req, res, next) => {
    if (req.path.includes('/progress')) {
        res.set('X-No-Compression', '1');
    }
    next();
});

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

// Progress tracking
let scanProgress = { current: 0, total: 0, status: 'idle', currentItem: '' };
let progressClients = [];

function broadcastProgress() {
    const data = `data: ${JSON.stringify(scanProgress)}\n\n`;
    console.log(`Broadcasting to ${progressClients.length} clients:`, scanProgress);
    progressClients.forEach(client => {
        try {
            client.write(data);
        } catch (err) {
            console.error('Error writing to client:', err.message);
        }
    });
}

function countArtists(dirPath) {
    if (!fs.existsSync(dirPath)) return 0;
    try {
        const items = fs.readdirSync(dirPath);
        return items.filter(item => {
            try {
                const stat = fs.statSync(path.join(dirPath, item));
                return stat.isDirectory();
            } catch (e) {
                return false;
            }
        }).length;
    } catch (err) {
        return 0;
    }
}

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

async function scanDirectory(dirPath, artistName = null, currentTags = []) {
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
                scanProgress.current++;
                // Update total if we discover more artists than initially counted
                if (scanProgress.current > scanProgress.total) {
                    scanProgress.total = scanProgress.current;
                }
                scanProgress.currentItem = item;
                broadcastProgress();
                // Yield to event loop to allow SSE messages to flush
                await new Promise(resolve => setImmediate(resolve));
                await scanDirectory(fullPath, item, []); // Set artist, start fresh tags
                continue;
            }

            // LOGIC: Check Strict Allowlist (supports multi-tagging with +)
            // Split folder name by + to support multiple tags in one folder
            const folderTags = item.split('+').map(t => t.trim());
            const allTagsValid = folderTags.every(tag => config.allowedTags.includes(tag));
            
            if (allTagsValid && folderTags.length > 0) {
                // All parts are valid tags -> Add all tags and go deeper
                await scanDirectory(fullPath, artistName, [...currentTags, ...folderTags]);
            } else {
                // It's NOT a Tag -> It is a STORY (Strict Mode)
                // We stop checking tags and consume everything inside as pages
                const storyPages = getFilesRecursively(fullPath);

                if (storyPages.length > 0) {
                    const result = insertAsset.run(fullPath, 'story', artistName, item, JSON.stringify(storyPages));
                    // Tags are auto-deleted by ON DELETE CASCADE if replaced
                    // Add "Story" tag automatically
                    insertTag.run(result.lastInsertRowid, 'Story');
                    // Deduplicate tags before inserting
                    const uniqueTags = [...new Set(currentTags)];
                    uniqueTags.forEach(tag => insertTag.run(result.lastInsertRowid, tag));
                    console.log(`[Story] Indexed: ${item} (${storyPages.length} pages)`);
                }
            }
        } else {
            // It is a File -> It is a STANDALONE IMAGE
            if (artistName && config.allowedExtensions.includes(path.extname(item).toLowerCase())) {
                const result = insertAsset.run(fullPath, 'image', artistName, item, null);
                // Tags are auto-deleted by ON DELETE CASCADE if replaced
                // Deduplicate tags before inserting
                const uniqueTags = [...new Set(currentTags)];
                uniqueTags.forEach(tag => insertTag.run(result.lastInsertRowid, tag));
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
app.post('/api/scan', async (req, res) => {
    console.log("Starting Scan...");
    try {
        // Count artists for progress tracking
        scanProgress = {
            current: 0,
            total: countArtists(config.rootDirectory),
            status: 'scanning',
            currentItem: ''
        };
        broadcastProgress();
        
        await scanDirectory(config.rootDirectory);
        
        scanProgress.status = 'complete';
        broadcastProgress();
        
        res.json({ success: true, message: "Scan complete" });
    } catch (err) {
        console.error(err);
        scanProgress.status = 'error';
        broadcastProgress();
        res.status(500).json({ error: err.message });
    }
});

// 2a. Progress Stream (SSE)
app.get('/api/scan/progress', (req, res) => {
    console.log('SSE client connected');
    
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    
    // Flush headers immediately
    res.flushHeaders();
    
    // Send current progress immediately
    res.write(`data: ${JSON.stringify(scanProgress)}\n\n`);
    console.log('Sent initial progress:', scanProgress);
    
    // Add client to list
    progressClients.push(res);
    console.log(`Total clients: ${progressClients.length}`);
    
    // Send heartbeat every 15 seconds to keep connection alive
    const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
    }, 15000);
    
    // Remove client when they disconnect
    req.on('close', () => {
        clearInterval(heartbeat);
        progressClients = progressClients.filter(client => client !== res);
        console.log(`Client disconnected. Remaining clients: ${progressClients.length}`);
    });
});

// Parse tag query with AND, OR, NOT operators
function parseTagQuery(queryString) {
    if (!queryString) return { and: [], or: [], not: [] };
    
    const result = { and: [], or: [], not: [] };
    
    // Split by comma for AND groups, then check each part
    const parts = queryString.split(',').map(t => t.trim()).filter(t => t !== '');
    
    for (const part of parts) {
        if (part.startsWith('-')) {
            // NOT operator
            result.not.push(part.substring(1).trim());
        } else if (part.includes('|')) {
            // OR operator - split by pipe
            const orTags = part.split('|').map(t => t.trim()).filter(t => t !== '');
            result.or.push(...orTags);
        } else {
            // Default AND operator
            result.and.push(part);
        }
    }
    
    return result;
}

// 3. Search
app.get('/api/search', (req, res) => {
    const { q, text } = req.query; // q = tags, text = artist/name query

    // Clean query builder
    let baseSql = `SELECT DISTINCT a.*, (SELECT GROUP_CONCAT(tag) FROM asset_tags WHERE asset_id = a.id) as tags FROM assets a`;
    let params = [];
    let whereClauses = [];
    let havingClause = "";

    // 1. Parse and handle Tags with AND/OR/NOT logic
    if (q) {
        const parsedQuery = parseTagQuery(q);
        const needsJoin = parsedQuery.and.length > 0 || parsedQuery.or.length > 0;
        
        if (needsJoin) {
            baseSql += ` JOIN asset_tags at ON a.id = at.asset_id`;
        }
        
        // Handle AND tags (must have ALL)
        if (parsedQuery.and.length > 0) {
            const placeholders = parsedQuery.and.map(() => '?').join(',');
            whereClauses.push(`at.tag IN (${placeholders})`);
            params.push(...parsedQuery.and);
            
            // HAVING clause to ensure ALL AND tags are present
            havingClause = `GROUP BY a.id HAVING COUNT(DISTINCT at.tag) >= ?`;
        }
        
        // Handle OR tags (must have AT LEAST ONE)
        if (parsedQuery.or.length > 0) {
            if (parsedQuery.and.length === 0) {
                // If no AND tags, we need a simpler query
                const placeholders = parsedQuery.or.map(() => '?').join(',');
                whereClauses.push(`at.tag IN (${placeholders})`);
                params.push(...parsedQuery.or);
                
                if (!havingClause) {
                    havingClause = `GROUP BY a.id`;
                }
            } else {
                // If we have both AND and OR, use subquery approach
                const orPlaceholders = parsedQuery.or.map(() => '?').join(',');
                whereClauses.push(`(at.tag IN (${[...parsedQuery.and.map(() => '?'), ...parsedQuery.or.map(() => '?')].join(',')}))`);
                // We already pushed AND tags, now push OR tags
                params.push(...parsedQuery.or);
                
                // Modify HAVING to require AND tags + at least one OR tag
                havingClause = `GROUP BY a.id HAVING 
                    SUM(CASE WHEN at.tag IN (${parsedQuery.and.map(() => '?').join(',')}) THEN 1 ELSE 0 END) = ? 
                    ${parsedQuery.or.length > 0 ? `AND SUM(CASE WHEN at.tag IN (${parsedQuery.or.map(() => '?').join(',')}) THEN 1 ELSE 0 END) >= 1` : ''}`;
            }
        }
        
        // Handle NOT tags (must NOT have ANY)
        if (parsedQuery.not.length > 0) {
            const notPlaceholders = parsedQuery.not.map(() => '?').join(',');
            whereClauses.push(`a.id NOT IN (
                SELECT asset_id FROM asset_tags WHERE tag IN (${notPlaceholders})
            )`);
            params.push(...parsedQuery.not);
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

    // 4. Append HAVING clause and its parameters
    if (havingClause) {
        baseSql += ` ${havingClause}`;
        
        // Add parameters for HAVING clause
        if (q) {
            const parsedQuery = parseTagQuery(q);
            if (parsedQuery.and.length > 0 && parsedQuery.or.length > 0) {
                // Complex case with both AND and OR
                params.push(...parsedQuery.and); // For first CASE check
                params.push(parsedQuery.and.length); // For count
                if (parsedQuery.or.length > 0) {
                    params.push(...parsedQuery.or); // For second CASE check
                }
            } else if (parsedQuery.and.length > 0) {
                // Only AND tags
                params.push(parsedQuery.and.length);
            }
            // OR only doesn't need extra params
        }
    }

    try {
        // --- SORTING & PAGINATION LOGIC ---
        // Note: We sort in JavaScript with natural sort instead of SQL to handle numeric filenames correctly
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 12; // Default 12 items per page for better performance
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
app.get('/api/media', async (req, res) => {
    const filePath = req.query.path;
    const thumbnail = req.query.thumbnail === 'true';
    
    if (!filePath) {
        console.error("Media 400: No path provided");
        return res.sendStatus(400);
    }
    if (!fs.existsSync(filePath)) {
        console.error(`Media 404: File not found: ${filePath}`);
        return res.sendStatus(404);
    }
    
    const ext = path.extname(filePath).toLowerCase();
    const isImage = ['.png', '.jpg', '.jpeg', '.gif'].includes(ext);
    const isVideo = ['.mp4', '.webm', '.mkv', '.mov'].includes(ext);
    
    // If thumbnail requested and it's an image, resize on-the-fly
    if (thumbnail && isImage) {
        try {
            const resized = await sharp(filePath)
                .resize(400, 600, { fit: 'cover', position: 'center' })
                .jpeg({ quality: 80 })
                .toBuffer();
            
            res.set('Content-Type', 'image/jpeg');
            res.set('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
            res.send(resized);
        } catch (err) {
            // If resize fails, fall back to original
            res.sendFile(filePath, { dotfiles: 'allow' });
        }
    } else {
        // Videos and full-size images
        res.sendFile(filePath, { dotfiles: 'allow' }, (err) => {
            // Suppress normal client-aborted errors (happens with video seeking/scrolling)
            if (err && err.code !== 'ECONNABORTED' && err.code !== 'ECANCELED') {
                console.error(`Media Error sending ${filePath}:`, err);
            }
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});