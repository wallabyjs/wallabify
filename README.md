# wallabify

Wallaby.js postprocessor to support browserify.

## Installation

``` sh
npm install wallabify --save-dev
```

## Usage

``` javascript
// Wallaby.js configuration

var wallabify = require('wallabify');
var wallabyPostprocessor = wallabify({
    // browserify options, such as
    // insertGlobals: false
  }
  // you may also pass an initializer function to chain other 
  // browserify options, such as transformers
  // , b => b.exclude('mkdirp').transform(require('babelify'))
);

module.exports = function () {
  return {
    // set `load: false` to all of the browserified source files and tests,
    // as they should not be loaded in browser, 
    // their browserified versions will be loaded instead
    files: [
      {pattern: 'src/*.js', load: false}
    ],

    tests: [
      {pattern: 'test/*Spec.js', load: false}
    ],
    
    postprocessor: wallabyPostprocessor,

    bootstrap: function () {
      // required to trigger tests loading 
      window.__moduleBundler.loadTests();
    }
  };
};
```

## Notes

### Browserify options
Only specify options that you need for your tests to run to avoid doing anything that would make each test run slower. 

You don't need to specify any output options because wallabify doesn't use concatenated bundle. While concatenating files is beneficial for a production environment, in a testing environment it is different.
 Serving a large bundle every time when one of many files (that the bundle consists of) changes, is wasteful.
 So instead, each compiled module code is passed to wallaby, wallaby caches it in memory (and when required, writes
 it to disk) and serves each requested module file separately to properly leverage browser caching. 
 
For your tests you don't have to use the module bundler transformers and where possible may use [wallaby.js preprocessors](https://github.com/wallabyjs/public#preprocessors-setting) instead. For example, if you are using ES6 or JSX, instead of using `.transform(require('babelify')` in the initializer function, you may specify wallaby.js preprocessor(s):

``` javascript
    files: [
      {pattern: 'src/*.js', load: false}
    ],

    tests: [
      {pattern: 'test/*Spec.js', load: false}
    ],
    
    preprocessors: {
      '**/*.js': file => require('babel').transform(file.content, {sourceMap: true}),
      '**/*.jsx': file => require('babel').transform(file.content, {sourceMap: true})
    },
    
    postprocessor: wallabyPostprocessor
```
### Files and tests
All source files and tests (except external files/libs) must have `load: false` set, because wallaby will load browserified versions of these files on `window.__moduleBundler.loadTests()` call in `bootstrap` function. Node modules should not be listed in the `files` list, they are loaded automatically.

Source files order doesn't matter, so patterns can be used instead of listing all the files.

Code inside each file is wrapped in such a way that when the file is loaded in browser, it doesn't execute
 the code immediately. Instead, it just adds some function, that executes the file code, to test loader's cache. Tests and dependent files are loaded from wallaby `bootstrap` function, by calling `__moduleBundler.loadTests()`, and then executed.
