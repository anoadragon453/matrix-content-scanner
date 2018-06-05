/**

Copyright 2018 New Vector Ltd.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

**/

const path = require('path');
const fs = require('fs');
const rp = require('request-promise');

const ClientError = require('./client-error.js');
const executeCommand = require('./execute-cmd.js');
const decryptFile = require('./decrypt-file.js');

// In-memory mapping between mxc:// URLs and the results generated by generateReport
let resultCache = {};
function clearReportCache() {
    resultCache = {};
}

// Get cached report for the given URL
async function getReport(resultSecret) {
    const result = resultCache[resultSecret];
    if (!result) {
        return { clean: false, scanned: false, info: 'Secret not recognised, file not scanned.' };
    }

    const { clean, info } = result;

    return { clean, scanned: true, info };
}

const crypto = require('crypto');
function base64sha256(s) {
    const hash = crypto.createHash('sha256');
    hash.update(s);
    return hash.digest('base64');
}

// Generate a report on a Matrix file event.
async function generateReport(console, eventContentFile, opts) {
    const url = eventContentFile.url;

    const { baseUrl, tempDirectory, script } = opts;
    if (baseUrl === undefined || tempDirectory === undefined || script === undefined) {
        throw new Error('Expected baseUrl, tempDirectory and script in opts');
    }

    const httpUrl = baseUrl + '/_matrix/media/v1/download/' + url.slice(6);

    // Result is cached against the hash of the input file object. Using an MXC would
    // potentially allow an attacker to mark a file as clean without having the
    // keys to correctly decrypt it.
    const resultSecret = base64sha256(JSON.stringify(eventContentFile));

    if (resultCache[resultSecret] !== undefined) {
        const result = resultCache[resultSecret];
        console.info(`Returning cached result: url = ${url}, clean = ${result.clean}`);
        return result;
    }

    const tempDir = fs.mkdtempSync(`${tempDirectory}${path.sep}av-`);
    const filePath = path.join(tempDir, 'unsafeEncryptedFile');

    console.info(`Downloading ${httpUrl}, writing to ${filePath}`);

    try {
        data = await rp({url: httpUrl, encoding: null});
    } catch (err) {
        console.error(err);
        throw new ClientError(502, 'Failed to get requested URL');
    }

    fs.writeFileSync(filePath, data);

    let decryptedFilePath;
    if (eventContentFile.key) {
        decryptedFilePath = path.join(tempDir, 'unsafeFile');
        console.info(`Decrypting ${filePath}, writing to ${decryptedFilePath}`);

        try {
            decryptFile(filePath, decryptedFilePath, eventContentFile);
        } catch (err) {
            console.error(err);
            throw new ClientError(400, 'Failed to decrypt file');
        }
    } else {
        // File is already decrypted
        decryptedFilePath = filePath;
    }

    const cmd = script + ' ' + decryptedFilePath;
    console.info(`Running command ${cmd}`);
    const result = await executeCommand(cmd);

    console.info(`Result: url = "${url}", clean = ${result.clean}, exit code = ${result.exitCode}`);

    result.resultSecret = resultSecret;

    resultCache[resultSecret] = result;

    fs.unlinkSync(filePath);
    if (filePath !== decryptedFilePath) {
        fs.unlinkSync(decryptedFilePath);
    }
    fs.rmdirSync(tempDir);

    return result;
}

module.exports = {
    getReport,
    generateReport,
    clearReportCache,
};
