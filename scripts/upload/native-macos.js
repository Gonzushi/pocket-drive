/* macOS JXA: Foundation filesystem/process APIs, system curl and shasum. */
ObjC.import('Foundation');
var SERVER = '__POCKET_DRIVE_SERVER__';
var fm = $.NSFileManager.defaultManager;
var key = '';
var work = '';
var serial = 0;
function text(data) {
  return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '';
}
function read(path) {
  return text($.NSData.dataWithContentsOfFile(path));
}
function write(path, value) {
  var data = $(value).dataUsingEncoding($.NSUTF8StringEncoding);
  if (!data.writeToFileAtomically(path, true)) throw Error('Cannot write ' + path);
}
function remove(path) {
  fm.removeItemAtPathError(path, $());
}
function log(value) {
  $.NSFileHandle.fileHandleWithStandardError.writeData(
    $(value + '\n').dataUsingEncoding($.NSUTF8StringEncoding),
  );
}
function uuid() {
  return ObjC.unwrap($.NSUUID.UUID.UUIDString).toLowerCase();
}
function attr(path) {
  var value = fm.attributesOfItemAtPathError(path, $());
  if (!value) throw Error('Source is missing or unreadable: ' + path);
  return {
    type: ObjC.unwrap(value.objectForKey($.NSFileType)),
    size: Number(ObjC.unwrap(value.objectForKey($.NSFileSize))),
    modified: Number(value.objectForKey($.NSFileModificationDate).timeIntervalSince1970),
  };
}
function plainPath(value) {
  value = value.trim();
  if ((value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0])
    value = value.slice(1, -1);
  return ObjC.unwrap($(value).stringByExpandingTildeInPath.stringByStandardizingPath);
}
function processTask(command, args, input) {
  var tag = work + '/' + ++serial,
    out = tag + '.out',
    err = tag + '.err';
  fm.createFileAtPathContentsAttributes(out, $.NSData.data, $());
  fm.createFileAtPathContentsAttributes(err, $.NSData.data, $());
  var task = $.NSTask.alloc.init;
  task.launchPath = command;
  task.arguments = $(args);
  var output = $.NSFileHandle.fileHandleForWritingAtPath(out),
    errors = $.NSFileHandle.fileHandleForWritingAtPath(err);
  task.standardOutput = output;
  task.standardError = errors;
  var pipe = $.NSPipe.pipe;
  task.standardInput = pipe;
  task.launch;
  if (input)
    pipe.fileHandleForWriting.writeData($(input).dataUsingEncoding($.NSUTF8StringEncoding));
  pipe.fileHandleForWriting.closeFile;
  return { task: task, out: out, err: err, output: output, errors: errors };
}
function finishProcess(operation) {
  operation.task.waitUntilExit;
  operation.output.closeFile;
  operation.errors.closeFile;
  var result = {
    code: Number(operation.task.terminationStatus),
    output: read(operation.out),
    error: read(operation.err),
  };
  remove(operation.out);
  remove(operation.err);
  return result;
}
function fingerprint(path) {
  var before = attr(path);
  if (before.type !== 'NSFileTypeRegular')
    throw Error('Choose an original regular file, not a link: ' + path);
  var operation = processTask('/usr/bin/shasum', ['-a', '256', '--', path], '');
  var result = finishProcess(operation),
    after = attr(path);
  if (result.code !== 0) throw Error('Cannot read file for checksum: ' + path);
  if (before.size !== after.size || before.modified !== after.modified)
    throw Error('Source changed while reading: ' + path);
  return {
    size: before.size,
    modified_ns: null,
    sha256: result.output.match(/[a-f0-9]{64}/)[0],
    modified: before.modified,
  };
}
function request(method, route, body, offset) {
  var args = [
    '--disable', // Ignore user curl configuration that could follow redirects or log headers.
    '--silent',
    '--show-error',
    '--max-time',
    '135',
    '--connect-timeout',
    '20',
    '--config',
    '-',
    '--request',
    method,
    '--write-out',
    '\n%{http_code}',
    SERVER + route,
  ];
  var files = [];
  var config = 'header = "Authorization: Bearer ' + key + '"\n';
  if (body !== undefined && body !== null) {
    var path = work + '/body-' + uuid();
    if (typeof body === 'string') {
      args.push('--data-binary', '@' + body);
      config += 'header = "Content-Type: application/octet-stream"\n';
    } else {
      write(path, JSON.stringify(body));
      files.push(path);
      args.push('--data-binary', '@' + path);
      config += 'header = "Content-Type: application/json"\n';
    }
  }
  if (offset !== undefined) config += 'header = "Upload-Offset: ' + offset + '"\n';
  var operation = processTask('/usr/bin/curl', args, config);
  operation.files = files;
  return operation;
}
function response(operation) {
  var result = finishProcess(operation);
  operation.files.forEach(remove);
  if (result.code !== 0) {
    var offline = Error('Connection interrupted; resume from confirmed status.');
    offline.status = 0;
    throw offline;
  }
  var index = result.output.lastIndexOf('\n'),
    status = Number(result.output.slice(index + 1));
  var data;
  try {
    data = JSON.parse(result.output.slice(0, index));
  } catch (_) {
    var damaged = Error('Response was interrupted.');
    damaged.status = 0;
    throw damaged;
  }
  if (status < 200 || status >= 300) {
    var error = Error('HTTP ' + status + ': ' + (data.error || 'Request failed.'));
    error.status = status;
    throw error;
  }
  return data;
}
function syncRequest(method, route, body) {
  return response(request(method, route, body));
}
function record(path, relative, kind) {
  var entry = {
    source: path,
    relative_path: relative,
    kind: kind,
    upload_id: uuid(),
    status: 'pending',
    attempts: 0,
    error: '',
  };
  if (kind === 'file') {
    try {
      entry.fingerprint = fingerprint(path);
    } catch (error) {
      entry.fingerprint = null;
      entry.status = 'failed';
      entry.error = String(error.message);
    }
  }
  return entry;
}
function scan(path, reportDir) {
  var entries = [],
    skipped = [],
    initial = attr(path);
  if (initial.type === 'NSFileTypeRegular')
    return { entries: [record(path, '', 'file')], skipped: [] };
  if (initial.type !== 'NSFileTypeDirectory')
    throw Error('Choose an original file or folder, not a link.');
  var stack = [{ path: path, relative: path.split('/').pop() }];
  while (stack.length) {
    var current = stack.pop();
    entries.push(record(current.path, current.relative, 'folder'));
    var children = ObjC.deepUnwrap(fm.contentsOfDirectoryAtPathError(current.path, $()));
    if (!children) throw Error('Cannot read folder: ' + current.path);
    children.sort().forEach(function (name) {
      var child = current.path + '/' + name,
        info = attr(child),
        relative = current.relative + '/' + name;
      if (
        info.type === 'NSFileTypeSymbolicLink' ||
        (current.path === reportDir && /^pocket-drive-upload-.*\.json$/.test(name))
      )
        skipped.push(child);
      else if (info.type === 'NSFileTypeDirectory') stack.push({ path: child, relative: relative });
      else if (info.type === 'NSFileTypeRegular') entries.push(record(child, relative, 'file'));
      else skipped.push(child);
    });
    if (entries.length + stack.length > 15000) throw Error('At most 15,000 files/folders per job.');
  }
  return { entries: entries, skipped: skipped };
}
function checkReport(report) {
  if (
    report.format !== 'pocket-drive-upload' ||
    report.version !== 1 ||
    report.server.replace(/\/$/, '') !== SERVER.replace(/\/$/, '')
  )
    throw Error('Report is invalid or belongs to another server.');
  if (!Array.isArray(report.entries) || report.entries.length > 15000)
    throw Error('Invalid report entries.');
  report.entries.forEach(function (e) {
    if (
      ['file', 'folder'].indexOf(e.kind) < 0 ||
      typeof e.source !== 'string' ||
      typeof e.relative_path !== 'string'
    )
      throw Error('Invalid source/destination in report.');
    if (
      e.kind === 'file' &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(e.upload_id)
    )
      throw Error('Invalid upload ID in report.');
  });
}
function ascii(value) {
  return value.replace(/[A-Z]/g, function (c) {
    return c.toLowerCase();
  });
}
function folders(entries) {
  var selected = entries.filter(function (e) {
    return e.kind === 'folder';
  });
  if (!selected.length) return;
  try {
    var mapping = {};
    function merge(tree) {
      tree.forEach(function (f) {
        mapping[(f.parent_id || '') + '/' + ascii(f.name)] = f.id;
      });
    }
    merge(syncRequest('GET', '/api/folders/tree').folders);
    selected
      .sort(function (a, b) {
        return a.relative_path.split('/').length - b.relative_path.split('/').length;
      })
      .forEach(function (entry) {
        try {
          var parent = '';
          entry.relative_path.split('/').forEach(function (name) {
            var lookup = parent + '/' + ascii(name);
            if (!mapping[lookup]) {
              try {
                mapping[lookup] = syncRequest('POST', '/api/folders', {
                  name: name,
                  parent_id: parent || 'root',
                }).id;
              } catch (error) {
                if (error.status !== 409) throw error;
                merge(syncRequest('GET', '/api/folders/tree').folders);
                if (!mapping[lookup]) throw error;
              }
            }
            parent = mapping[lookup];
          });
          entry.status = 'complete';
          entry.error = '';
        } catch (error) {
          entry.status = 'failed';
          entry.error = String(error.message).split(key).join('[redacted]');
        }
      });
  } catch (error) {
    selected.forEach(function (e) {
      if (e.status !== 'complete') {
        e.status = 'failed';
        e.error = String(error.message).split(key).join('[redacted]');
      }
    });
  }
}
function start(entry) {
  var identity = fingerprint(entry.source);
  if (!entry.fingerprint) entry.fingerprint = identity;
  if (identity.size !== entry.fingerprint.size || identity.sha256 !== entry.fingerprint.sha256)
    throw Error('Source changed since this job; start a fresh upload for this file.');
  entry.attempts++;
  entry.status = 'uploading';
  return {
    entry: entry,
    identity: identity,
    phase: 'status',
    operation: request('GET', '/api/uploads/' + entry.upload_id),
  };
}
function next(worker, status) {
  var entry = worker.entry;
  if (status.status === 'complete') {
    if (!status.file || status.file.checksum !== worker.identity.sha256)
      throw Error('Server checksum differs; inspect this upload before retrying.');
    entry.file_id = status.file.id;
    entry.status = 'complete';
    entry.error = '';
    worker.done = true;
    return;
  }
  if (status.busy) {
    var busy = Error('Another request is using this upload.');
    busy.status = 409;
    throw busy;
  }
  var route = '/api/uploads/' + entry.upload_id;
  if (status.offset >= worker.identity.size) {
    var current = fingerprint(entry.source);
    if (current.size !== worker.identity.size || current.sha256 !== worker.identity.sha256)
      throw Error('Source changed during upload.');
    worker.phase = 'complete';
    worker.operation = request('POST', route + '/complete', {});
    return;
  }
  var info = attr(entry.source);
  if (info.size !== worker.identity.size || info.modified !== worker.identity.modified)
    throw Error('Source changed during upload.');
  var handle = $.NSFileHandle.fileHandleForReadingAtPath(entry.source);
  if (!handle) throw Error('Cannot read source file.');
  var data;
  try {
    handle.seekToFileOffset(status.offset);
    data = handle.readDataOfLength(
      Math.min(status.chunk_size, worker.identity.size - status.offset),
    );
  } finally {
    handle.closeFile;
  }
  if (!Number(data.length)) throw Error('Source ended before expected size.');
  worker.chunk = work + '/chunk-' + uuid();
  if (!data.writeToFileAtomically(worker.chunk, true)) throw Error('Cannot prepare upload chunk.');
  worker.phase = 'chunk';
  worker.operation = request('PATCH', route, worker.chunk, status.offset);
}
function advance(worker) {
  var data;
  try {
    data = response(worker.operation);
  } catch (error) {
    if (worker.phase === 'status' && error.status === 404) {
      worker.phase = 'create';
      worker.operation = request('POST', '/api/uploads', {
        id: worker.entry.upload_id,
        name: worker.entry.source.split('/').pop(),
        size: worker.identity.size,
        mime_type: 'application/octet-stream',
        folder_id: 'root',
        relative_path: worker.entry.relative_path,
      });
      return;
    }
    throw error;
  } finally {
    if (worker.chunk) {
      remove(worker.chunk);
      worker.chunk = '';
    }
  }
  if (worker.phase === 'chunk')
    log(
      'Uploading ' +
        worker.entry.source.split('/').pop() +
        ': ' +
        data.offset +
        '/' +
        worker.identity.size +
        ' bytes',
    );
  next(worker, data);
}
function run(argv) {
  var reportDir = argv[0],
    mode = argv[1],
    target = plainPath(argv[2]),
    concurrency = Number(argv[3]);
  key = text($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile).trim();
  if (!/^pd_[a-f0-9]{64}$/.test(key)) throw Error('Enter a complete Pocket Drive API key.');
  if (!(concurrency >= 1 && concurrency <= 8 && concurrency === Math.floor(concurrency)))
    throw Error('Concurrency must be 1-8.');
  work = ObjC.unwrap($.NSTemporaryDirectory()) + 'pocket-native-' + uuid();
  if (!fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(work, true, $(), $()))
    throw Error('Cannot create temporary working directory.');
  var checkpoint =
    reportDir + '/pocket-drive-upload-progress-' + Date.now() + '-' + uuid().slice(0, 6) + '.json';
  var report,
    active = [];
  function save() {
    write(checkpoint, JSON.stringify(report, null, 2));
  }
  try {
    if (mode === '2') {
      report = JSON.parse(read(target));
      checkReport(report);
    } else {
      log('Scanning and fingerprinting files...');
      var source = scan(target, reportDir);
      report = {
        format: 'pocket-drive-upload',
        version: 1,
        server: SERVER,
        entries: source.entries,
        skipped: source.skipped,
      };
    }
    report.created_at = new Date().toISOString();
    save();
    log('Recovery report: ' + checkpoint);
    folders(report.entries);
    save();
    var pending = report.entries.filter(function (e) {
        return e.kind === 'file' && e.status !== 'complete';
      }),
      cursor = 0;
    while (cursor < pending.length || active.length) {
      while (cursor < pending.length && active.length < concurrency) {
        var entry = pending[cursor++];
        try {
          active.push(start(entry));
        } catch (error) {
          entry.status = 'failed';
          entry.error = String(error.message).split(key).join('[redacted]');
        }
        save();
      }
      active.forEach(function (worker) {
        if (worker.due) {
          if (Date.now() < worker.due) return;
          try {
            var again = start(worker.entry);
            worker.identity = again.identity;
            worker.phase = again.phase;
            worker.operation = again.operation;
            worker.due = 0;
          } catch (error) {
            worker.entry.status = 'failed';
            worker.entry.error = String(error.message);
            worker.done = true;
            save();
          }
          return;
        }
        if (worker.operation.task.isRunning) return;
        try {
          advance(worker);
        } catch (error) {
          worker.entry.status = 'failed';
          worker.entry.error = String(error.message).split(key).join('[redacted]');
          worker.retries = (worker.retries || 0) + 1;
          if (
            worker.retries < 4 &&
            [0, 408, 409, 429, 500, 502, 503, 504].indexOf(error.status) >= 0
          )
            worker.due = Date.now() + Math.pow(2, worker.retries - 1) * 1000;
          else worker.done = true;
          save();
        }
        if (worker.done) {
          log(
            worker.entry.status +
              ': ' +
              worker.entry.source +
              (worker.entry.error ? ' — ' + worker.entry.error : ''),
          );
          save();
        }
      });
      active = active.filter(function (worker) {
        return !worker.done;
      });
      $.NSThread.sleepForTimeInterval(0.05);
    }
    var failed = report.entries.filter(function (e) {
      return e.status !== 'complete';
    });
    var count = report.entries.filter(function (e) {
      return e.kind === 'file' && e.status === 'complete';
    }).length;
    log(
      'Finished: ' +
        count +
        ' files uploaded; ' +
        failed.length +
        ' failed entries; ' +
        (report.skipped || []).length +
        ' skipped.',
    );
    if (failed.length) {
      var failure = checkpoint.replace('-progress-', '-failures-');
      write(failure, JSON.stringify(report, null, 2));
      log('Failure report: ' + failure);
      throw Error('Some uploads failed. Retry using the JSON report.');
    }
    return 'Upload complete.';
  } finally {
    active.forEach(function (worker) {
      if (worker.operation && worker.operation.task.isRunning) worker.operation.task.terminate;
    });
    if (report) save();
    remove(work);
  }
}
