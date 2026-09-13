#!/bin/zsh
# Logs the frontmost app's bundle id with a millisecond timestamp whenever it changes.
last=""
while true; do
  front=$(lsappinfo info -only bundleid "$(lsappinfo front)" 2>/dev/null | sed 's/.*="\(.*\)"/\1/')
  if [[ "$front" != "$last" ]]; then
    echo "$(python3 -c 'import time; print(int(time.time()*1000))') $front"
    last=$front
  fi
  sleep 0.02
done
