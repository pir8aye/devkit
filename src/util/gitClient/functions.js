const debug = require('debug');
var path = require('path');
var errors = require('./errors');
var semver = require('semver');
var Promise = require('bluebird');

// Can't wait for destructuring assingments...
var UnknownGitRevision = errors.UnknownGitRevision;
var FatalGitError = errors.FatalGitError;
var UnknownGitOption = errors.UnknownGitOption;


const log = debug('devkit:gitClient:functions');


// the git commands on windows don't return the OS end of line (\r\n)
// using this regex for all end of line matching instead of os.EOL
// when parsing command responses
var EOL_REGEX = /[\r]?\n/;

/**
 * remove leading / trailing whitespace from a string
 */

function strip(str) {
  return str.replace(/^\s+|\s+$/g, '');
}

/**
 * Filter local tags which are valid semvers and return the highest version
 *
 * @return Promise<string>
 */

exports.getLatestLocalTag = function getLatestLocalTag (opts) {
  var git = this;

  return (opts && opts.skipFetch
      ? Promise.resolve()
      : git('fetch', '--tags'))
    .then(function () {
      return git('tag', '-l', {extraSilent: true});
    })
    .then(function (tags) {
      if (tags) {
        tags = tags.split(EOL_REGEX).filter(semver.valid);
        tags.sort(semver.rcompare);
        return tags[0];
      }

      return;
    });
};

/**
 * Filter local tags which are valid semvers
 *
 * @return Promise<Array<String>>
 */

exports.getLocalTags = function getLocalTags (cb) {
  var git = this;
  return git('tag', '-l', {extraSilent: true}).then(function (tags) {
    if (tags) {
      tags = tags.split(EOL_REGEX).filter(semver.valid);
      tags.sort(semver.rcompare);
      return tags;
    }

    return [];
  }).nodeify(cb);
};

/**
 * Handle errors generated by git show-ref
 *
 * Promise will resolve with false if exited normally
 *
 * @api private
 * @return Promise<Boolean, Error>
 */

function handleShowRefVerifyError (err) {
  if (err && err.code && err.code === 1) {
    // ref does not exist
    return Promise.resolve(false);
  }
  return Promise.reject(err);
}

/**
 * See if ref is a local branch
 *
 * @returns {Promise<boolean>}
 */

exports.isLocalBranch = function isLocalBranch (ref, cb) {
  return this(
    'show-ref', '--verify', '--quiet', '--heads', 'refs/heads/' + ref
  )
    .return(true)
    .catch(handleShowRefVerifyError, function () {
      return false;
    })
    .nodeify(cb);
};

/**
 * See if ref is a remote branch
 */

exports.isRemoteBranch = function isRemoteBranch (ref, cb) {
  return this(
    'show-ref', '--verify', '--quiet', '--heads', 'refs/remotes/origin/' + ref
  )
    .return(true)
    .catch(handleShowRefVerifyError, function () {
      return false;
    })
    .nodeify(cb);
};

/**
 * Check if repo has branch either remote or local
 *
 * @return {Promes<boolean>}
 */

exports.isBranch = function isBranch (ref, cb) {
  return Promise.all([
    this.isLocalBranch(ref),
    this.isRemoteBranch(ref)
  ]).spread(function (local, remote) {
    return local || remote;
  }).nodeify(cb);
};

/**
 * See if ref is a local tag
 *
 * @returns {Promise<boolean>}
 */

exports.isTag = function isTag (ref, cb) {
  return this('show-ref', '--verify', '--quiet', '--tags', 'refs/tags/' + ref)
    .return(true)
    .catch(handleShowRefVerifyError, function () {
      return false;
    })
    .nodeify(cb);
};

/**
 * Check that hash is valid
 *
 * @returns {Promise<boolean>}
 */

exports.isHashValidRef = function isHashValidRef (hash, cb) {
  log('isHashValidRef:', hash);
  // Check that hash format is ok before calling into git
  if (!/^[a-f0-9]{1,40}$/i.test(hash)) {
    return Promise.resolve(false);
  }

  return this('log', '--pretty=format:%H', '-n', '1', hash)
    .return(true)
    .catch(FatalGitError, function (err) {
      log('> FatalGitError:', err);
      if (/bad object/.test(err.message)) {
        log('> > found: "bad object"');
        return false;
      }
      if (/unknown revision or path not in the working tree./.test(err.message)) {
        log('> > Found: "unknown revision..."');
        return false;
      }

      throw err;
    })
    .nodeify(cb);
};

exports.getRefType = function getRefType (ref, cb) {
  log('getRefType:', ref);
  return Promise.all([
    this.isTag(ref),
    this.isBranch(ref),
    this.isHashValidRef(ref)
  ]).spread(function (isTag, isBranch, isHash) {
    // Cannot find ref locally
    if (!isTag && !isBranch && !isHash) {
      return Promise.reject(new Error('invalid ref: ' + ref));
    }

    if (isTag) {
      return 'tag';
    } else if (isBranch) {
      return 'branch';
    } else if (isHash) {
      return 'hash';
    }
  }).nodeify(cb);
};

/**
 * Get hash for current HEAD ref
 *
 * @return {Promise<string>}
 */

exports.getCurrentHead = function getCurrentHead (cb) {
  return this('rev-parse', 'HEAD').then(function (ref) {
    return strip(ref);
  }).nodeify(cb);
};

/**
 * Get current tag name - if any
 *
 * @return {Promise<string>}
 */

exports.getCurrentTag = function getCurrentTag (cb) {
  return this('describe', '--tags', '--exact-match')
    .then(function (tag) {
      return strip(tag);
    })
    .catch(FatalGitError, function (err) {
      var msg = err.message;
      if (/cannot describe/.test(msg) || /no tag/.test(msg)) {
        return Promise.resolve('');
      }

      return Promise.reject(err);
    })
    .catch(function (err) {
      if (err.stderr) {
        if (/no tag/.test(err.stderr) || /no names found/i.test(err.stderr)) {
          return;
        }
      }

      return Promise.reject(err);
    })
    .nodeify(cb);
};

/**
 * Get primary branch name. Looks up origin's HEAD pointer and resolves it a
 * branch name. If there is no origin HEAD ref, fall back to local.
 *
 * @return {Promise<string>}
 */

exports.getPrimaryBranchName = function getPrimaryBranchName (cb) {
  //return this('rev-parse', '--symbolic-full-name', 'HEAD').then(function () {
  return this(
    'rev-parse', '--symbolic-full-name', 'origin/HEAD'
  ).catch(FatalGitError, function (err) {
    // Couldn't find a HEAD pointer for origin
    if (/unknown revision/.test(err.message)) {
      return this('rev-parse', '--symbolic-full-name', 'HEAD');
    }

    throw err;
  }).then(function (ref) {
    // Return just the branch name
    return ref.split('/').pop();
  }).nodeify(cb);
};

/**
 * Get a tag, branch name, or hash for the specified version
 *
 * If version is undefined, get the latest valid semver tag. If no valid semver
 * tags are available, fall back to the primary branch.
 *
 * If version is a tag name, branch, or hash, validate that it exists in the
 * repository and return the tag name.
 *
 * If the version cannot be resolved, reject with UnknownGitRevision.
 *
 * @return {Promise<String, UnknownGitRevision>}
 */

exports.validateVersion = function validateVersion (version, cb) {
  log('validateVersion:', version);
  return Promise
    .resolve()
    .bind(this)
    .then(function () {
      if (!version) {
        return this.ensureVersion().nodeify(cb);
      }

      return version;
    })
    .then(function (version) {
      return [
        version,
        this.isTag(version),
        this.isBranch(version),
        this.isHashValidRef(version)
      ];
    })
    .all()
    .spread(function (version, isTag, isBranch, isValidHash) {
      log(`> version= ${version} isTag= ${isTag} isBranch= ${isBranch} isValidHash= ${isValidHash}`);
      var type = isTag ? 'tag'
        : isBranch ? 'branch'
        : isValidHash ? 'hash'
        : null;

      return type
        ? [version, type]
        : Promise.reject(new UnknownGitRevision(version));
    })
    .nodeify(cb);
};

/**
 * @typedef ShowRefInfo
 * @param {string} ref
 * @param {string} hash
 * @param {string} [remote]
 */

/**
 * Parse output from `git show-ref`
 *
 * @api private
 * @return {Array<ShowRefInfo>}
 */

function parseShowRefOutput (refs) {
  // TODO handle tags
  return (refs || '').split(EOL_REGEX).filter(function (str) {
    return !!str;
  }).map(function (ref) {
    var parts = ref.split(' ');
    var hash = parts[0];
    var refSpec = parts[1].split('/');
    var branch = refSpec[refSpec.length - 1];
    var isRemote = /^refs\/remotes\//.test(parts[1]);
    var remote = isRemote ?
      /^refs\/remotes\/([a-zA-Z0.9_-]+)\//.exec(parts[1]) :
      void 0;

    return {
      ref: branch,
      remote: remote,
      hash: hash
    };
  });
}

/**
 * get hash for a given ref. If ref is a branch name, get the hash for the
 * branch on origin with fallback to local branch head.
 *
 * @return {Promise<String, UnknownGitRevision>}
 */

exports.getHashForRef = function getHashForRef (ref, cb) {
  trace('gitClient#getHashForRef');
  return this('show-ref', ref)
    .bind(this)
    .catch(handleShowRefVerifyError)
    .then(function findMostCurrentRef(refs) {
      trace('refs', refs);
      refs = parseShowRefOutput(refs);

      var remote = refs.filter(function (refInfo) {
        return refInfo.remote && refInfo.ref === ref;
      })[0];

      trace('remote', remote);

      if (remote) { return remote.hash; }

      var local = refs.filter(function (refInfo) {
        return refInfo.ref.trim() === ref;
      })[0];

      trace('local', local);
      if (local) { return local.hash; }

      // See if ref is a valid hash
      return this('rev-parse', ref)
        .then(function isRef(stdout) {
          return strip(stdout);
        })
        .catch(function () {
          return Promise.reject(new UnknownGitRevision(ref));
        });
    })
    .nodeify(cb);
};

/**
 * Fetch from origin. Gets tags and refs
 */

exports.fetch = function fetch (cb) {
  return this('fetch', '--tags').nodeify(cb);
};

/**
 * Given some version, ensure that it is something useful in the context of
 * this repository.
 *
 * Semantics:
 *   version is undefined -> get latest semver or primary branch name
 *   version is a string ->
 *
 * @return {Promise<String, UnknownGitRevision>}
 */

exports.ensureVersion = function ensureVersion (version, cb) {
  if (!version) {
    return this.getLatestLocalTag().bind(this).then(function (tag) {
      if (tag) {
        return tag;
      }

      return this.getPrimaryBranchName();
    }).nodeify(cb);
  }

  return Promise.resolve(version).nodeify(cb);
};

/**
 * Checkout some reference. Delegates to checkoutBranch if ref is a branch, or
 * checkoutTagOrHash otherwise.
 *
 * @param {string} ref
 * @return {Promise}
 */

exports.checkoutRef = function checkoutRef (ref, cb) {
  var git = this;
  return git.isBranch(ref).then(function (isBranch) {
    if (isBranch) {
      // Handle branch request. Branches are special since we will pull after
      // checkout.
      return git.checkoutBranch(ref);
    }

    // Handle other request (tags, hash)
    return git.checkoutTagOrHash(ref);
  }).nodeify(cb);
};

/**
 * Simply checkout a ref directly. The ref is assumed to be available.
 */

exports.checkoutTagOrHash = function checkoutTagOrHash (ref, cb) {
  return this('checkout', ref).nodeify(cb);
};

/**
 * Checkout a branch. Update from the remote if the local is not recent.
 */

exports.checkoutBranch = function checkoutBranch (ref, cb) {
  var branch = ref;
  var git = this;
  return git.isLocalBranch(branch).then(function (local) {
    if (local) {
      return git('checkout', branch);
    }

    return git('checkout', '-b', branch);
  }).catch(function (err) {
    logger.error('Failed to checkout branch', branch);
    return Promise.reject(err);
  }).then(function () {
    return git('reset', '--hard', 'origin/' + branch);
  }).nodeify(cb);
};

/**
 * Returns git status --porcelain for the current repo and all submodules
 * in an array of the format:
 * {
 *    code: git porcelain 2-char code
 *    filename: path to file that changed
 *    submodule: the path to the submodule, if any
 * }
 */
exports.listChanges = function () {
  var prefix = '----';

  return Promise
    .all([
      this('status', '--porcelain', '--ignore-submodules=untracked'),
      this('submodule', 'foreach', '--quiet',
           'echo "' + prefix + '" $path && git status --porcelain')
    ])
    .bind(this)
    .spread(function (local, submodules) {
        var lines = (prefix + '\n' + local + '\n' + submodules)
          .split('\n')
          .filter(function (line) { return line; });

        var n = lines.length;
        var currentPath = '';
        var changes = [];

        for (var i = 0; i < n; ++i) {
          if (lines[i].substring(0, prefix.length) == prefix) {
            currentPath = lines[i].substring(prefix.length + 1);
          } else {
            var filename = lines[i].substring(3);
            if (currentPath) {
              filename = path.join(currentPath, filename);
            }

            changes.push({
              code: lines[i].substring(0, 2),
              filename: filename,
              submodule: currentPath
            });
          }
        }

        return changes;
      });
}
