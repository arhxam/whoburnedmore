#!/usr/bin/env node

// check-launch.sh uses this to prove watch shutdown owns and terminates an
// in-flight parser instead of relying on a timing-sensitive real usage scan.
setTimeout(() => {
  process.stdout.write('{"daily":[]}');
}, 60_000);
