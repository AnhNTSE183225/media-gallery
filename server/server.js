const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { load: parseYaml } = require('js-yaml');

const app = express();
const PORT = 3001;
const APP_CONFIG_PATH = path.resolve(__dirname, '..', 'app-config.yaml');
const DEFAULT_APP_CONFIG = {
    itemsPerPage: 12,
    videoSkipSeconds: 3,
    keybinds: {
        previous: ['Digit1'],
        next: ['Digit2'],
        close: ['Escape']
    }
};

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function normalizeKeyArray(value, fallback) {
    if (!Array.isArray(value)) return fallback;
    const keys = value
        .map(item => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean);
    return keys.length > 0 ? keys : fallback;
}

function normalizeAppConfig(rawConfig) {
    const rawItemsPerPage = Number(rawConfig?.pagination?.itemsPerPage);
    const rawVideoSkipSeconds = Number(rawConfig?.viewer?.videoSkipSeconds);

    return {
        itemsPerPage: Number.isFinite(rawItemsPerPage)
            ? clamp(Math.floor(rawItemsPerPage), 1, 120)
            : DEFAULT_APP_CONFIG.itemsPerPage,
        videoSkipSeconds: Number.isFinite(rawVideoSkipSeconds) && rawVideoSkipSeconds > 0
            ? rawVideoSkipSeconds
            : DEFAULT_APP_CONFIG.videoSkipSeconds,
        keybinds: {
            previous: normalizeKeyArray(rawConfig?.keybinds?.previous, DEFAULT_APP_CONFIG.keybinds.previous),
            next: normalizeKeyArray(rawConfig?.keybinds?.next, DEFAULT_APP_CONFIG.keybinds.next),
            close: normalizeKeyArray(rawConfig?.keybinds?.close, DEFAULT_APP_CONFIG.keybinds.close)
        }
    };
}

function loadAppConfig() {
    try {
        const yamlText = fs.readFileSync(APP_CONFIG_PATH, 'utf8');
        const parsed = parseYaml(yamlText);
        return normalizeAppConfig(parsed);
    } catch (err) {
        console.warn(`Failed to load ${APP_CONFIG_PATH}. Using defaults.`, err.message);
        return { ...DEFAULT_APP_CONFIG };
    }
}

// --- PROFILE MANAGEMENT ---
let config = require('./config.json');
let activeProfileName = config.activeProfile || Object.keys(config.profiles)[0];
let appConfig = loadAppConfig();
let db = null;

// Get current active profile configuration
function getActiveProfile() {
    return config.profiles[activeProfileName];
}

// Get database filename for a profile
function getDbFileName(profileName) {
    // Sanitize profile name for filename
    const safeName = profileName.replace(/[^a-zA-Z0-9]/g, '_');
    return `library_${safeName}.db`;
}

// Prepared statements (will be initialized with database)
let insertAsset;
let insertTag;

// Initialize database for current profile
function initDatabase() {
    if (db) {
        db.close();
    }
    
    const dbFile = getDbFileName(activeProfileName);
    console.log(`Loading database for profile "${activeProfileName}": ${dbFile}`);
    db = new Database(dbFile);
    
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
    
    // Create/recreate prepared statements for the new database connection
    insertAsset = db.prepare(`INSERT OR REPLACE INTO assets (path, type, artist, name, pages) VALUES (?, ?, ?, ?, ?)`);
    insertTag = db.prepare(`INSERT INTO asset_tags (asset_id, tag) VALUES (?, ?)`);
}

// Initialize on startup
initDatabase();

app.use(cors());
app.use(express.json());

// --- SCANNER LOGIC ---
let isScanning = false;
let bootstrapStatus = {
    status: 'pending',
    profile: activeProfileName,
    startedAt: null,
    finishedAt: null,
    error: null,
    message: 'Startup sync has not started yet.'
};
const MAX_SCAN_LOG_ENTRIES = 60;
let scanStatus = {
    status: 'idle',
    profile: activeProfileName,
    processedArtists: 0,
    totalArtists: 0,
    percentage: 0,
    currentArtist: '',
    startedAt: null,
    finishedAt: null,
    error: null,
    recentLogs: []
};

function appendScanLog(line) {
    scanStatus.recentLogs.push(line);
    if (scanStatus.recentLogs.length > MAX_SCAN_LOG_ENTRIES) {
        scanStatus.recentLogs.shift();
    }
}

function setScanStatusRunning(profileName, totalArtists) {
    scanStatus = {
        status: 'running',
        profile: profileName,
        processedArtists: 0,
        totalArtists,
        percentage: totalArtists === 0 ? 100 : 0,
        currentArtist: '',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        recentLogs: []
    };
}

function countArtists(dirPath) {
    if (!fs.existsSync(dirPath)) return 0;

    try {
        const items = fs.readdirSync(dirPath);
        return items.filter(item => {
            try {
                return fs.statSync(path.join(dirPath, item)).isDirectory();
            } catch (e) {
                return false;
            }
        }).length;
    } catch (err) {
        return 0;
    }
}

function logScanProgress(scanContext, artistName) {
    if (!scanContext || scanContext.totalArtists <= 0) return;

    scanContext.processedArtists += 1;
    const percentage = Math.floor((scanContext.processedArtists / scanContext.totalArtists) * 100);

    scanStatus.processedArtists = scanContext.processedArtists;
    scanStatus.totalArtists = scanContext.totalArtists;
    scanStatus.percentage = percentage;
    scanStatus.currentArtist = artistName;

    if (percentage > scanContext.lastLoggedPercent || scanContext.processedArtists === scanContext.totalArtists) {
        scanContext.lastLoggedPercent = percentage;
        const line = `[Scan][${activeProfileName}] ${percentage}% (${scanContext.processedArtists}/${scanContext.totalArtists}) - ${artistName}`;
        appendScanLog(line);
        console.log(line);
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
                if (getActiveProfile().allowedExtensions.includes(path.extname(file).toLowerCase())) {
                    results.push(filePath);
                }
            }
        });
    } catch (err) {
        console.warn(`Skipping directory ${dir}: ${err.message}`);
    }
    return results.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

async function scanDirectory(dirPath, artistName = null, currentTags = [], scanContext = null) {
    if (!fs.existsSync(dirPath)) return;

    const items = fs.readdirSync(dirPath);

    for (const item of items) {
        // Keep scans responsive so API requests (e.g. status polling) are not starved.
        await new Promise(resolve => setImmediate(resolve));

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
                logScanProgress(scanContext, item);
                await scanDirectory(fullPath, item, [], scanContext); // Set artist, start fresh tags
                continue;
            }

            // LOGIC: Check Strict Allowlist (supports multi-tagging with +)
            // Split folder name by + to support multiple tags in one folder
            const folderTags = item.split('+').map(t => t.trim());
            const allTagsValid = folderTags.every(tag => getActiveProfile().allowedTags.includes(tag));
            
            if (allTagsValid && folderTags.length > 0) {
                // All parts are valid tags -> Add all tags and go deeper
                await scanDirectory(fullPath, artistName, [...currentTags, ...folderTags], scanContext);
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
                }
            }
        } else {
            // It is a File -> It is a STANDALONE IMAGE
            if (artistName && getActiveProfile().allowedExtensions.includes(path.extname(item).toLowerCase())) {
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

function clearDatabase() {
    db.prepare('DELETE FROM asset_tags').run();
    db.prepare('DELETE FROM assets').run();
}

async function runScanJob({ updateBootstrapStatus = false } = {}) {
    if (isScanning) {
        const error = new Error('A scan is already running');
        error.statusCode = 409;
        throw error;
    }

    isScanning = true;
    if (updateBootstrapStatus) {
        bootstrapStatus = {
            status: 'running',
            profile: activeProfileName,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            error: null,
            message: `Syncing profile "${activeProfileName}"...`
        };
    }

    try {
        clearDatabase();
        const rootDirectory = getActiveProfile().rootDirectory;
        const totalArtists = countArtists(rootDirectory);
        setScanStatusRunning(activeProfileName, totalArtists);

        const scanContext = {
            totalArtists,
            processedArtists: 0,
            lastLoggedPercent: -1
        };

        if (totalArtists === 0) {
            const line = `[Scan][${activeProfileName}] 100% (0/0) - No artist folders found`;
            appendScanLog(line);
            console.log(line);
        } else {
            const line = `[Scan][${activeProfileName}] 0% (0/${totalArtists}) - Starting scan`;
            appendScanLog(line);
            console.log(line);
        }

        await scanDirectory(rootDirectory, null, [], scanContext);

        const completionLine = `[Scan][${activeProfileName}] 100% (${scanContext.processedArtists}/${totalArtists}) - Scan complete`;
        scanStatus = {
            ...scanStatus,
            status: 'complete',
            processedArtists: scanContext.processedArtists,
            totalArtists,
            percentage: 100,
            finishedAt: new Date().toISOString(),
            error: null
        };
        appendScanLog(completionLine);
        console.log(completionLine);

        if (updateBootstrapStatus) {
            bootstrapStatus = {
                status: 'ready',
                profile: activeProfileName,
                startedAt: bootstrapStatus.startedAt,
                finishedAt: new Date().toISOString(),
                error: null,
                message: `Profile "${activeProfileName}" is ready.`
            };
        }
    } catch (err) {
        scanStatus = {
            ...scanStatus,
            status: 'error',
            finishedAt: new Date().toISOString(),
            error: err.message
        };
        appendScanLog(`[Scan][${activeProfileName}] ERROR - ${err.message}`);

        if (updateBootstrapStatus) {
            bootstrapStatus = {
                status: 'error',
                profile: activeProfileName,
                startedAt: bootstrapStatus.startedAt,
                finishedAt: new Date().toISOString(),
                error: err.message,
                message: `Startup sync failed for profile "${activeProfileName}".`
            };
        }
        throw err;
    } finally {
        isScanning = false;
    }
}

async function startBootstrapSync() {
    if (bootstrapStatus.status === 'running' || bootstrapStatus.status === 'ready') {
        return;
    }

    try {
        await runScanJob({ updateBootstrapStatus: true });
    } catch (err) {
        console.error('Startup sync failed:', err.message);
    }
}

// --- API ENDPOINTS ---

// 0. Profile Management
app.get('/api/profiles', (req, res) => {
    try {
        res.json({
            activeProfile: activeProfileName,
            profiles: Object.keys(config.profiles),
            profilesConfig: config.profiles
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/profiles/switch', async (req, res) => {
    const { profileName } = req.body;
    
    if (!profileName || !config.profiles[profileName]) {
        return res.status(400).json({ error: 'Invalid profile name' });
    }
    
    try {
        if (isScanning) {
            return res.status(409).json({ error: 'Cannot switch profiles while scanning is in progress' });
        }

        activeProfileName = profileName;
        
        // Update config.json to persist the active profile
        config.activeProfile = profileName;
        fs.writeFileSync('./config.json', JSON.stringify(config, null, 4));

        // Reinitialize database for new profile
        initDatabase();

        // Always rebuild index for switched profile so data is fresh.
        await runScanJob();
        
        console.log(`Switched to profile: ${profileName}`);
        res.json({ 
            success: true, 
            message: `Switched to profile: ${profileName} and scan completed`,
            activeProfile: profileName
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// 1. Bootstrap Status
app.get('/api/bootstrap-status', (req, res) => {
    res.json({
        ...bootstrapStatus,
        isScanning
    });
});

// 1a. Scan Status
app.get('/api/scan/status', (req, res) => {
    res.json({
        ...scanStatus,
        isScanning
    });
});

// 1b. App Config
app.get('/api/app-config', (req, res) => {
    res.json(appConfig);
});

// 2. Trigger Scan
app.post('/api/scan', async (req, res) => {
    console.log("Starting Scan...");
    try {
        await runScanJob();
        
        res.json({ success: true, message: "Scan complete" });
    } catch (err) {
        console.error(err);
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
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
        const requestedLimit = parseInt(req.query.limit);
        const limit = Number.isFinite(requestedLimit)
            ? clamp(requestedLimit, 1, 120)
            : appConfig.itemsPerPage;
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
    void startBootstrapSync();
});