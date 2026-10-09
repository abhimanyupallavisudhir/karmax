#!/usr/bin/env bash
# AWS EC2 helpers for the load test, sourced by run.sh and runnable alone:
#
#   benchmarks/load/cloud.sh sweep [RUN_ID]   terminate and delete everything the
#                                             load test created (one run, or all)
#   benchmarks/load/cloud.sh list             what exists now, by run
#   benchmarks/load/cloud.sh verify-scope     prove the key is EC2-only in AWS_REGION
#
# Every resource carries Project=tavya-loadtest and RunId=<run>; that tag is
# the only thing cleanup trusts. Needs the AWS CLI and AWS_* credentials for an
# IAM user limited to EC2 in AWS_REGION on resources tagged Project=tavya-loadtest
# (iam-policy.json).
set -euo pipefail
: "${AWS_REGION:=eu-central-1}"
export AWS_REGION AWS_DEFAULT_REGION=$AWS_REGION AWS_PAGER=''
PROJECT_TAG=tavya-loadtest
# On-demand list prices in eu-central-1, checked 2026-10-08 (USD).
declare -A HOURLY=([c7i.large]=0.10185 [c7i.xlarge]=0.2037 [c7i.2xlarge]=0.4074 [m7i.xlarge]=0.2304 [m7i.2xlarge]=0.4608)
GP3_GB_MONTH=0.0952
PUBLIC_IPV4_HOUR=0.005

aws_() { aws --region "$AWS_REGION" --output text "$@"; }

tag_spec() { # tag_spec RESOURCE_TYPE RUN_ID NAME
  printf 'ResourceType=%s,Tags=[{Key=Project,Value=%s},{Key=RunId,Value=%s},{Key=Name,Value=%s}]' "$1" "$PROJECT_TAG" "$2" "$3"
}

run_filter() { # run_filter [RUN_ID]
  if [ -n "${1:-}" ]; then echo "Name=tag:RunId,Values=$1"; else echo "Name=tag:Project,Values=$PROJECT_TAG"; fi
}

instances_of() { # instances_of [RUN_ID] -> ids not yet terminated
  aws_ ec2 describe-instances --filters "$(run_filter "${1:-}")" \
    Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down \
    --query 'Reservations[].Instances[].InstanceId'
}

# Terminates the run's instances, waits for them, then deletes its volumes,
# key pairs and security groups. Safe to repeat; never touches untagged things.
sweep() { # sweep [RUN_ID]
  local run=${1:-} ids id groups keys volumes attempt
  ids=$(instances_of "$run")
  if [ -n "$ids" ]; then
    echo "cloud: terminating $ids"
    # shellcheck disable=SC2086
    aws_ ec2 terminate-instances --instance-ids $ids >/dev/null
    # shellcheck disable=SC2086
    aws_ ec2 wait instance-terminated --instance-ids $ids || echo 'cloud: warning: termination wait timed out; retry the sweep'
  fi
  volumes=$(aws_ ec2 describe-volumes --filters "$(run_filter "$run")" Name=status,Values=available --query 'Volumes[].VolumeId')
  for id in $volumes; do echo "cloud: deleting volume $id"; aws_ ec2 delete-volume --volume-id "$id" || true; done
  keys=$(aws_ ec2 describe-key-pairs --filters "$(run_filter "$run")" --query 'KeyPairs[].KeyPairId')
  for id in $keys; do echo "cloud: deleting key pair $id"; aws_ ec2 delete-key-pair --key-pair-id "$id" || true; done
  groups=$(aws_ ec2 describe-security-groups --filters "$(run_filter "$run")" --query 'SecurityGroups[].GroupId')
  for id in $groups; do
    # A group stays in use until its instances' interfaces are gone.
    for attempt in $(seq 1 30); do
      aws_ ec2 delete-security-group --group-id "$id" 2>/dev/null && { echo "cloud: deleted security group $id"; break; }
      [ "$attempt" -lt 30 ] || echo "cloud: warning: security group $id is still in use"
      sleep 10
    done
  done
  local left
  left=$(instances_of "$run")
  [ -z "$left" ] || { echo "cloud: ERROR: instances still alive: $left" >&2; return 1; }
}

# Probes what the key may do, since a scoped user may not read its own IAM
# policy (iam-policy.json): a tagged dry-run launch in AWS_REGION must be
# authorized, while an untagged one, EC2 in another region, IAM, S3 and Lambda
# must all be refused. The untagged refusal is what shows the key cannot touch
# anything in a shared account that the load test did not create.
verify_scope() {
  local failed=0 out
  probe() { # probe EXPECT(allowed|denied) NAME COMMAND...
    local expect=$1 name=$2; shift 2
    out=$("$@" 2>&1) && status=allowed || status=denied
    # A dry run that would have succeeded reports DryRunOperation as an error.
    case "$out" in *DryRunOperation*) status=allowed ;; *UnauthorizedOperation*|*AccessDenied*|*not\ authorized*|*InvalidClientTokenId*) status=denied ;; esac
    if [ "$status" = "$expect" ]; then echo "ok    $name: $status"
    else echo "FAIL  $name: $status, expected $expect: $(echo "$out" | head -c 200)"; failed=1; fi
  }
  aws sts get-caller-identity --query Arn --output text | sed 's/^/key   /'
  probe allowed "describe instances in $AWS_REGION" aws_ ec2 describe-instances --max-items 1
  local image
  image=$(aws_ ec2 describe-images --owners 099720109477 --filters 'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*' \
    --query 'sort_by(Images,&CreationDate)[-1].ImageId' 2>/dev/null || echo ami-00000000)
  probe allowed "tagged dry-run launch in $AWS_REGION" aws_ ec2 run-instances --dry-run --image-id "$image" --instance-type c7i.large \
    --tag-specifications "$(tag_spec instance scope-check scope-check)" "$(tag_spec volume scope-check scope-check)"
  probe denied "untagged dry-run launch in $AWS_REGION" aws_ ec2 run-instances --dry-run --image-id "$image" --instance-type c7i.large
  local other=eu-west-1; [ "$AWS_REGION" != eu-west-1 ] || other=eu-central-1
  probe denied "EC2 in $other" aws --region "$other" ec2 describe-instances --max-items 1
  probe denied 'IAM' aws iam list-users --max-items 1
  probe denied 'S3' aws s3api list-buckets
  probe denied 'Lambda' aws --region "$AWS_REGION" lambda list-functions --max-items 1
  return "$failed"
}

# What still exists with the load test's tag, by describe calls, across all
# runs: live instances, volumes, security groups, key pairs. Fails if any.
leftovers() {
  local instances volumes groups keys
  instances=$(instances_of)
  volumes=$(aws_ ec2 describe-volumes --filters "$(run_filter)" --query 'Volumes[].VolumeId')
  groups=$(aws_ ec2 describe-security-groups --filters "$(run_filter)" --query 'SecurityGroups[].GroupId')
  keys=$(aws_ ec2 describe-key-pairs --filters "$(run_filter)" --query 'KeyPairs[].KeyPairId')
  echo "Project=$PROJECT_TAG in $AWS_REGION at $(date -u +%FT%TZ): instances [${instances}] volumes [${volumes}] security groups [${groups}] key pairs [${keys}]"
  [ -z "$instances$volumes$groups$keys" ]
}

list() {
  aws_ ec2 describe-instances --filters "$(run_filter)" \
    --query 'Reservations[].Instances[].[Tags[?Key==`RunId`]|[0].Value,InstanceId,InstanceType,State.Name,LaunchTime]'
  aws_ ec2 describe-security-groups --filters "$(run_filter)" --query 'SecurityGroups[].[Tags[?Key==`RunId`]|[0].Value,GroupId]'
  aws_ ec2 describe-key-pairs --filters "$(run_filter)" --query 'KeyPairs[].[Tags[?Key==`RunId`]|[0].Value,KeyPairId]'
}

# The run's cost at list prices (compute, gp3 storage, public IPv4) from the
# instances run.sh recorded at launch (one JSON object per line: id, type,
# diskGb, launched epoch) to ENDED (epoch). Prints JSON.
cost() { # cost INSTANCES_JSONL ENDED_EPOCH
  python3 - "$1" "$2" "$GP3_GB_MONTH" "$PUBLIC_IPV4_HOUR" "$(for k in "${!HOURLY[@]}"; do printf '%s=%s ' "$k" "${HOURLY[$k]}"; done)" <<'PY'
import json, sys
instances = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
ended, gb_month, ipv4 = float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
hourly = dict(kv.split('=') for kv in sys.argv[5].split())
lines, total = [], 0.0
for i in instances:
    hours = max(0.0, ended - float(i['launched'])) / 3600
    compute = hours * float(hourly.get(i['type'], 'nan'))
    storage = i['diskGb'] * gb_month * hours / 730
    address = hours * ipv4
    lines.append({'instance': i['id'], 'role': i.get('role'), 'type': i['type'], 'hours': round(hours, 3), 'diskGb': i['diskGb'],
                  'computeUsd': round(compute, 3), 'storageUsd': round(storage, 4), 'ipv4Usd': round(address, 4)})
    total += compute + storage + address
print(json.dumps({'instances': lines, 'totalUsd': round(total, 2),
                  'prices': 'eu-central-1 on-demand list prices checked 2026-10-08; data transfer inside one AZ is free'}, indent=1))
PY
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    sweep) sweep "${2:-}" ;;
    list) list ;;
    leftovers) leftovers ;;
    verify-scope) verify_scope ;;
    cost) cost "$2" "${3:-$(date +%s)}" ;;
    *) echo 'usage: cloud.sh sweep [RUN_ID] | list | leftovers | verify-scope | cost INSTANCES_JSONL [ENDED_EPOCH]' >&2; exit 2 ;;
  esac
fi
