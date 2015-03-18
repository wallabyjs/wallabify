'use strict';

var path = require('path');
var fs = require('graceful-fs');
var _ = require('lodash');
var through = require('through2');
var convert = require('convert-source-map');

class Wallabify {

  constructor(opts, initializer) {
    this._opts = opts || {};
    this._initializer = initializer;

    this._b = null;
    this._browserifyCache = {};
    this._affectedFilesCache = {};
    this._initRequired = false;
    this._allTrackedFiles = {};
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

    // wallaby.js postprocessor for browserify
    // The postprocessor creates and reuses browserify instance.
    // It splices browserify pipeline so that file concatenation doesn't happen.
    // Instead, the postprocessor creates new files and lets wallaby.js to serve them to browser as requested.
    // This allows to leverage file-based browser caching as opposed to always reload a full bundle.
    // When separate files load, they only add a function with the file body to the cache object.
    // Actual loading happens when window.__browserify.loadTests is called (from bootstrap function).

    return wallaby => {
      if (!self._b || wallaby.anyFilesAdded || wallaby.anyFilesDeleted) {
        self._initRequired = true;
        self._affectedFilesCache = {};
        self._allTrackedFiles = _.reduce(wallaby.allFiles, function (memo, file) {
          memo[file.fullPath] = file;
          return memo;
        }, {});

        self._b = self._createBrowserify({
          entries: _.map(wallaby.allTestFiles, testFile => testFile.fullPath),
          paths: wallaby.nodeModulesDir ? [wallaby.nodeModulesDir] : [],
          cache: {}, packageCache: {}, fullPaths: true
        });

        self._browserifyCache = self._b._options.cache;

        self._b.on('dep', function (dep) {
          if (typeof dep.id === 'string') {
            var key = dep.expose ? dep.file : dep.id;
            if (!self._browserifyCache[key]) {
              self._browserifyCache[key] = dep;
              // new file that has not been cached before (node module or a source file)
              self._affectedFilesCache[key] = dep;
            }
          }
        });

        // no need to pack the bundle, wallaby.js serves files one by one to leverage browser caching
        self._b.pipeline.splice('pack');
      }

      // todo: handle node modules external update
      // todo: bundle node_modules into a single file

      // removing changed files tracked by wallaby.js from browserify cache
      _.each(wallaby.affectedFiles, file => {
        delete self._browserifyCache[file.fullPath];
      });

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
              content: Wallabify._getLoaderContent()
            }));
          }

          // handling changed files tracked by wallaby.js
          _.each(wallaby.affectedFiles, function (file) {
            var cached = self._browserifyCache[file.fullPath];
            if (cached) {
              var code = cached.source;
              var sourceMap;
              var sourceMapConverter = convert.fromSource(code);
              if (sourceMapConverter) {
                sourceMap = sourceMapConverter.toJSON();
                code = convert.removeComments(code);
              }

              // cloning an original file and browserify-ing it
              createFilePromises.push(wallaby.createFile({
                // adding the suffix to store browserified file along with the original copies
                path: file.path + '.bro.js',
                original: file,
                content: Wallabify._wallabifyFile(file.fullPath, code, cached.deps),
                sourceMap: sourceMap
              }));
              delete self._affectedFilesCache[file.fullPath];
            }
          });

          // handling externally added and not tracked files (such as node modules and external files)
          try {
            _.each(self._affectedFilesCache, function (file) {
              if (!file.expose && !~file.id.indexOf(wallaby.nodeModulesDir)) {
                throw new Error('File ' + file.id + ' is neither a node module nor an external dependency.');
              }
              createFilePromises.push(wallaby.createFile({
                path: file.expose
                  ? path.join('browserify_external', file.id, 'external.js')
                  : path.join('browserify_node_modules', path.relative(wallaby.nodeModulesDir, file.id)),
                content: Wallabify._wallabifyFile(file.id, file.source, file.deps)
              }));
            });
          }
          catch (e) {
            return Promise.reject(e);
          }

          // resetting till next incremental bundle run
          self._affectedFilesCache = {};

          return Promise.all(createFilePromises);
        });
    }
  }

  _createBrowserify(mandatoryOpts) {
    var paths = mandatoryOpts.paths.concat(this._opts.paths || []);
    var mergedOpts = _.extend(this._opts, mandatoryOpts);
    mergedOpts.paths = paths;

    var instance = this._browserify(mergedOpts);
    if (this._initializer && _.isFunction(this._initializer)) {
      return this._initializer(instance) || instance;
    }

    return instance;
  }

  static _wallabifyFile(id, content, deps) {
    return 'window.__browserify.cache["' + id + '"] = [function(require, module, exports) {'
      + content + '\n}, ' + JSON.stringify(deps) + '];';
  }

  static _getLoaderContent() {
    return 'window.__browserify = {};'
      + 'window.__browserify.cache = {};'
      + 'window.__browserify.loadTests = function () {'
        // browser pack prelude
      + '(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module \'"+o+"\'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})'
        // passing accumulated files and entry points (browserified tests for the current sandbox)
      + '(window.__browserify.cache, {}, (function(){ var testIds = []; for(var i = 0, len = wallaby.tests.length; i < len; i++) { var test = wallaby.tests[i]; if (test.substr(-7) === ".bro.js") testIds.push(wallaby.baseDir + test.substr(0, test.length - 7)); } return testIds; })()); };'
  }

  static _patchModuleDependenciesModule() {
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