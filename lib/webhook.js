const pm2 = require('pm2'),
  crypto = require('crypto'),
  http = require('http'),
  _ = require('lodash'),
  exec = require('child_process').exec,
  async = require('async'),
  vizion = require('vizion');

var servers = {};
var webhooks = {};

module.exports = function() {
  pm2.connect(function() {
    pm2.list(function(err, procs) {
      processList(procs);
    });

    pm2.launchBus(function(err, bus) {
      bus.on('process:event', function(proc) {
        if (proc && proc.event == 'online' && !_.has(webhooks, proc.process.name)) {
          var env = proc.process.env_webhook;

          if (!env) return;

          var port = parseInt(env.port);

          if (port <= 1024) {
            console.log('Error! Port must be greater than 1024, you are trying to use', port);
            return;
          }

          webhooks[proc.process.name] = {
            port: port,
            path: env.path || '',
            type: env.type || 'pullAndRestart',
            secret: env.secret || '',
            pre_hook: env.pre_hook || '',
            post_hook: env.post_hook || ''
          };

          try {
            webhooks[proc.process.name] && addServer(env.port);
          } catch (error) {
            console.log('Error occurs while creating server', error);
          }

        }

        if (proc && proc.event == 'exit' && _.has(webhooks, proc.process.name)) {
          try {
            webhooks[proc.process.name] && removeServer(webhooks[proc.process.name].port);
          } catch (error) {
            console.log('Error occurs while removing server', error);
          }

          webhooks[proc.process.name] && delete webhooks[proc.process.name];
        }
      })
    });
  });
};

function processList(processes) {

  console.log('Start webhook!');
  console.log('Found', _.result(processes, "length"), 'processes');

  processes.forEach(function(proc) {
    console.log('Process', proc.name);

    if (!_.result(proc, "pm2_env", false) || !_.result(proc, "pm2_env.env_webhook", false) || !_.result(proc, "pm2_env.env_webhook.port", false)) {
      console.log('Environment problem for process', proc.name);
      return;
    }

    var env = _.result(proc, "pm2_env.env_webhook");

    var port = parseInt(env.port);

    console.log('Process port', port, 'for process', proc.name);

    if (port <= 1024) {
      console.log('Error! Port must be greater than 1024, you are trying to use', port);
      return;
    }

    if (!_.has(servers, port)) {
      try {
        addServer(port);
      } catch (error) {
        console.log('Error occurs while creating server', error);
      }
    }

    webhooks[proc.name] = {
      port: port,
      path: env.path || '/',
      type: env.type || 'pullAndRestart',
      secret: env.secret || '',
      pre_hook: env.pre_hook || '',
      post_hook: env.post_hook || ''
    };
  });
}

function processRequest(port, url, body, headers) {
  'use strict';

  for (const name of Object.keys(webhooks)) {
    var options = webhooks[name];

    if (options.port !== port) {
      continue;
    }

    if (options.path.length && options.path != url) {
      continue;
    }

    if (options.secret.length) {
      var hmac = crypto.createHmac('sha1', options.secret);
      hmac.update(body, 'utf-8');

      var xub = 'X-Hub-Signature';
      var received = headers[xub] || headers[xub.toLowerCase()];
      var expected = 'sha1=' + hmac.digest('hex');

      if (received !== expected) {
        continue;
      }
    }

    var checkOrigin = new Promise(function(resolve, reject) {
      var origin;
      console.log("WebHook received from Bitbucket");
      try {
        origin = JSON.parse(body);
        console.log('origin branch:', _.result(origin, 'push.changes[0].new.name', ''));
        origin = _.result(origin, 'push.changes[0].new.name', '');
      } catch (e) {
        console.log('Error! Check origin failed.');
        return reject(e);
      }

      pm2.describe(name, function(err, apps) {
        console.log('requete hook:', apps[0].pm2_env.versioning.branch);
        if (err || !apps || apps.length === 0) return reject(err || new Error('Application not found'));

        var reqOrigin = apps[0].pm2_env.versioning.branch;
        resolve(reqOrigin.toLowerCase() == origin.toLowerCase());
      });
    });

    checkOrigin
      .then(function(isCorrectOrigin) {
        if (isCorrectOrigin) {
          pullAndReload(name);
        } else {
          console.log('Webhook from invalid branch what (Application:', name, ')');
        }
      })
    .catch(function() {
      console.log('Something went wrong while chocking origin (Application:', name, ')');
    });
  }
}

function addServer(port) {
  console.info('Create server on port ', port);

  servers[port] = http
    .createServer(function(request, response) {
      response.writeHead(200, {
        'Content-Type': 'text/plain'
      });
      response.write('Received by'+ name);
      response.end();

      if (request.method !== 'POST') {
        return;
      }

      var body = '';
      request
        .on('data', function(data) {
          body += data;
        })
        .on('end', function() {
          processRequest(port, request.url, body, request.headers);
        });

    })
    .listen(port)
    .unref();
}

function removeServer(port) {

  if (!servers[port]) {
    return;
  }

  console.info('Remove server on port ', port);

  servers[port].close(function(err) {
    if (err) return console.error('Error occurs while removing server on port ', err);
    delete servers[port];
  });
}

function pullAndReload(name) {
  var current_app = webhooks[name];
  var cwd;

  let baseName = name.split('-');
  baseName.splice(1, 0, 'admin');
  const adminName = baseName.join('-');

  pm2.describe(name, function(err, apps) {
    if (err || !apps || apps.length === 0) return callback(err || new Error('Application not found'));
    cwd = apps[0].pm2_env.pm_cwd;
    console.log(cwd);
  });

  var execOptions = {
    cwd: cwd,
    env: process.env,
    shell: true
  };

  async.series([

    //cwd
    function(callback) {
      pm2.describe(name, function(err, apps) {
        if (err || !apps || apps.length === 0) return callback(err || new Error('Application not found'));
        cwd = apps[0].pm2_env.pm_cwd;
        console.log('[%s] Successfuly cwd %s', new Date().toISOString(), cwd);
        return callback(null);
      });
    },

    // Pull
    function(callback) {
      vizion.update({
        folder: cwd
      }, (err, data) => {
        if (err) return callback(err);
        console.log('[%s] Successfuly pulled application %s', new Date().toISOString(), name);
        return callback(null);
      });

    },

    // Pre-hook
    function(callback) {
      if (!current_app.pre_hook) return callback(null);

      exec(current_app.pre_hook, {
        cwd
      }, function(err, stdout, stderr) {
        if (err) return callback(err);

        console.log('Pre-hook command has been successfully executed for app %s', name);
        return callback(null);
      });

    },

    // Restart api
    function(callback) {
      pm2.restart(name, (err, meta) => {
        if (err) return callback(err);
        console.log('[%s] Successfuly reloaded application %s', new Date().toISOString(), name);
        return callback(null);
      });

    },

    //time out
    function(callback) {
      setTimeout(function() {
        return callback(null);
      }, 5000);
    },

    // Restart Admin-api
    function(callback) {
      pm2.restart(adminName, (err, meta) => {
        if (err) return callback(err);

        console.log('[%s] Successfuly reloaded application %s', new Date().toISOString(), name);
        return callback(null);
      });

    },

    // Post-hook
    function(callback) {
      if (!current_app.post_hook) return callback(null);
      exec(current_app.post_hook, {
        cwd
      }, function(err, stdout, stderr) {
        if (err) return callback(err);

        console.log('Pre-hook command has been successfully executed for app %s', name);
        return callback(null);
      });
    },
    //Confirm end process
    function (callback) {

      console.log('[%s] Hook Successfuly completed for application %s', new Date().toISOString(), name);
      console.log("Waiting new webhook...");
      return callback(null);

    }
  ], function(err, results) {
    if (err) {
      console.log('An error has occuring while processing app', name);
      console.log(err);
    }
  });
}
