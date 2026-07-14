#!/bin/sh
# Derived from temporalio/samples-server. Safe to run after every deployment.
set -eu

namespace=${DEFAULT_NAMESPACE:-karmax}
address=${TEMPORAL_ADDRESS:-temporal:7233}
attempts=${TEMPORAL_HEALTH_CHECK_MAX_ATTEMPTS:-60}
attempt=1

until temporal operator cluster health --address "$address" >/dev/null 2>&1; do
  if [ "$attempt" -ge "$attempts" ]; then
    echo "Temporal did not become healthy after $attempts attempts" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 2
done

if temporal operator namespace describe -n "$namespace" --address "$address" >/dev/null 2>&1; then
  echo "Temporal namespace '$namespace' already exists."
else
  temporal operator namespace create -n "$namespace" --retention 30d --address "$address"
  echo "Temporal namespace '$namespace' created."
fi
