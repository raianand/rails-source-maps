#!/usr/bin/env node

var fs = require('fs');
var zlib = require('zlib');
var _ = require('underscore');
var async = require('async');
var program = require('commander');
var uglify = require('uglify-js');

var ALREADY_PROCESSED = 'already processed';

var threads = program.threads || 3;
var gzip = program.gzip;

exports.main = function() {
  program
    .version('0.0.1')
    .option('-t, --threads [threads]', 'number of concurrent threads (default: 3)')
    .option('-Z, --no-gzip', 'do not gzip files')
    .usage('/path/to/rails/root')
    .parse(process.argv);

  this.setupQueue();

  if (program.args.length < 1 || !_.isString(program.args[0])) {
    return program.help();
  }

  this.run();
};

exports.run = function() {
  var self = this;

  var assetsPath = program.args[0].replace(/\/$/, '') + '/public/assets';
  fs.stat(assetsPath, function(err, stat) {
    if (err) {
      console.error('Error reading input directory ' + assetsPath + ': ' + err.toString());
      return program.help();
    }
    if (!stat.isDirectory()) {
      console.error('Input is not a directory: ' + assetsPath + "\n\n");
      return program.help();
    }

    self.findNestedFiles(assetsPath, function(err, files) {
      if (err) {
        return console.error("Encountered error walking directory tree: " + err.toString());
      }

      _.each(files, function(file) {
        if (file.match(/\.js$/) && !file.match(/\.orig\.js$/)) {
          self.queue.push(file);
        }
      });
    });
  });
};

exports.setupQueue = function() {
  this.queue = async.queue(_.bind(this.enqueue, this), threads);

  this.queue.drain = this.onQueueDrain;
};

/* ****************************************************************
  Process each javascript file using this queue
**************************************************************** */
exports.enqueue = function(jsfile, cb) {
  var original = jsfile.replace(/\.js$/, '.orig.js');
  var sourcemap = jsfile.replace(/\.js$/, '.js.map');
  var gzipped = jsfile.replace(/\.js$/, '.js.gz');

  var sourceMapUrl = sourcemap.replace(/^((\.\/)?public\/)?/, '/');
  var sourceMapText = "\n//# sourceMappingURL=" + sourceMapUrl;

  async.waterfall([
    function(cb) {
      fs.readFile(jsfile, { encoding: 'utf8' }, function(err, contents) {
        if (err) {
          return cb(err);
        }

        // Check if this file already lists a source map. If so, skip it.
        if (contents.slice(-1 * sourceMapText.length) === sourceMapText) {
          console.log("Skipping file which already has a source map: " + jsfile);
          return cb(ALREADY_PROCESSED);
        }

        console.log("Generating source map for file: " + jsfile);
        cb();
      });
    },
    function(cb) {
      fs.rename(jsfile, original, cb);
    },
    function(cb) {
      var uglified = uglify.minify(original, {
        outSourceMap: sourceMapUrl
      });
      cb(null, uglified);
    },
    function(uglified, cb) {

      // Replace ./public/assets/ prefix with /assets/
      uglified.code = uglified.code.replace(/\.?\/?public\/assets\//g, '/assets/');
      uglified.map = uglified.map.replace(/\.?\/?public\/assets\//g, '/assets/');

      uglified.code += sourceMapText;

      var flags = {
        code: false,
        map: false,
        cb: false
      };

      var finished = function(which) {
        return function(err) {
          if (err) {
            flags.cb = true;
            return cb(err);
          }
          flags[which] = true;
          if (flags.code && flags.map && !flags.cb) {
            flags.cb = true;
            cb();
          }
        };
      };

      fs.writeFile(jsfile, uglified.code, finished('code'));
      fs.writeFile(sourcemap, uglified.map, finished('map'));
    },
    function(cb) {
      if (!gzip) {
        return cb();
      }

      fs.createReadStream(jsfile).
        pipe(zlib.createGzip()).
        pipe(fs.createWriteStream(gzipped)).
        on('finish', cb);
    }
  ], function(err) {
    if (err) {
      if (err !== ALREADY_PROCESSED) {
        console.error("Error processing file " + jsfile + ": " + err.toString());
      }
    }

    cb();
  });
};

exports.onQueueDrain = function() {
  console.log('all files have been processed');
};

/* ****************************************************************
   Get all files within a given directory. Return list in the cb.
   **************************************************************** */
exports.findNestedFiles = function(dir, cb) {
  var self = this;
  var files = [];

  fs.readdir(dir, function(err, list) {
    if (err) {
      return cb(err);
    }

    var pending = list.length;
    if (pending === 0) {
      return cb(null, files);
    }

    _.each(list, function(file) {
      file = dir + '/' + file;

      fs.stat(file, function(err, stat) {
        if (stat && stat.isDirectory()) {
          // Recurse one level deeper
          self.findNestedFiles(file, function(err, f) {
            pending = pending - 1;
            files = files.concat(f);

            if (pending === 0) {
              cb(null, files);
            }
          });
          return;
        }

        pending = pending - 1;
        files.push(file);

        if (pending === 0) {
          cb(null, files);
        }
      });
    });
  });
};
