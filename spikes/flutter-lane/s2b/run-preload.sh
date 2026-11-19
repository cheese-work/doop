#!/usr/bin/env bash
# step 3: time from "the Flutter frame opens" to its first frame, when it opens 0 s, 5 s, 15 s after the page. 3 runs per cell.
# preload 0 = start everything at frame open, 1 = worker + pub get + toolkit fetch at page open, 2 = also a hidden connected sandbox.
cd "$(dirname "$0")"; E=../evidence-s2b
for L in 0 1 2; do
  node check.mjs preload --server s2b --mode sw --level $L --delays 0,5000,15000 --runs 3 --query mirror=1 > $E/preload-cold-L$L.txt 2>&1
done
for L in 0 2; do
  node check.mjs preload --server s2b --mode sw --level $L --delays 0,5000,15000 --runs 3 --warm 1 --query mirror=1 > $E/preload-warm-L$L.txt 2>&1
done
