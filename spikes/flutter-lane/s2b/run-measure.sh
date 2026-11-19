#!/usr/bin/env bash
# step 5: 5 runs each of cold / warm / warm-after-bump, for the S1b baseline, immutable HTTP caching, and the service worker.
cd "$(dirname "$0")"; E=../evidence-s2b
node check.mjs visits --server s1b --runs 5                         > $E/measure-s1b-baseline.txt 2>&1
node check.mjs visits --server s2b --mode http --runs 5 --query mirror=1 > $E/measure-s2b-http.txt 2>&1
node check.mjs visits --server s2b --mode sw   --runs 5 --query mirror=1 > $E/measure-s2b-sw.txt 2>&1
