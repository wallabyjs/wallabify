'use strict';

var path = require('path');
var fs = require('graceful-fs');
var _ = require('lodash');
var through = require('through2');
var convert = require('convert-source-map');
var mm = require('minimatch');

/*
 Postprocessor for wallaby.js runs module bundler compiler incrementally
 to only build changed or not yet built modules. The compiler is stopped from emitting the bundle/chunks to disk,
 because while concatenating files is beneficial for production environment, in testing environment it is different.
 Serving a large bundle/chunk every time when one of many files (that the bundle consists of) changes, is wasteful.
 So instead, each compiled module code is passed to wallaby,  wallaby caches it in memory (and when required, writes
 it on disk) and serves each requested module file separately to properly leverage browser caching.

 Apart from emitting module files, the postprocessor also emits a test loader script that executes in browser before
 any modules. The test loader sets up a global object so that each wrapped module can add itself to the loader cache.

 Each module code is wrapped in such a way that when the module file is loaded in browser, it doesn't execute
 the module code immediately. Instead, it just adds the function that executes the module code to test loader's cache.

 Modules are loaded from tests (that are entry points) when the tests are loaded. The tests are loaded from wallaby
 bootstrap function, by calling `__moduleBundler.loadTests()`.

 When wallaby runs tests first time, browser caches all modules and each subsequent test run only needs to load  a
 changed module files from the server (and not the full bundle).
 */

class Wallabify {

  constructor(opts, initializer) {
    this._patchModuleDependenciesModule();

    this._opts = opts || {};

    this._prelude = this._opts.prelude;
    this._entryPatterns = this._opts.entryPatterns;
    delete this._opts.prelude;
    delete this._opts.entryPatterns;

    if (this._entryPatterns && _.isString(this._entryPatterns)) {
      this._entryPatterns = [this._entryPatterns];
    }

    this._initializer = initializer;

    this._b = null;
    this._browserifyCache = {};
    this._affectedFilesCache = {};
    this._initRequired = false;
    this._allTrackedFiles = {};
    this._entryFiles = {};
  }

  createPostprocessor() {
    var self = this;
    try {
      this._browserify = require('browserify');
    }
    catch (e) {
      console.error('Browserify node module is not found, missing `npm install browserify --save-dev`?');
      return;
    }

    return wallaby => {
      var logger = wallaby.logger;
      var affectedFiles = wallaby.affectedFiles;
      if (!self._b || wallaby.anyFilesAdded || wallaby.anyFilesDeleted) {

        if (!self._b) {
          logger.debug('New browserify instance created');
        }
        else {
          logger.debug('Browserify instance re-created because some tracked files were added or deleted');
        }

        self._initRequired = true;
        self._affectedFilesCache = {};
        self._allTrackedFiles = _.reduce(wallaby.allFiles, function (memo, file) {
          memo[file.fullPath] = file;
          return memo;
        }, {});
        affectedFiles = wallaby.allFiles;

        self._entryFiles = _.reduce(!self._entryPatterns
            ? wallaby.allTestFiles
            : _.filter(self._allTrackedFiles, file => _.find(self._entryPatterns, pattern => mm(file.path, pattern))),
          function (memo, file) {
            memo[file.fullPath] = file;
            return memo;
          }, {});

        self._b = self._createBrowserify({
          entries: _.map(self._entryFiles, entryFile => entryFile.fullPath),
          paths: wallaby.nodeModulesDir ? [wallaby.nodeModulesDir] : [],
          cache: {}, packageCache: {}, fullPaths: true
        });

        self._browserifyCache = self._b._options.cache;

        self._b.on('dep', function (dep) {
          if (typeof dep.id === 'string') {
            var key = dep.id;
            if (!self._browserifyCache[key]) {
              self._browserifyCache[key] = dep;
              // external files are cached by file name as well to avoid re-processing them every time
              if (dep.expose) {
                self._browserifyCache[dep.file] = dep;
              }
              // new file that has not been cached before (node module or a source file)
              self._affectedFilesCache[key] = dep;
            }
          }
        });

        // no need to pack the bundle, wallaby.js serves files one by one to leverage browser caching
        self._b.pipeline.splice('pack');
      }

      // removing changed files tracked by wallaby.js from browserify cache
      if (!self._initRequired) {
        _.each(affectedFiles, file => {
          delete self._browserifyCache[file.fullPath];
        });
      }

      return new Promise(
        function (resolve, reject) {
          try {
            // incremental bundling
            self._b.bundle()
              .on('data', () => {
              })
              .on('error', err => reject(err))
              .on('end', () => resolve());
          } catch (err) {
            reject(err);
          }
        })
        .then(function () {
          var createFilePromises = [];

          // test loader for wallaby.js
          // works exactly as browserify bundle loading, but with separate files as opposed to a single bundle file
          if (self._initRequired) {
            self._initRequired = false;

            createFilePromises.push(wallaby.createFile({
              order: -1,  // need to be the first file to load
              path: 'wallabify.js',
              content: self._getLoaderContent()
            }));

            // Executing all entry files
            if (self._entryPatterns && self._entryFiles && !_.isEmpty(self._entryFiles)) {
              createFilePromises.push(wallaby.createFile({
                order: Infinity,
                path: 'wallabify_entry.js',
                content: _.reduce(_.values(self._entryFiles),
                  (memo, file) => memo + (file.test ? '' : 'window.__moduleBundler.require(' + JSON.stringify(file.fullPath) + ');'), '')
              }));
            }
          }

          // handling changed files tracked by wallaby.js
          _.each(affectedFiles, function (file) {
            var cached = self._browserifyCache[file.fullPath];
            if (cached) {
              var code = cached.source;
              var sourceMap;
              var sourceMapConverter = convert.fromSource(code);
              if (sourceMapConverter) {
                sourceMap = sourceMapConverter.toJSON();
                code = convert.removeComments(code);
              }

              var isEntryFile = self._entryPatterns && self._entryFiles[file.fullPath];

              // cloning an original file and browserify-ing it
              createFilePromises.push(wallaby.createFile({
                // adding the suffix to store browserified file along with the original copies
                path: file.path + '.bro.js',
                original: file,
                content: Wallabify._wallabifyFile(file.fullPath, code, cached.deps),
                sourceMap: sourceMap,
                order: isEntryFile ? file.order : undefined
              }));
              delete self._affectedFilesCache[file.fullPath];
            }
          });

          // handling externally added and not tracked files (such as node modules and external files)
          try {
            _.each(self._affectedFilesCache, function (file) {
              var ext = path.extname(file.id);
              var basename = path.basename(file.id, ext);
              createFilePromises.push(wallaby.createFile({
                // file path/name doesn't matter, just has to be unique for each file
                path: path.join('__modules', basename + '.' + require('crypto').createHash('md5').update(file.id).digest('hex') + '.js'),
                content: Wallabify._wallabifyFile(file.id, file.source, file.deps),
                ts: 1   // constant timestamp to cache the file in browser/phantomjs forever (until wallaby restarts)
              }));
            });
          }
          catch (e) {
            return Promise.reject(e);
          }

          // resetting till next incremental bundle run
          self._affectedFilesCache = {};

          logger.debug('Emitting %s files', createFilePromises.length);

          return Promise.all(createFilePromises);
        });
    }
  }

  _createBrowserify(mandatoryOpts) {
    var paths = mandatoryOpts.paths.concat(this._opts.paths || []);
    var mergedOpts = _.merge({}, this._opts, mandatoryOpts);
    mergedOpts.paths = paths;

    var instance = this._browserify(mergedOpts);
    if (this._initializer && _.isFunction(this._initializer)) {
      return this._initializer(instance) || instance;
    }

    return instance;
  }

  static _wallabifyFile(id, content, deps) {
    return 'window.__moduleBundler.cache[' + JSON.stringify(id) + '] = [function(require, module, exports) {'
      + content + '\n}, ' + JSON.stringify(deps) + '];';
  }

  _getLoaderContent() {
    var prelude = this._prelude ||
      '(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module \'"+o+"\'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})';

    return 'window.__moduleBundler = {};'
      + 'window.__moduleBundler.cache = {};'
      + 'window.__moduleBundler.require = function (m) {'
      + prelude
      + '(window.__moduleBundler.cache, {}, [m]);'
      + '};'
      + 'window.__moduleBundler.loadTests = function () {'
      + prelude
        // passing accumulated files and entry points (browserified tests for the current sandbox)
      + '(window.__moduleBundler.cache, {}, (function(){ var testIds = []; for(var i = 0, len = wallaby.loadedTests.length; i < len; i++) { var test = wallaby.loadedTests[i]; if (test.substr(-7) === ".bro.js") testIds.push(wallaby.baseDir + test.substr(0, test.length - 7)); } return testIds; })()); };'
  }

  _patchModuleDependenciesModule() {
    var wallabify = this;
    // patching module dependencies to use wallaby cache
    try {
      require('browserify/node_modules/module-deps').prototype.readFile = function (file, id) {
        var self = this;
        var tr = through();
        if (this.cache && this.cache[file]) {
          tr.push(this.cache[file].source);
          tr.push(null);
          return tr;
        }

        // wallaby.js may already have the file cached (if not, it will just read it from disk)
        if (wallabify._allTrackedFiles && wallabify._allTrackedFiles[file]) {
          wallabify._allTrackedFiles[file].getContent().then(function (source) {
            tr.push(source);
            tr.push(null);
          });
          return tr;
        }

        var rs = fs.createReadStream(file);
        rs.on('error', function (err) {
          self.emit('error', err)
        });
        this.emit('file', file, id);
        return rs;
      };
    }
    catch (e) {
      // not critical
      console.warn('Failed to patch `module-deps` module, wallaby.js file cache will not be used.'
        + '\nIt\'s not a critical issue, however tests will run faster when wallaby.js file cache is used.');
    }
  }
}

module.exports = function (opts, initializer) {
  return new Wallabify(opts, initializer).createPostprocessor();
};
