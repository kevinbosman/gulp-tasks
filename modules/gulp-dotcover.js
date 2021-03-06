'use strict';
var gutil = require('gulp-util');
var es = require('event-stream');
var path = require('path');
var fs = require('fs');
var testUtilFinder = require('./testutil-finder');
var spawn = require('./spawn');
var log = require('./log');

var PLUGIN_NAME = 'gulp-dotcover';
var DEBUG = true;

function projectPathFor(p) {
    return path.resolve(p);
}

function dotCover(options) {
    options = options || {};
    options.exec = options.exec || {};
    options.exec.dotCover = options.exec.dotCover || testUtilFinder.latestDotCover(options);
    options.exec.nunit = options.exec.nunit || testUtilFinder.latestNUnit(options);
    options.baseFilters = options.baseFilters || '+:module=*;class=*;function=*;-:*.Tests';
    options.exclude = options.exclude || [];
    options.nunitOptions = options.nunitOptions || '/framework:net-4.5 /labels';
    options.nunitOutput = projectPathFor(options.nunitOutput || 'buildreports/nunit-result.xml');
    options.coverageReportBase = projectPathFor(options.coverageReportBase || 'buildreports/coverage');
    options.coverageOutput = projectPathFor(options.coverageOutput || 'buildreports/coveragesnapshot');
    if (typeof options.testAssemblyFilter !== 'function') {
        var regex = options.testAssemblyFilter;
        options.testAssemblyFilter = function(file) {
            return !!file.match(regex);
        }
    }
    DEBUG = options.debug || false;

    var mkdir = function(dir) {
        var parts = dir.split('/');
        var current = '';
        parts.forEach(function(item) {
            if (current) {
                current += '/';
            }
            current += item;
            if (!fs.existsSync(current)) {
                fs.mkdirSync(current);
            }
        });
    }

    var assemblies = [];

    var stream = es.through(function write(file) {
        if (!file) {
            fail(stream, 'file may not be empty or undefined');
        }
        var filePath = file.history[0];
        var parts = filePath.split('\\');
        if (parts.length === 1) {
            parts = filePath.split('/');
        }
        // only accept the one which is in the debug project output for itself
        var filePart = parts[parts.length-1];
        var projectParts = filePart.split('.');
        var projectName = projectParts.slice(0, projectParts.length-1).join('.');
        var isBin = parts.indexOf('bin') > -1;
        var isDebugOrAgnostic = parts.indexOf('Debug') > -1 || parts.indexOf('bin') === parts.length-2;
        var isProjectMatch = options.allowProjectAssemblyMismatch || parts.indexOf(projectName) > -1;
        var include = isBin && isDebugOrAgnostic && isProjectMatch;
        if (include) {
            assemblies.push(file);
        } else if(DEBUG) {
            log.debug('ignore: ' + filePath);
            log.debug('isBin: ' + isBin);
            log.debug('isDebugOrAgnostic: ' + isDebugOrAgnostic);
            log.debug('isProjectMatch: ' + isProjectMatch);
        }
        this.emit('data', file);
    }, function end() {
        runDotCoverWith(this, assemblies, options);
    }); 
    return stream;
};

function findExactExecutable(stream, options, what) {
    if (options.exec[what]) {
        var exe = trim(options.exec[what], '\\s', '"', '\'');
        if (!fs.existsSync(exe)) {
            fail(stream, 'Can\'t find executable for "' + what + '" at provided path: "' + options.exec[what] + '"');
        }
        return exe; 
    }
    fail(stream, 'Auto-detection of executables ('+ what+') not implemented yet. Please specify the exec.nunit and exec.dotCover options');
}
function findDotCover(stream, options) {
    return findExactExecutable(stream, options, 'dotCover');
}

function findNunit(stream, options) {
    return findExactExecutable(stream, options, 'nunit');
}

function fail(stream, msg) {
    stream.emit('error', new gutil.PluginError(PLUGIN_NAME, msg));
}
function end(stream) {
    stream.emit('end');
}
function trim() {
    var args = Array.prototype.slice.call(arguments)
    var source = args[0];
    var replacements = args.slice(1).join(',');
    var regex = new RegExp("^[" + replacements + "]+|[" + replacements + "]+$", "g");
    return source.replace(regex, '');
}

function isNunit3(nunitRunner) {
    return nunitRunner.indexOf('nunit3-') > -1;
}

function generateXmlOutputSwitchFor(nunitRunner, options) {
    var outFile = options.nunitOutput;
    return isNunit3(nunitRunner) ? '/result:' + outFile + ';format=nunit2' : '/xml=' + outFile;
}

function generateNoShadowFor(nunitRunner) {
    return isNunit3(nunitRunner) ? '': '/noshadow'; // default to not shadow in nunit3 & /noshadow deprecated
}

function generatePlatformSwitchFor(nunitRunner) {
    return isNunit3(nunitRunner) ? '/x86' : ''; // nunit 2 has separate runners; 3 has a switch
}

function updateLabelsOptionFor(nunitOptions, nunitRunner) {
    if (nunitOptions.indexOf('labels:') > -1) {
        return nunitOptions; // caller already updated for new labels= syntax
    }
    return nunitOptions.replace(/\/labels/, '/labels:All');
}

function runDotCoverWith(stream, allAssemblies, options) {
    var scopeAssemblies = [];
    var testAssemblies = allAssemblies.map(function(file) {
        return file.path;
    }).filter(function(file) {
        return options.testAssemblyFilter(file) || !scopeAssemblies.push(file);
    }).map(function(file) {
        return file.replace(/\\/g, '/');
    });
    if (testAssemblies.length === 0) {
        return fail(stream, 'No test assemblies defined');
    }
    var dotCover = findDotCover(stream, options);
    var nunit = findNunit(stream, options);

    var filterJoin = ';-:';
    var filters = options.baseFilters;
    if (options.exclude.length) {
        filters = [filters, options.exclude.join(filterJoin)].join(filterJoin);
    }

    var nunitOptions = [ 
        updateLabelsOptionFor(options.nunitOptions, nunit),
        generateXmlOutputSwitchFor(nunit, options),
        generateNoShadowFor(nunit),
        generatePlatformSwitchFor(nunit),
        testAssemblies.join(' ')].join(' ');
    var dotCoverOptions = ['cover',
        '/TargetExecutable=' + nunit,
        '/AnalyseTargetArguments=False',
        '/Output=' + options.coverageOutput,
        '/Filters=' + filters,
        '/TargetArguments=""' + nunitOptions + '""'
    ];
    if (scopeAssemblies.length) {
        dotCoverOptions.push('/Scope=' + scopeAssemblies.join(';'));
    }
    var reportArgsFor = function(reportType) {
        return ['report', 
            '/ReportType=' + reportType, 
            '/Source=' + options.coverageOutput,
            '/Output=' + options.coverageReportBase + '.' + reportType.toLowerCase()];
    }


    log.info('running testing with coverage...');
    log.info('running dotcover with: ' + dotCoverOptions.join(' '));
    spawn(dotCover, dotCoverOptions).then(function() {
        log.info('creating XML report');
        var args = reportArgsFor('XML');
        return spawn(dotCover, args);
    }).then(function() {
        log.info('creating HTML report');
        var args = reportArgsFor('HTML');
        return spawn(dotCover, args);
    }).then(function() {
        log.info('ending coverage successfully');
        end(stream)
    }).catch(function(data) {
        if (DEBUG) {
            log.debug(gutil.colors.red(message));
        }
        log.error('Coverage fails!');
        fail(stream, message);
    });
}

module.exports = dotCover;
