#!/bin/sh
set -eu

if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "Usage: sh deploy.sh /path/to/bundle.tar.gz" >&2
  exit 2
fi
bundle=$1
here=$(CDPATH="" cd -- "$(dirname -- "$0")" && pwd)
if [ "$(wc -c < "$bundle")" -gt 1048576 ]; then
  echo "Bundle exceeds the Kubernetes ConfigMap size limit." >&2
  exit 2
fi
checksum=$(sha256sum "$bundle" | cut -c 1-20)
name="ffyon-bundle-$checksum"

kubectl apply --dry-run=server -f "$here/namespace.yaml"
kubectl apply -f "$here/namespace.yaml"
sed "s/__FFYON_BUNDLE__/$name/" "$here/app.yaml" | kubectl apply --dry-run=server -f -

if [ -z "$(kubectl -n ffyon get secret ffyon-session --ignore-not-found -o name)" ]; then
  key=$(openssl rand -hex 32)
  printf %s "$key" | kubectl -n ffyon create secret generic ffyon-session --from-file=key=/dev/stdin
  unset key
fi
if [ -z "$(kubectl -n ffyon get configmap "$name" --ignore-not-found -o name)" ]; then
  kubectl -n ffyon create configmap "$name" --from-file="bundle.tar.gz=$bundle"
  kubectl -n ffyon patch configmap "$name" --type=merge -p '{"immutable":true}'
fi
sed "s/__FFYON_BUNDLE__/$name/" "$here/app.yaml" | kubectl apply -f -
kubectl -n ffyon rollout status deployment/ffyon --timeout=180s
kubectl -n ffyon wait certificate/ffyon-home-tls --for=condition=Ready --timeout=180s
