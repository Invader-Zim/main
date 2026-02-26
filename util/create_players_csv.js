'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const DATA_FOLDER = config.DATA_FOLDER;

const inputDir = path.join(DATA_FOLDER, "players");

if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
    console.error(`Error: '${inputDir}' is not a directory`);
    process.exit(1);
}

const outputFile = path.join(inputDir, "..") + "/player_accounts.csv";
let whitespaceCount = 0;

// ---- Strict RFC-4180 CSV escaping ----
function csvEscape(value) {
    if (value === null || value === undefined) return '""';

    const str = String(value);

    // Escape double quotes by doubling them
    const escaped = str.replace(/"/g, '""');

    // Always quote fields for strictness
    return `"${escaped}"`;
}

// ---- Convert epoch milliseconds → GMT string ----
function epochMsToGMT(epochMs) {
    const date = new Date(Number(epochMs));
    // Format: YYYY-MM-DD HH:MM:SS (UTC)
    const pad = (n) => String(n).padStart(2, "0");

    return (
        date.getUTCFullYear() + "-" +
        pad(date.getUTCMonth() + 1) + "-" +
        pad(date.getUTCDate()) + " " +
        pad(date.getUTCHours()) + ":" +
        pad(date.getUTCMinutes()) + ":" +
        pad(date.getUTCSeconds())
    );
}

// ---- Write CSV header ----
fs.writeFileSync(
    outputFile,
    "name,key,created_at,created_GMT,verified\n",
    "utf8"
);

// ---- Process files ----
const files = fs.readdirSync(inputDir);

for (const file of files) {
    const fullPath = path.join(inputDir, file);

    let data;
    try {
        const raw = fs.readFileSync(fullPath, "utf8");
        data = JSON.parse(raw);
    } catch (err) {
        console.error(`Skipping invalid JSON file: ${file}`);
        continue;
    }

    const name = data.name || "";
    const key = data.key || "";
    const createdAt = data.created_at || "";
    const verified = data.verified || "";

    // ---- Trailing whitespace check ----
    if (/[ \t\r\n]+$/.test(name)) {
        console.log(`Trailing whitespace detected in name: '${name}'`);
        whitespaceCount++;
    }

    const createdGMT = epochMsToGMT(createdAt);

    const row = [
        csvEscape(name),
        csvEscape(key),
        csvEscape(createdAt),
        csvEscape(createdGMT),
        csvEscape(verified)
    ].join(",") + "\n";

    fs.appendFileSync(outputFile, row, "utf8");
}

// ---- Final report ----
console.log(`Total names with trailing whitespace: ${whitespaceCount}`);
