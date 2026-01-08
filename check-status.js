// check-csv.js
const axios = require('axios');
const csv = require('csv-parser');
const { Readable } = require('stream');
require('dotenv').config();

// ===== CONFIG =====
const CSV_URL = process.env.CSV_URL; // Your CSV URL
const TARGET_ID = process.env.TARGET_ID || '065-0-Reg-25-000001';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STATE_FILE = process.env.STATE_FILE || '/tmp/csv-checker-state.json';
// ==================

// Load previous state
function loadState() {
    try {
        const fs = require('fs');
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('Error loading state:', error.message);
    }
    return { lastCheck: null, lastValues: {} };
}

// Save state
function saveState(state) {
    try {
        const fs = require('fs');
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
        console.error('Error saving state:', error.message);
    }
}

// Send Telegram message
async function sendTelegramMessage(message) {
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
        console.log('📤 Telegram message sent');
    } catch (error) {
        console.error('Failed to send Telegram:', error.message);
    }
}

async function checkCSV() {
    console.log(`[${new Date().toISOString()}] Checking CSV...`);
    console.log(`Target ID: ${TARGET_ID}`);

    try {
        // Download CSV
        const response = await axios.get(CSV_URL, {
            timeout: 30000,
            responseType: 'stream'
        });

        // Parse CSV
        const rows = [];
        await new Promise((resolve, reject) => {
            response.data
                .pipe(csv({
                    mapHeaders: ({ header }) => header.trim(), // Clean headers
                    skipLines: 0 // Adjust if there are extra header rows
                }))
                .on('data', (row) => rows.push(row))
                .on('end', resolve)
                .on('error', reject);
        });

        console.log(`📊 CSV loaded: ${rows.length} rows found`);

        // Find our target row (assuming first column is the ID)
        let targetRow = null;
        let rowIndex = -1;

        for (let i = 0; i < rows.length; i++) {
            // Try different possible column names for the ID
            const row = rows[i];
            const possibleId = row[''] || row['a/a'] || row['216390'] || row[Object.keys(row)[0]] || row['broj protokola'] || row['F'];

            if (possibleId && possibleId.trim() === TARGET_ID) {
                targetRow = row;
                rowIndex = i + 1; // +1 for human-readable index
                break;
            }
        }

        if (!targetRow) {
            const msg = `❌ Row "${TARGET_ID}" not found in CSV!`;
            console.error(msg);
            await sendTelegramMessage(msg);
            return;
        }

        console.log(`✅ Found target row at position ${rowIndex}`);
        console.log('Row data:', JSON.stringify(targetRow, null, 2));

        // Extract the fields we care about
        const currentValues = {
            zakljucakDatum: targetRow['Zaključak datum'] || targetRow['Zaključak datum'] || '',
            rjesenjeDatum: targetRow['Rješenje doneseno dana'] || targetRow['Rješenje doneseno dana'] || '',
            naziv: targetRow['Naziv subjekta'] || '',
            timestamp: new Date().toISOString()
        };

        // Load previous state
        const state = loadState();
        const previousValues = state.lastValues[TARGET_ID] || {};

        console.log('Previous values:', previousValues);
        console.log('Current values:', currentValues);

        // Check for changes
        const changes = [];

        if (previousValues.zakljucakDatum !== currentValues.zakljucakDatum) {
            changes.push({
                field: 'Zaključak datum',
                from: previousValues.zakljucakDatum || '(empty)',
                to: currentValues.zakljucakDatum || '(empty)'
            });
        }

        if (previousValues.rjesenjeDatum !== currentValues.rjesenjeDatum) {
            changes.push({
                field: 'Rješenje doneseno dana',
                from: previousValues.rjesenjeDatum || '(empty)',
                to: currentValues.rjesenjeDatum || '(empty)'
            });
        }

        // Update state
        state.lastCheck = new Date().toISOString();
        state.lastValues[TARGET_ID] = currentValues;
        saveState(state);

        // Send notification if changes detected
        if (changes.length > 0) {
            const changeText = changes.map(c =>
                `• <b>${c.field}</b>\n  ${c.from} → ${c.to}`
            ).join('\n\n');

            const message = `🚨 <b>CSV UPDATE DETECTED!</b>\n\n` +
                `📋 ID: <code>${TARGET_ID}</code>\n` +
                `🏢 Naziv: ${currentValues.naziv}\n\n` +
                `${changeText}\n\n` +
                `🕐 Checked: ${new Date().toLocaleString()}`;

            console.log('📈 Changes detected:', changes);
            await sendTelegramMessage(message);
        } else {
            console.log('✅ No changes detected');

            // Optional: Send periodic "all good" message (once a week?)
            const lastAllGood = state.lastAllGood || 0;
            const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

            if (lastAllGood < weekAgo) {
                const statusMessage = `✅ <b>Status Check</b>\n\n` +
                    `ID: <code>${TARGET_ID}</code>\n` +
                    `Naziv: ${currentValues.naziv}\n` +
                    `Zaključak: ${currentValues.zakljucakDatum || '(empty)'}\n` +
                    `Rješenje: ${currentValues.rjesenjeDatum || '(empty)'}\n\n` +
                    `All fields unchanged.\n` +
                    `Last checked: ${new Date().toLocaleString()}`;

                await sendTelegramMessage(statusMessage);
                state.lastAllGood = Date.now();
                saveState(state);
            }
        }

    } catch (error) {
        const errorMsg = `❌ Error checking CSV: ${error.message}`;
        console.error(errorMsg);
        await sendTelegramMessage(errorMsg);
    }
}

// Validate environment
function validateEnv() {
    const missing = [];
    if (!CSV_URL) missing.push('CSV_URL');
    if (!TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
    if (!TELEGRAM_CHAT_ID) missing.push('TELEGRAM_CHAT_ID');

    if (missing.length > 0) {
        console.error('❌ Missing environment variables:', missing.join(', '));
        console.error('\nCreate a .env file with:');
        console.error('CSV_URL="https://docs.google.com/..."');
        console.error('TELEGRAM_BOT_TOKEN="your_bot_token"');
        console.error('TELEGRAM_CHAT_ID="your_chat_id"');
        console.error('TARGET_ID="065-0-Reg-25-000001"');
        process.exit(1);
    }

    console.log('✅ Environment loaded');
    console.log(`   CSV URL: ${CSV_URL.substring(0, 50)}...`);
    console.log(`   Target: ${TARGET_ID}`);
}

// Run
validateEnv();
checkCSV();
