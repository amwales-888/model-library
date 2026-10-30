'use strict';
const path = require('node:path');
const zip = require('./zip-reader');
const sevenzip = require('./sevenzip-reader');

/*
 * One entry point for every kind of archive. .zip files are read in-process (yauzl); .7z and .rar files are read
 * with the bundled 7-Zip program. Both give the indexer the same thing: a stream of model entries.
 */

const kindOf = (file) => (path.extname(file).toLowerCase() === '.zip' ? zip : sevenzip);

const eachModelEntry = (file, options) => kindOf(file).eachModelEntry(file, options);

function readArchiveEntry(file, entryName, options) {
  return path.extname(file).toLowerCase() === '.zip'
    ? zip.readZipEntry(file, entryName, options)
    : sevenzip.readSevenZipEntry(file, entryName, options);
}

module.exports = {
  eachModelEntry,
  readArchiveEntry,
  hashStream: zip.hashStream,
  virtualPath: zip.virtualPath,
  classify: zip.classify,
  LIMITS: zip.LIMITS,
};
