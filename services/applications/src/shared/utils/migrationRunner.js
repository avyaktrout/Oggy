/**
 * Migration Runner - Auto-applies DB schemas on service startup
 * Runs all SQL files from db/init/ in sorted order using CREATE IF NOT EXISTS
 * Safe to run repeatedly (idempotent)
 * Tries whole-file first, falls back to statement-by-statement on failure
 */

const fs = require('fs');
const path = require('path');
const { query } = require('./db');
const logger = require('./logger');

// Shared migrations directory
const SHARED_MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'db', 'init');

// Domain-specific migration directories
const DOMAIN_MIGRATION_DIRS = [
    path.join(__dirname, '..', '..', 'domains', 'payments', 'db'),
    path.join(__dirname, '..', '..', 'domains', 'general', 'db'),
    path.join(__dirname, '..', '..', 'domains', 'diet', 'db'),
    path.join(__dirname, '..', '..', 'domains', 'harmony', 'db'),
];

function collectMigrationFiles() {
    const allFiles = [];

    // Collect from shared dir
    if (fs.existsSync(SHARED_MIGRATIONS_DIR)) {
        const sharedFiles = fs.readdirSync(SHARED_MIGRATIONS_DIR)
            .filter(f => f.endsWith('.sql'))
            .map(f => ({ file: f, filePath: path.join(SHARED_MIGRATIONS_DIR, f) }));
        allFiles.push(...sharedFiles);
    }

    // Collect from domain dirs
    for (const dir of DOMAIN_MIGRATION_DIRS) {
        if (fs.existsSync(dir)) {
            const domainFiles = fs.readdirSync(dir)
                .filter(f => f.endsWith('.sql'))
                .map(f => ({ file: f, filePath: path.join(dir, f) }));
            allFiles.push(...domainFiles);
        }
    }

    // Sort globally by filename (preserves 01_, 02_, ... ordering)
    allFiles.sort((a, b) => a.file.localeCompare(b.file));
    return allFiles;
}

async function runMigrations() {
    const files = collectMigrationFiles();

    if (files.length === 0) {
        logger.warn('No migration files found');
        return { applied: 0, skipped: 0, errors: [] };
    }

    let applied = 0;
    let skipped = 0;
    const errors = [];

    for (const { file, filePath } of files) {
        const sql = fs.readFileSync(filePath, 'utf8');

        // Try running the whole file at once (handles $$ blocks, functions, etc.)
        try {
            await query(sql);
            applied++;
            logger.info(`Migration applied: ${file}`);
            continue;
        } catch (err) {
            if (err.message.includes('already exists')) {
                skipped++;
                logger.info(`Migration skipped (already applied): ${file}`);
                continue;
            }
            // Whole-file failed — fall back to statement-by-statement
        }

        // Statement-by-statement fallback: split on semicolons NOT inside $$ blocks
        const statements = splitStatements(sql);
        let fileApplied = 0;
        let fileErrors = 0;

        for (const stmt of statements) {
            try {
                await query(stmt);
                fileApplied++;
            } catch (err) {
                if (!err.message.includes('already exists') && !err.message.includes('duplicate key')) {
                    fileErrors++;
                }
            }
        }

        if (fileApplied > 0) {
            applied++;
            logger.info(`Migration applied (partial): ${file}`, { statements: fileApplied, errors: fileErrors });
        } else {
            skipped++;
        }

        if (fileErrors > 0) {
            errors.push({ file, partial_errors: fileErrors });
        }
    }

    logger.info('Migration run complete', { applied, skipped, errors: errors.length, total: files.length });
    return { applied, skipped, errors };
}

/**
 * Split SQL into statements, respecting $$ dollar-quoted blocks
 */
function splitStatements(sql) {
    const statements = [];
    let current = '';
    let inDollarQuote = false;
    const lines = sql.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('--') && !inDollarQuote) {
            continue; // Skip comment-only lines outside blocks
        }

        // Track $$ blocks
        const dollarMatches = (line.match(/\$\$/g) || []).length;
        if (dollarMatches % 2 === 1) {
            inDollarQuote = !inDollarQuote;
        }

        current += line + '\n';

        // Statement boundary: line ends with ; and we're not inside $$
        if (!inDollarQuote && trimmed.endsWith(';')) {
            const stmt = current.trim();
            if (stmt.length > 1) {
                statements.push(stmt);
            }
            current = '';
        }
    }

    // Catch any trailing statement without semicolon
    if (current.trim().length > 1) {
        statements.push(current.trim());
    }

    return statements;
}

module.exports = { runMigrations };
