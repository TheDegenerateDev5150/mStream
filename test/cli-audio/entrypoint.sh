#!/bin/sh
# Starts MPD in the background, waits for the control port to be reachable,
# then hands off to the Node routing harness.
set -e

mpd --no-daemon /app/test/cli-audio/mpd.conf &
MPD_PID=$!

# Wait up to 5s for MPD's TCP port to accept connections.
for i in 1 2 3 4 5 6 7 8 9 10; do
  if node -e "const s=require('net').connect(6600,'127.0.0.1');s.once('data',()=>{process.exit(0)});s.once('error',()=>process.exit(1));setTimeout(()=>process.exit(1),400);" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

# Route the adapter through MPD's Unix socket — TCP clients are blocked from
# `file://` URIs since MPD 0.22, but socket clients are treated as local.
export MSTREAM_MPD_HOST=/tmp/mpd.sock

# Run the test; capture exit code so we can clean up MPD regardless.
node test/cli-audio/test-routing.mjs
TEST_STATUS=$?

kill $MPD_PID 2>/dev/null || true
wait $MPD_PID 2>/dev/null || true

exit $TEST_STATUS
