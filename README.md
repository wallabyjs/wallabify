# wallabify

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
    // debug: true
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

You don't need to specify any output options because wallabify doesn't use concatenated bundle. While concatenating files is beneficial for production environment, in testing environment it is different.
 Serving a large bundle every time when one of many files (that the bundle consists of) changes, is wasteful.
 So instead, each compiled module code is passed to wallaby, wallaby caches it in memory (and when required, writes
 it to disk) and serves each requested module file separately to properly leverage browser caching. 
 
`debug: true` option must be passed (to make browserify generate source maps) if some JavaScript transformers are used for files where wallaby.js coverage is expected to work.

For your tests you don't have to use the module bundler transformers and where possible may use [wallaby.js preprocessors](https://github.com/wallabyjs/public#preprocessors-setting) instead. For example, if you are using ES6 or JSX, instead of using `.transform(require('babelify')` in the initializer function, you may specify wallaby.js preprocessor:

``` javascript
    preprocessors: {
      '**/*.js': file => require('babel').transform(file.content, {sourceMap: true}),
      '**/*.jsx': file => require('babel').transform(file.content, {sourceMap: true})
    }
```
### Files and tests
All source files and tests must have `load: false` set, because wallaby will load browserified versions of these files on `window.__moduleBundler.loadTests()` call in `bootstrap` function.

Source files order doesn't matter, so patterns can be used instead of listing all the files.
