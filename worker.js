var inherits = require('util').inherits;
var smith = require('smith');
var Agent = smith.Agent;
var Stream = require('stream').Stream;
var execFile = require("child_process").execFile;

exports.smith = smith;

exports.Worker = Worker;

// Worker is a smith.Agent that wraps the vfs api passed to it.  It's works in
// tandem with Consumer agents on the other side.
function Worker(vfs) {
    Agent.call(this, {

        // Endpoints for writable streams at meta.stream (and meta.process.stdin)
        write: write,
        end: end,

        // Endpoint for readable stream at meta.stream (and meta.process.{stdout,stderr})
        destroy: destroy,

        // Endpoints for readable streams at options.stream
        onData: onData,
        onEnd: onEnd,

        // Endpoint for writable streams at options.stream
        onClose: onClose,

        // Endpoints for processes at meta.process
        kill: kill,

        // Endpoints for processes at meta.pty
        resize: resize,

        // Endpoint for watchers at meta.watcher
        close: closeWatcher,

        // Endpoint for apis at meta.api
        call: call,

        // Endpoints for vfs itself
        subscribe: subscribe,
        unsubscribe: unsubscribe,
        emit: vfs.emit,

        // special vfs-socket api
        ping: ping,

        // Route other calls to the local vfs instance
        resolve:  route("resolve"),
        stat:     route("stat"),
        metadata: route("metadata"),
        readfile: route("readfile"),
        readdir:  route("readdir"),
        mkfile:   route("mkfile"),
        mkdir:    route("mkdir"),
        rmfile:   route("rmfile"),
        rmdir:    route("rmdir"),
        rename:   route("rename"),
        copy:     route("copy"),
        symlink:  route("symlink"),
        watch:    route("watch"),
        connect:  route("connect"),
        spawn:    route("spawn"),
        pty:      route("pty"),
        execFile: route("execFile"),
        extend:   route("extend"),
        unextend: route("unextend"),
        use:      route("use")

    });

    var proxyStreams = {};
    var streams = {};
    var watchers = {};
    var processes = {};
    var apis = {};
    var handlers = {};
    var remote = this.remoteApi;

    function subscribe(name, callback) {
        handlers[name] = function (value) {
            remote.onEvent(name, value);
        };
        vfs.on(name, handlers[name], callback);
    }

    function unsubscribe(name, callback) {
        var handler = handlers[name];
        if (!handler) return;
        delete handlers[name];
        vfs.off(name, handler, callback);
    }

    // Resume readable streams that we paused when the channel drains
    // Forward drain events to all the writable proxy streams.
    this.on("drain", function () {
        Object.keys(streams).forEach(function (id) {
            var stream = streams[id];
            if (stream.readable && stream.resume) stream.resume();
        });
        Object.keys(proxyStreams).forEach(function (id) {
            var stream = proxyStreams[id];
            if (stream.writable) stream.emit("drain");
        });
    });

    // Cleanup streams, proxy streams, proxy processes, and proxy apis on disconnect.
    this.on("disconnect", function (err) {
        if (!err) {
            err = new Error("EDISCONNECT: vfs socket disconnected");
            err.code = "EDISCONNECT";
        }
        Object.keys(processes).forEach(function (pid) {
            var process = processes[pid];
            process.kill();
            delete processes[pid];
        });
        Object.keys(streams).forEach(function (id) {
            var stream = streams[id];
            stream.emit("close", err);
        });
        Object.keys(proxyStreams).forEach(onClose);
        Object.keys(watchers).forEach(function (id) {
            var watcher = watchers[id];
            delete watchers[id];
            watcher.close();
        });
    });
    
    function makeStreamProxy(token) {
        var stream = new Stream();
        var id = token.id;
        stream.id = id;
        proxyStreams[id] = stream;
        if (token.hasOwnProperty("readable")) stream.readable = token.readable;
        if (token.hasOwnProperty("writable")) stream.writable = token.writable;

        if (stream.writable) {
            stream.write = function (chunk) {
                return remote.write(id, chunk);
            };
            stream.end = function (chunk) {
                if (chunk) remote.end(id, chunk);
                else remote.end(id);
            };
        }
        if (stream.readable) {
            stream.destroy = function () {
                remote.destroy(id);
            };
        }

        return stream;
    }

    var nextStreamID = 1;
    function storeStream(stream) {
        nextStreamID = nextStreamID++ % 10000;
        while (streams.hasOwnProperty(nextStreamID)) { nextStreamID++ % 10000; }
        var id = nextStreamID;
        streams[id] = stream;
        stream.id = id;
        if (stream.readable) {
            stream.on("data", function (chunk) {
                if (remote.onData(id, chunk) === false) {
                    stream.pause && stream.pause();
                }
            });
            stream.on("end", function (chunk) {
                delete streams[id];
                remote.onEnd(id, chunk);
            });
        }
        stream.on("close", function () {
            delete streams[id];
            remote.onClose(id);
        });
        var token = {id: id};
        if (stream.hasOwnProperty("readable")) token.readable = stream.readable;
        if (stream.hasOwnProperty("writable")) token.writable = stream.writable;
        return token;
    }

    function storeProcess(process, onlyPid) {
        var pid = process.pid;
        processes[pid] = process;
        process.on("exit", function (code, signal) {
            delete processes[pid];
            remote.onExit(pid, code, signal);
        });
        process.on("close", function () {
            delete processes[pid];
            if (!onlyPid) {
                delete streams[process.stdout.id];
                delete streams[process.stderr.id];
                delete streams[process.stdin.id];
            }
            remote.onProcessClose(pid);
        });

        process.kill = function(code) {
            killtree(pid, code);
        };
        
        if (onlyPid)
            return pid;

        var token = {pid: pid};
        token.stdin = storeStream(process.stdin);
        token.stdout = storeStream(process.stdout);
        token.stderr = storeStream(process.stderr);
        return token;
    }
    
    function storePty(pty) {
        var pid = storeProcess(pty, true);
        var token = storeStream(pty);
        token.pid = pid;
        
        return token;
    }

    function killtree(pid, code) {
        childrenOfPid(pid, function(err, pidlist){
            if (err) {
                console.error(err.stack);
                return;
            }
            pidlist.forEach(function (pid) {
                try {
                    process.kill(pid, code || "SIGKILL");
                } catch(e) {
                    // kill may throw if the pid does not exist.
                }
            });
        });
    }

    function childrenOfPid(pid, callback) {
        execFile("ps", ["-A", "-oppid,pid"], function(code, stdout, stderr) {
            if (code)
                return callback(code + ":" + stderr);

            var parents = {};
            stdout.split("\n").slice(1).forEach(function(line) {
                var col = line.trim().split(/\s+/g);
                (parents[col[0]] || (parents[col[0]] = [])).push(col[1]);
            });

            function search(roots) {
            var res = roots.concat();
            for (var c, i = 0; i < roots.length; i++) {
                if ((c = parents[roots[i]]) && c.length)
                    res.push.apply(res, search(c));
                }
                return res;
            }
            callback(null, search([pid]));
        });
    }

    var nextWatcherID = 1;
    function storeWatcher(watcher) {
        while (watchers.hasOwnProperty(nextWatcherID)) { nextWatcherID++; }
        var id = nextWatcherID;
        watchers[id] = watcher;
        watcher.id = id;
        watcher.on("change", function (event, filename) {
            remote.onChange(id, event, filename);
        });
        var token = {id: id};
        return token;
    }

    function storeApi(api) {
        var name = api.name;
        apis[name] = api;
        var token = { name: name, names: api.names };
        return token;
    }

    // Remote side writing to our local writable streams
    function write(id, chunk) {
        // They want to write to our real stream
        var stream = streams[id];
        if (!stream) return;
        stream.write(chunk);
    }
    function destroy(id) {
        var stream = streams[id];
        if (!stream) return;
        delete streams[id];
        stream.destroy();
    }
    function end(id, chunk) {
        var stream = streams[id];
        if (!stream) return;
        delete streams[id];
        if (chunk) stream.end(chunk);
        else stream.end();
    }

    function kill(pid, code) {
        var process = processes[pid];
        if (!process) return;
        process.kill(code);
    }

    function resize(pid, cols, rows) {
        var process = processes[pid];
        if (!process) return;
        
        // Resize can throw
        try { process.resize(cols, rows); }
        catch(e) {};
    }

    function closeWatcher(id) {
        var watcher = watchers[id];
        if (!watcher) return;
        delete watchers[id];
        watcher.close();
        nextWatcherID = id;
    }

    function call(name, fnName, args) {
        var api = apis[name];
        if (!api) return;

        // If the last arg is a function, assume it's a callback and process it.
        if (typeof args[args.length - 1] == "function") {
            var callback = args[args.length - 1];
            args[args.length - 1] = function (err, meta) {
                if (err || (meta && typeof meta === "object")) {
                    return processCallback(err, meta, callback);
                }
                callback(err, meta);
            };
        }

        api[fnName].apply(api, args);
    }

    function onData(id, chunk) {
        var stream = proxyStreams[id];
        if (!stream) return;
        stream.emit("data", chunk);
    }
    function onEnd(id, chunk) {
        var stream = proxyStreams[id];
        if (!stream) return;
        // TODO: not delete proxy if close is going to be called later.
        // but somehow do delete proxy if close won't be called later.
        delete proxyStreams[id];
        stream.emit("end", chunk);
    }
    function onClose(id) {
        var stream = proxyStreams[id];
        if (!stream) return;
        delete proxyStreams[id];
        stream.emit("close");
    }

    // Can be used for keepalive checks.
    function ping(callback) {
        callback();
    }

    function processCallback(err, meta, callback) {
        // Make error objects serializable
        if (err) {
            var nerr = {
                stack: process.pid + ": " + err.stack
            };
            if (err.hasOwnProperty("code")) nerr.code = err.code;
            if (err.hasOwnProperty("message")) nerr.message = err.message;
            return callback(nerr);
        }
        var token = {};
        var keys = Object.keys(meta);
        for (var i = 0, l = keys.length; i < l; i++) {
            var key = keys[i];
            switch (key) {
                case "stream": token.stream = storeStream(meta.stream); break;
                case "process": token.process = storeProcess(meta.process); break;
                case "pty": token.pty = storePty(meta.pty); break;
                case "watcher": token.watcher = storeWatcher(meta.watcher); break;
                case "api": token.api = storeApi(meta.api); break;
                default: token[key] = meta[key]; break;
            }
        }
        // Call the remote callback with the result
        callback(null, token);
    }

    function route(name) {
        return function wrapped(path, options, callback) {
            if (typeof callback !== "function") {
                throw new Error(name + ": callback must be function");
            }
            // Call the real local function, but intercept the callback
            if (options.stream) {
                options.stream = makeStreamProxy(options.stream);
            }
            vfs[name](path, options, function (err, meta) {
                processCallback(err, meta, callback);
            });
        };
    }
}
inherits(Worker, Agent);
