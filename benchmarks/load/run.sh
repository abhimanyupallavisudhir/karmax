#!/usr/bin/env bash
# Load-tests a disposable copy of tavya on two fresh EC2 VMs and tears them down.
#
#   benchmarks/load/run.sh [--ref REV] [--label NAME] [--steps 4,8,16,...] [--hold SECONDS]
#                          [--rtt MS] [--sut-type c7i.xlarge] [--world-type c7i.2xlarge]
#                          [--max-minutes 180] [--out DIR] [--keep] [-- DRIVER_ARGS...]
#
# The system under test is REV (default origin/master) booted with its own
# `deploy/karmax up` on a VM sized like tavya.io (4 vCPU / 8 GB, the stack's own
# container memory caps). A second VM holds everything that is not tavya: the
# E2B stand-in with real envd sandboxes, and the synthetic tenants (driver.ts),
# which reach the system only through its public HTTPS edge. Results, logs and
# the cost land in OUT (default benchmarks/results/load-LABEL-DATE); report.ts
# turns them into report.md.
#
# Nothing touches production. Every AWS resource is tagged Project=tavya-loadtest
# and RunId=<run>; the EXIT trap terminates and deletes all of them, even after a
# failure or Ctrl-C, and each VM also powers itself off (and so terminates)
# --max-minutes after boot in case this machine disappears. Before creating
# anything it checks that the key can do nothing but EC2 in AWS_REGION. `cloud.sh sweep` removes
# anything a killed run left behind.
#
# Needs: the AWS CLI with credentials for an EC2-only IAM user (README.md),
# AWS_REGION (default eu-central-1), git, ssh, curl, python3 and Node ≥ 22.6.
set -euo pipefail
# A failed AWS call inside $(…) must stop the run, not hand back an empty id.
shopt -s inherit_errexit

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
REF=origin/master LABEL='' STEPS='' HOLD=300 RTT=50 SUT_TYPE=c7i.xlarge WORLD_TYPE=c7i.2xlarge MAX_MINUTES=180 OUT='' KEEP=0
DRIVER_ARGS=()
usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref) REF=$2; shift 2 ;;
    --label) LABEL=$2; shift 2 ;;
    --steps) STEPS=$2; shift 2 ;;
    --hold) HOLD=$2; shift 2 ;;
    --rtt) RTT=$2; shift 2 ;;
    --sut-type) SUT_TYPE=$2; shift 2 ;;
    --world-type) WORLD_TYPE=$2; shift 2 ;;
    --max-minutes) MAX_MINUTES=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --) shift; DRIVER_ARGS=("$@"); break ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; echo "run: unknown argument: $1" >&2; exit 2 ;;
  esac
done
# shellcheck source=benchmarks/load/cloud.sh
. "$HERE/cloud.sh"

die() { echo "run: $*" >&2; exit 1; }
say() { printf '\n== %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
for tool in aws git ssh scp curl python3 node openssl; do command -v "$tool" >/dev/null || die "$tool is required"; done
SHA=$(git -C "$REPO" rev-parse --verify "$REF^{commit}") || die "unknown revision $REF"
LABEL=${LABEL:-${SHA:0:8}}
RUN_ID=loadtest-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 2)
OUT=${OUT:-$REPO/benchmarks/results/load-$LABEL-$(date -u +%Y-%m-%d)}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/$RUN_ID.XXXX")
mkdir -p "$OUT/logs" "$OUT/raw"
DOMAIN=loadtest.invalid
ADMIN_EMAIL=admin@load.invalid
ADMIN_PASSWORD=admin-$(openssl rand -hex 16)
SSH_OPTS=(-i "$WORK/key" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$WORK/known_hosts"
  -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ConnectTimeout=15 -o LogLevel=ERROR)
SUT='' WORLD='' SUT_PRIVATE='' WORLD_PRIVATE='' SG='' FETCHED=0
on() { local host=$1; shift; ensure_access; ssh "${SSH_OPTS[@]}" "ubuntu@$host" "$@"; }
put() { local host=$1; shift; ensure_access; scp -q "${SSH_OPTS[@]}" "$@" "ubuntu@$host:"; }
get() { ensure_access; scp -q "${SSH_OPTS[@]}" "ubuntu@$1:$2" "$3"; }

# This machine's address can change during a long run (NAT pools); SSH is
# allowed from each address it has had.
AUTHORIZED=' '
ensure_access() {
  [ -n "$SG" ] || return 0
  local ip
  ip=$(curl -fsS --max-time 10 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]') || return 0
  case "$AUTHORIZED" in *" $ip "*) return 0 ;; esac
  aws_ ec2 authorize-security-group-ingress --group-id "$SG" \
    --ip-permissions "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$ip/32,Description=operator}]" >/dev/null 2>&1 || true
  AUTHORIZED="$AUTHORIZED$ip "
}

fetch_results() {
  [ "$FETCHED" -eq 0 ] || return 0
  FETCHED=1
  say 'Collecting results'
  if [ -n "$WORLD" ]; then
    on "$WORLD" 'sudo journalctl -u loadtest-driver --no-pager -o cat > /tmp/driver.log 2>&1; cd /opt/loadtest && tar czf /tmp/driver-out.tgz out 2>/dev/null; docker logs karmax-rehearsal-e2b 2>&1 | gzip > /tmp/fake-e2b.log.gz; docker ps -a --filter label=karmax.rehearsal.sandbox --format "{{.State}}" | sort | uniq -c > /tmp/sandboxes.txt' || true
    get "$WORLD" /tmp/driver.log "$OUT/logs/driver.log" || true
    get "$WORLD" /tmp/fake-e2b.log.gz "$OUT/raw/fake-e2b.log.gz" || true
    get "$WORLD" /tmp/sandboxes.txt "$OUT/logs/sandboxes-at-end.txt" || true
    get "$WORLD" /tmp/driver-out.tgz "$WORK/driver-out.tgz" && tar xzf "$WORK/driver-out.tgz" -C "$WORK" && cp "$WORK"/out/* "$OUT/" || true
  fi
  if [ -n "$SUT" ]; then
    on "$SUT" 'sudo systemctl stop loadtest-collector 2>/dev/null; cd /opt/loadtest && gzip -c samples.jsonl > /tmp/samples.jsonl.gz; tar czf /tmp/probe.tgz -C /opt/loadtest probe; docker logs karmax-app-1 2>&1 | gzip > /tmp/app.log.gz; docker logs karmax-temporal-1 2>&1 | tail -n 5000 | gzip > /tmp/temporal.log.gz; docker logs karmax-caddy-1 2>&1 | tail -n 2000 | gzip > /tmp/caddy.log.gz; docker ps -a > /tmp/containers.txt; docker inspect karmax-app-1 --format "{{json .State}} restarts={{.RestartCount}}" >> /tmp/containers.txt; sudo dmesg -T | grep -iE "out of memory|oom|killed process" > /tmp/oom.txt || true' || true
    get "$SUT" /tmp/samples.jsonl.gz "$OUT/raw/samples.jsonl.gz" || true
    get "$SUT" /tmp/probe.tgz "$OUT/raw/probe.tgz" || true
    get "$SUT" /tmp/app.log.gz "$OUT/raw/app.log.gz" || true
    get "$SUT" /tmp/temporal.log.gz "$OUT/raw/temporal.log.gz" || true
    get "$SUT" /tmp/caddy.log.gz "$OUT/raw/caddy.log.gz" || true
    get "$SUT" /tmp/containers.txt "$OUT/logs/containers-at-end.txt" || true
    get "$SUT" /tmp/oom.txt "$OUT/logs/kernel-oom.txt" || true
  fi
}

cleanup() {
  local status=$?
  set +e
  trap - EXIT INT TERM
  fetch_results
  if [ "$KEEP" -eq 1 ]; then
    say "Kept the VMs (--keep). Remove them with: benchmarks/load/cloud.sh sweep $RUN_ID"
    echo "ssh -i $WORK/key ubuntu@$SUT   # system under test"
    echo "ssh -i $WORK/key ubuntu@$WORLD # world + load generator"
  else
    say "Terminating every resource of $RUN_ID"
    sweep "$RUN_ID" || { sleep 30; sweep "$RUN_ID"; } || echo "run: CLEANUP INCOMPLETE — run: benchmarks/load/cloud.sh sweep $RUN_ID" >&2
    # The proof, by describe calls: nothing tagged for the load test remains.
    leftovers | tee "$OUT/logs/leftovers.txt" || echo "run: RESOURCES REMAIN — run: benchmarks/load/cloud.sh sweep" >&2
  fi
  if [ -s "$WORK/instances.jsonl" ]; then
    cost "$WORK/instances.jsonl" "$(date +%s)" > "$OUT/cost.json" && say "Cost: \$$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["totalUsd"])' "$OUT/cost.json")"
  fi
  if [ -s "$OUT/steps.jsonl" ]; then
    node --experimental-strip-types --no-warnings "$HERE/report.ts" "$OUT" || echo 'run: the report failed; the raw data is kept' >&2
  fi
  echo "results: $OUT"
  [ "$KEEP" -eq 1 ] || rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

cat > "$OUT/run.json" <<EOF
{"runId": "$RUN_ID", "ref": "$REF", "sha": "$SHA", "label": "$LABEL", "region": "$AWS_REGION",
 "sutType": "$SUT_TYPE", "worldType": "$WORLD_TYPE", "worldRttMs": $RTT, "holdSeconds": $HOLD,
 "maxMinutes": $MAX_MINUTES, "steps": "${STEPS:-default}", "driverArgs": "${DRIVER_ARGS[*]:-}", "startedAt": "$(date -u +%FT%TZ)"}
EOF
say "Run $RUN_ID: $REF ($SHA) in $AWS_REGION; results in $OUT"

# ---------------------------------------------------------------- provision
say "Checking that the key can do nothing but EC2 in $AWS_REGION"
verify_scope | tee "$OUT/logs/key-scope.log" || die 'the AWS key is broader than EC2 in one region (or cannot launch); refusing to run'
say 'Network, key and image'
VPC=$(aws_ ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId')
[ -n "$VPC" ] && [ "$VPC" != None ] || die "no default VPC in $AWS_REGION"
SUBNET=$(aws_ ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC" Name=default-for-az,Values=true \
  --query 'sort_by(Subnets,&AvailabilityZone)[0].SubnetId')
SG=$(aws_ ec2 create-security-group --group-name "$RUN_ID" --description "tavya load test $RUN_ID (disposable)" --vpc-id "$VPC" \
  --tag-specifications "$(tag_spec security-group "$RUN_ID" "$RUN_ID")" --query GroupId)
aws_ ec2 authorize-security-group-ingress --group-id "$SG" \
  --ip-permissions "IpProtocol=-1,UserIdGroupPairs=[{GroupId=$SG,Description=between the two VMs}]" >/dev/null
ensure_access
ssh-keygen -q -t ed25519 -N '' -C "$RUN_ID" -f "$WORK/key"
aws_ ec2 import-key-pair --key-name "$RUN_ID" --public-key-material "fileb://$WORK/key.pub" \
  --tag-specifications "$(tag_spec key-pair "$RUN_ID" "$RUN_ID")" >/dev/null
AMI=$(aws_ ec2 describe-images --owners 099720109477 \
  --filters 'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*' Name=state,Values=available \
  --query 'sort_by(Images,&CreationDate)[-1].ImageId')
# The dead man's switch: power off (= terminate) MAX_MINUTES after boot, whatever happens here.
printf '#!/bin/bash\nshutdown -h +%d "tavya load test: time limit"\n' "$MAX_MINUTES" > "$WORK/user-data"

launch() { # launch ROLE TYPE DISK_GB -> instance id
  local id
  id=$(aws_ ec2 run-instances --image-id "$AMI" --instance-type "$2" --key-name "$RUN_ID" \
    --security-group-ids "$SG" --subnet-id "$SUBNET" --instance-initiated-shutdown-behavior terminate \
    --user-data "file://$WORK/user-data" --metadata-options HttpTokens=required \
    --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$3,VolumeType=gp3,DeleteOnTermination=true}" \
    --tag-specifications "$(tag_spec instance "$RUN_ID" "$RUN_ID-$1")" "$(tag_spec volume "$RUN_ID" "$RUN_ID-$1")" \
    --query 'Instances[0].InstanceId')
  [ -n "$id" ] && [ "$id" != None ] || die "could not launch the $1 VM ($2)"
  printf '{"id":"%s","role":"%s","type":"%s","diskGb":%d,"launched":%d}\n' "$id" "$1" "$2" "$3" "$(date +%s)" >> "$WORK/instances.jsonl"
  echo "$id"
}
say "Launching $SUT_TYPE (system under test) and $WORLD_TYPE (worlds + load generator)"
SUT_ID=$(launch sut "$SUT_TYPE" 40)
WORLD_ID=$(launch world "$WORLD_TYPE" 80)
cp "$WORK/instances.jsonl" "$OUT/instances.jsonl"
aws_ ec2 wait instance-running --instance-ids "$SUT_ID" "$WORLD_ID"
address() { aws_ ec2 describe-instances --instance-ids "$1" --query "Reservations[0].Instances[0].$2"; }
SUT=$(address "$SUT_ID" PublicIpAddress) SUT_PRIVATE=$(address "$SUT_ID" PrivateIpAddress)
WORLD=$(address "$WORLD_ID" PublicIpAddress) WORLD_PRIVATE=$(address "$WORLD_ID" PrivateIpAddress)
echo "system under test $SUT_ID $SUT ($SUT_PRIVATE); world $WORLD_ID $WORLD ($WORLD_PRIVATE)"
for host in "$SUT" "$WORLD"; do
  for attempt in $(seq 1 40); do on "$host" true 2>/dev/null && break; [ "$attempt" -lt 40 ] || die "no SSH to $host"; sleep 5; done
done

# ---------------------------------------------------------------- install
say 'Shipping the revision under test and the harness'
echo "$SHA" > "$WORK/REVISION"
git -C "$REPO" archive --format=tar.gz --add-file="$WORK/REVISION" -o "$WORK/source.tar.gz" "$SHA"
# The harness comes from this checkout, so an older revision is measured the same way.
tar czf "$WORK/harness.tar.gz" -C "$REPO" benchmarks/load scripts/rehearsal
put "$SUT" "$WORK/source.tar.gz" "$WORK/harness.tar.gz"
put "$WORLD" "$WORK/harness.tar.gz"
on "$SUT" 'mkdir -p h && tar xzf harness.tar.gz -C h'
on "$WORLD" 'mkdir -p h && tar xzf harness.tar.gz -C h'

say 'Booting the system under test (deploy/karmax up) and preparing the world VM'
on "$WORLD" 'h/benchmarks/load/install-tools.sh && docker build -q -t karmax-rehearsal-sandbox -f h/scripts/rehearsal/sandbox.Dockerfile h/scripts/rehearsal' \
  > "$OUT/logs/world-prepare.log" 2>&1 &
prepare=$!
on "$SUT" "h/benchmarks/load/sut-setup.sh ~/source.tar.gz ~/h/benchmarks/load $DOMAIN $WORLD_PRIVATE $ADMIN_EMAIL $ADMIN_PASSWORD" \
  > "$OUT/logs/sut-setup.log" 2>&1 || { tail -n 40 "$OUT/logs/sut-setup.log"; die 'the system under test did not boot'; }
wait "$prepare" || { tail -n 20 "$OUT/logs/world-prepare.log"; die 'the world VM could not be prepared'; }
tail -n 3 "$OUT/logs/sut-setup.log"
get "$SUT" /opt/loadtest/edge.crt "$WORK/edge.crt"
put "$WORLD" "$WORK/edge.crt"
on "$WORLD" "h/benchmarks/load/world-setup.sh ~/h/benchmarks/load ~/h/scripts/rehearsal $SUT_PRIVATE $DOMAIN ~/edge.crt $RTT" \
  > "$OUT/logs/world-setup.log" 2>&1 || { tail -n 30 "$OUT/logs/world-setup.log"; die 'the world VM did not come up'; }
tail -n 3 "$OUT/logs/world-setup.log"

# ---------------------------------------------------------------- drive
say 'Driving synthetic tenants'
driver=(/opt/node/bin/node --max-old-space-size=6144 --experimental-strip-types --no-warnings /opt/loadtest/driver.ts
  --base "https://$DOMAIN" --admin-email "$ADMIN_EMAIL" --out /opt/loadtest/out
  --hold "$HOLD" ${STEPS:+--steps "$STEPS"} "${DRIVER_ARGS[@]}")
on "$WORLD" "sudo systemd-run --unit loadtest-driver --uid ubuntu --gid ubuntu --working-directory /opt/loadtest \
  -p LimitNOFILE=1048576 -E NODE_EXTRA_CA_CERTS=/opt/loadtest/edge.crt -E LOADTEST_ADMIN_PASSWORD=$ADMIN_PASSWORD $(printf '%q ' "${driver[@]}")"
# Stop driving 25 minutes before the VMs power themselves off, to collect results.
deadline=$(( $(python3 -c 'import json,sys; print(min(json.loads(l)["launched"] for l in open(sys.argv[1])))' "$WORK/instances.jsonl") + MAX_MINUTES * 60 - 1500 ))
while :; do
  sleep 60
  state=$(on "$WORLD" 'systemctl is-active loadtest-driver' 2>/dev/null || true)
  progress=$(on "$WORLD" 'sudo journalctl -u loadtest-driver --no-pager -o cat -n 400' 2>/dev/null | grep -E 'step [0-9]+ done|BROKEN|setup failed' | tail -n 1 || true)
  [ -z "$progress" ] || [ "$progress" = "${last_progress:-}" ] || echo "$progress"
  last_progress=$progress
  case "$state" in active|activating|reloading) ;; *) break ;; esac
  if [ "$(date +%s)" -gt "$deadline" ]; then
    echo 'run: the time limit is near; stopping the driver'
    on "$WORLD" 'sudo systemctl kill -s INT loadtest-driver' || true
    sleep 20
    break
  fi
done
say 'Driver finished'
on "$WORLD" 'sudo journalctl -u loadtest-driver --no-pager -o cat | tail -n 30' || true
fetch_results
